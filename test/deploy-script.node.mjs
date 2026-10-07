import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createMissingGeneratedSecrets,
  deploymentIdFromVersion,
  deploymentVersionIds,
  missingRequiredSecrets,
  parseSecretList,
  requiredUserSecrets,
  resolveDeploymentId,
} from "../scripts/deploy-lib.mjs";
import {
  listProfiles,
  mergeWranglerConfig,
  resolveWranglerConfig,
  takeProfileArgument,
} from "../scripts/wrangler-config.mjs";

const deterministicRandom = (length) => Buffer.alloc(length, 0xab);

test("reads the newest deployment regardless of list order, including split traffic", () => {
  const old = { created_on: "2026-09-01T00:00:00Z", versions: [{ version_id: "old" }] };
  const current = { created_on: "2026-10-01T00:00:00Z", versions: [{ version_id: "a" }, { version_id: "b" }] };
  for (const deployments of [[old, current], [current, old]]) {
    assert.deepEqual(deploymentVersionIds(JSON.stringify(deployments)), ["a", "b"]);
  }
  assert.deepEqual(deploymentVersionIds("[]"), []);
  for (const invalid of ["{}", "[{}]", JSON.stringify([{ ...current, versions: [] }])]) {
    assert.throws(() => deploymentVersionIds(invalid), /Unexpected Wrangler/u);
  }
});

test("only accepts readable public deployment bindings", () => {
  const output = (bindings) => JSON.stringify({ resources: { bindings } });
  assert.equal(deploymentIdFromVersion(output([])), undefined);
  assert.equal(deploymentIdFromVersion(output([{ name: "DEPLOYMENT_ID", type: "plain_text", text: "" }])), undefined);
  assert.equal(deploymentIdFromVersion(output([{ name: "DEPLOYMENT_ID", type: "plain_text", text: "stable-identity" }])), "stable-identity");
  assert.throws(() => deploymentIdFromVersion("{}"), /Unexpected Wrangler/u);
  assert.throws(() => deploymentIdFromVersion(output([{ name: "DEPLOYMENT_ID", type: "secret_text" }])), /plain-text/u);
});

test("keeps deployed identities, supports explicit initial values, and rejects conflicts", () => {
  const failGenerate = () => assert.fail("must not generate another identity");
  assert.equal(resolveDeploymentId(["deployed-identity"], undefined, "local-identity", failGenerate), "deployed-identity");
  assert.equal(resolveDeploymentId([], "configured-identity", "local-identity", failGenerate), "configured-identity");
  assert.equal(resolveDeploymentId([], undefined, "local-identity", failGenerate), "local-identity");
  assert.equal(resolveDeploymentId(["deployed-identity", "deployed-identity"], "deployed-identity", undefined, failGenerate), "deployed-identity");
  assert.throws(() => resolveDeploymentId(["deployed-identity"], "different-identity"), /differs/u);
  assert.throws(() => resolveDeploymentId(["deployed-identity", undefined]), /disagree/u);
  assert.throws(() => resolveDeploymentId(["deployed-identity", "other-identity"]), /disagree/u);
  assert.throws(() => resolveDeploymentId(["invalid!"]), /Invalid DEPLOYMENT_ID/u);
});

function isolatedCheckout(directory, profile) {
  mkdirSync(join(directory, "scripts"), { recursive: true });
  for (const name of ["deploy.mjs", "deploy-lib.mjs", "wrangler-config.mjs"]) copyFileSync(new URL(`../scripts/${name}`, import.meta.url), join(directory, "scripts", name));
  writeFileSync(join(directory, "scripts/seamless-root.mjs"), `import { spawnSync } from 'node:child_process';
export async function deployCheckout(input) {
  const provisioned = await input.prepare();
  if (!provisioned) {
    const args = ['deploy', ...(input.configPath.endsWith('wrangler.jsonc') ? [] : ['--config', input.configPath]), '--var', 'DEPLOYMENT_ID:' + input.deploymentId];
    const result = spawnSync(process.env.APP_AI_GATEWAY_WRANGLER_BIN, args, { stdio: 'inherit' });
    if (result.status !== 0) throw new Error('Deployment fixture failed');
  }
}`);
  copyFileSync(new URL('../wrangler.jsonc', import.meta.url), join(directory, 'wrangler.jsonc'));
  if (profile) {
    copyFileSync(new URL(`../wrangler.${profile}.overlay.jsonc`, import.meta.url), join(directory, `wrangler.${profile}.overlay.jsonc`));
    try { copyFileSync(new URL(`../.dev.vars.${profile}`, import.meta.url), join(directory, `.dev.vars.${profile}`)); } catch {}
  }
  symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(directory, 'node_modules'), 'dir');
  return directory;
}

