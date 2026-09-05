import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createMissingGeneratedSecrets,
  missingRequiredSecrets,
  parseSecretList,
  requiredUserSecrets,
} from "../scripts/deploy-lib.mjs";
import {
  listProfiles,
  mergeWranglerConfig,
  resolveWranglerConfig,
  takeProfileArgument,
} from "../scripts/wrangler-config.mjs";

const deterministicRandom = (length) => Buffer.alloc(length, 0xab);

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

test("deploy button requests only the local vault key", () => {
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
  assert.deepEqual(Object.keys(packageJson.cloudflare.bindings), ["SECRET_VAULT_LOCAL_KEK_V1"]);
  assert.match(packageJson.cloudflare.bindings.SECRET_VAULT_LOCAL_KEK_V1.description, /openssl rand -base64 32/u);
  assert.match(secretTemplate, /^SECRET_VAULT_LOCAL_KEK_V1=$/mu);
  assert.equal(wranglerConfig.vars?.SECRET_VAULT_MODE, "local");
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
  const directory = mkdtempSync(join(tmpdir(), "ai-gateway-deploy-test-"));
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
        AI_GATEWAY_WRANGLER_BIN: fakeWrangler,
        FAKE_WRANGLER_LOG: callLog,
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
        ["secret", "list", "--format", "json"],
        ["secret", "bulk"],
        ["d1", "migrations", "apply", "DB", "--remote"],
        ["deploy"],
        ["d1", "migrations", "apply", "DB", "--remote"],
      ],
    );

    const uploaded = JSON.parse(calls[1].input);
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
  const directory = mkdtempSync(join(tmpdir(), "ai-gateway-profile-test-"));
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
  const directory = mkdtempSync(join(tmpdir(), "ai-gateway-deploy-profile-test-"));
  const fakeWrangler = join(directory, "wrangler.mjs");
  const callLog = join(directory, "calls.ndjson");
  writeFileSync(
    fakeWrangler,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_WRANGLER_LOG, JSON.stringify({ args }) + "\\n");
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
      env: { ...process.env, AI_GATEWAY_WRANGLER_BIN: fakeWrangler, FAKE_WRANGLER_LOG: callLog },
    });
    assert.equal(result.status, 0, result.stderr);

    const configArgs = ["--config", fileURLToPath(generatedPath)];
    const calls = readFileSync(callLog, "utf8").trim().split("\n").map((line) => JSON.parse(line).args);
    assert.deepEqual(calls, [
      ["secret", "list", "--format", "json", ...configArgs],
      ["d1", "migrations", "apply", "DB", "--remote", ...configArgs],
      ["deploy", ...configArgs],
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