// An isolated checkout and persistent fake Cloudflare state exercise separate
// build processes without depending on this checkout's local credentials.
function identityDeploymentFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "agw-deployment-identity-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  isolatedCheckout(directory);
  writeFileSync(join(directory, "wrangler.jsonc"), JSON.stringify({ name: "fixture-worker" }));
  const fakeWrangler = join(directory, "wrangler.mjs");
  const callLog = join(directory, "calls.ndjson");
  const statePath = join(directory, "state.json");
  writeFileSync(fakeWrangler, `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_WRANGLER_LOG, JSON.stringify(args) + "\\n");
const statePath = process.env.FAKE_STATE;
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null;
if (args[0] === "deployments") {
  if (process.env.FAKE_FAILURE === "lookup") { console.error("Authentication failed [code: 10000]"); process.exit(1); }
  if (process.env.FAKE_FAILURE === "malformed") { console.log("{}"); process.exit(0); }
  if (!state) { console.error("Worker not found [code: 10007]"); process.exit(1); }
  console.log(JSON.stringify([{ created_on: "2026-10-01T00:00:00Z", versions: [{ version_id: "active-version" }] }]));
}
if (args[0] === "versions") {
  if (process.env.FAKE_FAILURE === "version") { console.error("Network failure"); process.exit(1); }
  console.log(JSON.stringify({ resources: { bindings: state.id === undefined ? [] : [{ name: "DEPLOYMENT_ID", type: "plain_text", text: state.id }] } }));
}
if (args[0] === "secret" && args[1] === "list") {
  console.log(JSON.stringify(["SECRET_VAULT_LOCAL_KEK_V1", "JWT_SECRET", "BETTER_AUTH_SECRET"].map(name => ({ name }))));
}
if (args[0] === "deploy") {
  writeFileSync(statePath, JSON.stringify({ id: args[args.indexOf("--var") + 1].slice("DEPLOYMENT_ID:".length) }));
}
`, { mode: 0o700 });
  return {
    statePath,
    callLog,
    run(extraEnv = {}) {
      return spawnSync(process.execPath, ["scripts/deploy.mjs"], {
        cwd: directory, encoding: "utf8",
        env: { ...process.env, DEPLOYMENT_ID: "", APP_AI_GATEWAY_WRANGLER_BIN: fakeWrangler,
          FAKE_WRANGLER_LOG: callLog, FAKE_STATE: statePath, FAKE_FAILURE: "", ...extraEnv },
      });
    },
  };
}

test("one-click deployment generates a UUID and reuses it in a later build", (t) => {
  const fixture = identityDeploymentFixture(t);
  const first = fixture.run();
  assert.equal(first.status, 0, first.stderr);
  const firstId = JSON.parse(readFileSync(fixture.statePath, "utf8")).id;
  assert.match(firstId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  const second = fixture.run();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(readFileSync(fixture.statePath, "utf8")).id, firstId);
});

for (const failure of ["lookup", "version", "malformed", "conflict"]) {
  test(`identity ${failure} stops deployment before any writes`, (t) => {
    const fixture = identityDeploymentFixture(t);
    writeFileSync(fixture.statePath, JSON.stringify({ id: "deployed-identity" }));
    const result = fixture.run({ FAKE_FAILURE: failure, ...(failure === "conflict" ? { DEPLOYMENT_ID: "different-identity" } : {}) });
    assert.notEqual(result.status, 0);
    const calls = readFileSync(fixture.callLog, "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(calls.every(args => ["deployments", "versions"].includes(args[0])));
    assert.equal(JSON.parse(readFileSync(fixture.statePath, "utf8")).id, "deployed-identity");
  });
}

test("parses Wrangler's JSON secret list", () => {
  const names = parseSecretList(
    JSON.stringify([
      { name: "BETTER_AUTH_SECRET", type: "secret_text" },
      { name: "JWT_SECRET", type: "secret_text" },
    ]),
  );
  assert.deepEqual([...names], ["BETTER_AUTH_SECRET", "JWT_SECRET"]);
});

test("reports missing user-provided deployment values", () => {
  assert.deepEqual(missingRequiredSecrets(new Set()), ["SECRET_VAULT_LOCAL_KEK_V1"]);
  assert.deepEqual(missingRequiredSecrets(new Set(["SECRET_VAULT_LOCAL_KEK_V1"])), []);
});

test("deploy button masks the vault key and shows every setting in clear text", () => {
  const projectRoot = new URL("..", import.meta.url);
  const packageJson = JSON.parse(readFileSync(new URL("package.json", projectRoot), "utf8"));
  const wranglerConfig = JSON.parse(
    readFileSync(new URL("wrangler.jsonc", projectRoot), "utf8")
      .replace(/^\s*\/\/.*$/gmu, ""),
  );
  const secretTemplate = readFileSync(new URL(".dev.vars.example", projectRoot), "utf8");

  // The deployment-wide Cloudflare AI Gateway credentials are gone: routing
  // through one is now an optional per-organization choice, not a prerequisite.
  assert.equal(secretTemplate.includes("CF_AIG"), false);
  assert.equal(JSON.stringify(packageJson).includes("CF_AIG"), false);
  assert.equal(JSON.stringify(wranglerConfig).includes("CF_AIG"), false);
  assert.equal(JSON.stringify(wranglerConfig).includes('"AI"'), false);
  assert.match(packageJson.cloudflare.bindings.SECRET_VAULT_LOCAL_KEK_V1.description, /openssl rand -base64 32/u);

  // The form masks every uncommented name in the secret template and shows
  // every `vars` entry as editable text pre-filled with its value. A setting in
  // both would be asked for twice, once behind asterisks, so the key is the
  // only name here and each setting is a var carrying the default it runs on.
  const askedSecrets = secretTemplate
    .split("\n")
    .filter((line) => /^[A-Z0-9_]+=/u.test(line.trim()))
    .map((line) => line.trim().split("=")[0]);
  assert.deepEqual(askedSecrets, ["SECRET_VAULT_LOCAL_KEK_V1"]);
  assert.deepEqual(wranglerConfig.vars, {
    SECRET_VAULT_MODE: "local",
    SECRET_VAULT_LOCAL_KEK_CURRENT_VERSION: "1",
    ALLOWED_REGISTRATION_EMAILS: "",
  });

  // Both halves of the form carry an explanation, and nothing in it is blank.
  for (const name of [...askedSecrets, ...Object.keys(wranglerConfig.vars)]) {
    assert.ok(packageJson.cloudflare.bindings[name]?.description, `${name} has no description`);
  }
  assert.deepEqual(
    Object.keys(packageJson.cloudflare.bindings).filter(
      (name) => !askedSecrets.includes(name) && !(name in wranglerConfig.vars),
    ),
    [],
  );
});

test("generates internal signing secrets once and leaves existing values alone", () => {
  const first = createMissingGeneratedSecrets(new Set(), deterministicRandom);
  assert.equal(Buffer.from(first.JWT_SECRET, "base64url").byteLength, 48);
  assert.equal(Buffer.from(first.BETTER_AUTH_SECRET, "base64url").byteLength, 48);

  const second = createMissingGeneratedSecrets(
    new Set(["JWT_SECRET", "BETTER_AUTH_SECRET"]),
    deterministicRandom,
  );
  assert.deepEqual(second, {});
});

test("deployment uploads generated signing secrets and provisions D1 before migrations", () => {
  const directory = mkdtempSync(join(tmpdir(), "app-ai-gateway-deploy-test-"));
  const fakeWrangler = join(directory, "wrangler.mjs");
  const callLog = join(directory, "calls.ndjson");
  writeFileSync(
    fakeWrangler,
    `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const entry = { args };
if (args[0] === "secret" && args[1] === "bulk") entry.input = readFileSync(0, "utf8");
const previous = existsSync(process.env.FAKE_WRANGLER_LOG)
  ? readFileSync(process.env.FAKE_WRANGLER_LOG, "utf8")
  : "";
appendFileSync(process.env.FAKE_WRANGLER_LOG, JSON.stringify(entry) + "\\n");
if (args[0] === "deployments") console.log("[]");
if (args[0] === "secret" && args[1] === "list") {
  console.log(JSON.stringify([{ name: "SECRET_VAULT_LOCAL_KEK_V1" }]));
}
if (
  args[0] === "d1"
  && args[1] === "migrations"
  && !previous.includes('"d1","migrations"')
) {
  console.error(
    "Couldn't find an auto-provisioned D1 DB named 'app-ai-gateway-db' for binding 'DB'. "
    + "Run 'wrangler deploy' to provision it."
  );
  process.exit(1);
}
`,
    { mode: 0o700 },
  );
  chmodSync(fakeWrangler, 0o700);

  try {
    const result = spawnSync(process.execPath, ["scripts/deploy.mjs"], {
      cwd: isolatedCheckout(directory),
      encoding: "utf8",
      env: {
        ...process.env,
        APP_AI_GATEWAY_WRANGLER_BIN: fakeWrangler,
        FAKE_WRANGLER_LOG: callLog,
        DEPLOYMENT_ID: "deployment-fixture-identity",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /BETTER_AUTH_SECRET=/u);

    const calls = readFileSync(callLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      calls.map((call) => call.args),
      [
        ["deployments", "list", "--json"],
        ["secret", "list", "--format", "json"],
        ["secret", "bulk"],
        ["d1", "migrations", "apply", "DB", "--remote"],
        ["deploy", "--var", "DEPLOYMENT_ID:deployment-fixture-identity"],
        ["d1", "migrations", "apply", "DB", "--remote"],
      ],
    );

    const uploaded = JSON.parse(calls[2].input);
    assert.deepEqual(Object.keys(uploaded), ["JWT_SECRET", "BETTER_AUTH_SECRET"]);
    assert.equal(Buffer.from(uploaded.JWT_SECRET, "base64url").byteLength, 48);
    assert.equal(Buffer.from(uploaded.BETTER_AUTH_SECRET, "base64url").byteLength, 48);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("deployment profiles merge an overlay over the tracked configuration", () => {
  assert.deepEqual(
    mergeWranglerConfig(
      {
        name: "gateway",
        workers_dev: true,
        vars: { SECRET_VAULT_MODE: "local", SECRET_VAULT_LOCAL_KEK_CURRENT_VERSION: "1" },
        migrations: [{ tag: "v1" }],
        d1_databases: [{ binding: "DB", migrations_dir: "migrations" }],
      },
      {
        workers_dev: false,
        vars: { SECRET_VAULT_MODE: "kms", SECRET_VAULT_LOCAL_KEK_CURRENT_VERSION: null },
        d1_databases: [{ binding: "DB", database_id: "id", migrations_dir: "migrations" }],
        services: [{ binding: "BILLING", service: "billing" }],
      },
    ),
    {
      name: "gateway",
      workers_dev: false,
      vars: { SECRET_VAULT_MODE: "kms" },
      migrations: [{ tag: "v1" }],
      d1_databases: [{ binding: "DB", database_id: "id", migrations_dir: "migrations" }],
      services: [{ binding: "BILLING", service: "billing" }],
    },
  );
});

test("required operator secrets follow the resolved vault mode", () => {
  assert.deepEqual(requiredUserSecrets({}), ["SECRET_VAULT_LOCAL_KEK_V1"]);
  assert.deepEqual(
    requiredUserSecrets({ vars: { SECRET_VAULT_MODE: "local", SECRET_VAULT_LOCAL_KEK_CURRENT_VERSION: "2" } }),
    ["SECRET_VAULT_LOCAL_KEK_V2"],
  );
  assert.deepEqual(
    requiredUserSecrets({ vars: { SECRET_VAULT_MODE: "kms" } }),
    ["SECRET_VAULT_KMS_URL", "SECRET_VAULT_KMS_TOKEN"],
  );
});

test("a profile writes a generated config beside its sources and points Wrangler at it", () => {
  const directory = mkdtempSync(join(tmpdir(), "app-ai-gateway-profile-test-"));
  try {
    writeFileSync(
      join(directory, "wrangler.jsonc"),
      `{
  // The tracked configuration keeps comments.
  "name": "gateway",
  "main": "src/index.ts",
  "vars": { "SECRET_VAULT_MODE": "local" },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["UserLimiter"] }],
}
`,
    );
    writeFileSync(
      join(directory, "wrangler.prod.overlay.jsonc"),
      `{ "routes": [{ "pattern": "console.example.com", "custom_domain": true }] }`,
    );

    assert.deepEqual(listProfiles(directory), ["prod"]);

    const plain = resolveWranglerConfig(undefined, directory);
    assert.deepEqual(plain.configArgs, []);
    assert.equal(plain.config.name, "gateway");

    const { config, configPath, configArgs } = resolveWranglerConfig("prod", directory);
    assert.equal(configPath, join(directory, "wrangler.prod.generated.jsonc"));
    assert.deepEqual(configArgs, ["--config", configPath]);
    assert.deepEqual(config.routes, [{ pattern: "console.example.com", custom_domain: true }]);
    assert.deepEqual(config.migrations, [{ tag: "v1", new_sqlite_classes: ["UserLimiter"] }]);

    const generated = readFileSync(configPath, "utf8");
    assert.match(generated, /^\/\/ Generated from wrangler\.jsonc and wrangler\.prod\.overlay\.jsonc/u);
    assert.deepEqual(JSON.parse(generated.replace(/^\/\/.*$/gmu, "")), config);

    assert.throws(
      () => resolveWranglerConfig("staging", directory),
      /Deployment profile "staging" not found[\s\S]*Available profiles: prod/u,
    );
    assert.throws(() => resolveWranglerConfig("../etc", directory), /Invalid deployment profile name/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("--profile is separated from the remaining Wrangler arguments", () => {
  assert.deepEqual(takeProfileArgument(["deploy", "--profile", "prod", "--dry-run"]), {
    profile: "prod",
    rest: ["deploy", "--dry-run"],
  });
  assert.deepEqual(takeProfileArgument(["deploy", "--profile=prod"]), {
    profile: "prod",
    rest: ["deploy"],
  });
  assert.deepEqual(takeProfileArgument(["deploy"]), { profile: undefined, rest: ["deploy"] });
  assert.throws(() => takeProfileArgument(["deploy", "--profile"]), /requires a name/u);
});

test("deploying a profile passes the generated config to every Wrangler call", () => {
  const projectRoot = new URL("..", import.meta.url);
  const profile = `zz-test-${process.pid}`;
  const overlayPath = new URL(`wrangler.${profile}.overlay.jsonc`, projectRoot);
  const generatedPath = new URL(`wrangler.${profile}.generated.jsonc`, projectRoot);
  const directory = mkdtempSync(join(tmpdir(), "app-ai-gateway-deploy-profile-test-"));
  const fakeWrangler = join(directory, "wrangler.mjs");
  const callLog = join(directory, "calls.ndjson");
  writeFileSync(
    fakeWrangler,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_WRANGLER_LOG, JSON.stringify({ args }) + "\\n");
if (args[0] === "deployments") console.log("[]");
if (args[0] === "secret" && args[1] === "list") {
  console.log(JSON.stringify([
    { name: "SECRET_VAULT_KMS_URL" },
    { name: "SECRET_VAULT_KMS_TOKEN" },
    { name: "JWT_SECRET" },
    { name: "BETTER_AUTH_SECRET" },
  ]));
}
`,
    { mode: 0o700 },
  );
  chmodSync(fakeWrangler, 0o700);
  writeFileSync(overlayPath, `{ "vars": { "SECRET_VAULT_MODE": "kms" } }\n`);

  try {
    const result = spawnSync(process.execPath, ["scripts/deploy.mjs", "--profile", profile], {
      cwd: isolatedCheckout(directory, profile),
      encoding: "utf8",
      env: { ...process.env, APP_AI_GATEWAY_WRANGLER_BIN: fakeWrangler, FAKE_WRANGLER_LOG: callLog, DEPLOYMENT_ID: "deployment-fixture-identity" },
    });
    assert.equal(result.status, 0, result.stderr);

    const configArgs = ["--config", join(realpathSync(directory), `wrangler.${profile}.generated.jsonc`)];
    const calls = readFileSync(callLog, "utf8").trim().split("\n").map((line) => JSON.parse(line).args);
    assert.deepEqual(calls, [
      ["deployments", "list", "--json", ...configArgs],
      ["secret", "list", "--format", "json", ...configArgs],
      ["d1", "migrations", "apply", "DB", "--remote", ...configArgs],
      ["deploy", ...configArgs, "--var", "DEPLOYMENT_ID:deployment-fixture-identity"],
    ]);

    const generated = JSON.parse(readFileSync(join(directory, `wrangler.${profile}.generated.jsonc`), "utf8").replace(/^\/\/.*$/gmu, ""));
    assert.equal(generated.vars.SECRET_VAULT_MODE, "kms");
    assert.equal(generated.name, "app-ai-gateway");
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(overlayPath, { force: true });
    rmSync(generatedPath, { force: true });
  }
});


test("filling a missing deployment secret never overwrites established signing material", () => {
  const projectRoot = new URL("..", import.meta.url);
  const profile = `zz-missing-${process.pid}`;
  const overlayPath = new URL(`wrangler.${profile}.overlay.jsonc`, projectRoot);
  const generatedPath = new URL(`wrangler.${profile}.generated.jsonc`, projectRoot);
  const varsPath = new URL(`.dev.vars.${profile}`, projectRoot);
  const directory = mkdtempSync(join(tmpdir(), "agw-missing-secret-"));
  const fakeWrangler = join(directory, "wrangler.mjs"), callLog = join(directory, "calls.ndjson");
  writeFileSync(fakeWrangler, `#!/usr/bin/env node
import { appendFileSync, readFileSync, existsSync } from "node:fs";
const args=process.argv.slice(2), log=process.env.FAKE_WRANGLER_LOG;
const previous=existsSync(log)?readFileSync(log,"utf8"):"";
const input=args[0]==="secret"&&args[1]==="bulk"?readFileSync(0,"utf8"):undefined;
appendFileSync(log,JSON.stringify({args,input})+"\\n");
if(args[0]==="deployments")console.log("[]");
if(args[0]==="secret"&&args[1]==="list")console.log(JSON.stringify([
 {name:"JWT_SECRET"},{name:"BETTER_AUTH_SECRET"},...(previous.includes('"bulk"')?[{name:"SECRET_VAULT_LOCAL_KEK_V1"}]:[])
]));
`, { mode: 0o700 });
  writeFileSync(overlayPath, JSON.stringify({ vars: { DEPLOYMENT_ID: "stable-deployment-fixture" } }));
  writeFileSync(varsPath, "JWT_SECRET=must-not-replace\nBETTER_AUTH_SECRET=must-not-replace\nSECRET_VAULT_LOCAL_KEK_V1=fixture-vault\nDEPLOYMENT_ID=local-development-id\n");
  try {
    const result=spawnSync(process.execPath,["scripts/deploy.mjs","--profile",profile],{
      cwd:isolatedCheckout(directory,profile),encoding:"utf8",env:{...process.env,DEPLOYMENT_ID:"stable-deployment-fixture",APP_AI_GATEWAY_WRANGLER_BIN:fakeWrangler,FAKE_WRANGLER_LOG:callLog},
    });
    assert.equal(result.status,0,result.stderr);
    const calls=readFileSync(callLog,"utf8").trim().split("\n").map(line=>JSON.parse(line));
    assert.deepEqual(calls.filter(call=>call.input).map(call=>JSON.parse(call.input)),[{SECRET_VAULT_LOCAL_KEK_V1:"fixture-vault"}]);
    assert.doesNotMatch(result.stdout,/must-not-replace|fixture-vault/);
  } finally {
    for(const path of [overlayPath,generatedPath,varsPath])rmSync(path,{force:true});
    rmSync(directory,{recursive:true,force:true});
  }
});
