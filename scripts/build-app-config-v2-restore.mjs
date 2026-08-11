import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

const [backupPath, outputPath] = process.argv.slice(2);
if (!backupPath || !outputPath) {
  throw new Error("Usage: node scripts/build-app-config-v2-restore.mjs <backup.sqlite> <restore.sql>");
}

const database = new DatabaseSync(resolve(backupPath), { readOnly: true });
const apps = database.prepare("SELECT * FROM apps ORDER BY id").all();
const apiKeys = database.prepare("SELECT * FROM api_keys ORDER BY app_id, id").all();

function json(value, fallback = {}) {
  return value == null ? fallback : JSON.parse(value);
}

function usd(microusd) {
  return microusd == null ? null : Number(microusd) / 1_000_000;
}

function sql(value) {
  if (value == null) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function routingConfig(oldProxy) {
  const { provider_mode: mode, model_rewrites = {}, ...selected } = oldProxy;
  return {
    providers: mode === "all"
      ? { mode: "all" }
      : { mode: "selected", selected },
    model_rewrites,
  };
}

function limitsConfig(oldLimits, row) {
  return {
    per_user: {
      requests: {
        per_minute: oldLimits.rpm ?? null,
        per_day: oldLimits.rpd ?? null,
      },
      spending: { monthly_usd: usd(row.monthly_token_budget) },
    },
    per_app: {
      requests: {
        per_minute: oldLimits.app_rpm ?? null,
        per_day: oldLimits.app_rpd ?? null,
      },
      spending: { monthly_usd: usd(row.monthly_app_token_budget) },
    },
  };
}

function genericConfig(row, oldAuth, oldProxy, oldLimits) {
  const authentication = oldAuth.mode === "api_key"
    ? {
        type: "api_key",
        end_user: { header: "x-end-user-id", required: false, fallback: "api_key" },
      }
    : {
        type: "apple_app_attest",
        issuer: {
          jwks_url: oldAuth.jwks_url,
          user_id_claim: oldAuth.user_id_claim ?? "sub",
          ...(oldAuth.token_header ? { token_header: oldAuth.token_header } : {}),
          required_claims: oldAuth.required_claims ?? [],
          max_token_lifetime_seconds: oldAuth.max_token_lifetime_seconds ?? 86400,
        },
        app_attest: {
          team_id: row.apple_team_id,
          bundle_id: row.apple_bundle_id,
          environments: oldAuth.appattest_environments ?? ["production"],
        },
        development_access: oldAuth.dev_access?.secret != null,
      };
  return {
    authentication,
    routing: routingConfig(oldProxy),
    limits: limitsConfig(oldLimits, row),
  };
}

const calorieConfigs = new Map([["calorie-tracker", "config/calorie-tracker.production.json"]]);
const statements = ["PRAGMA foreign_keys = ON;"];
for (const row of apps) {
  const oldAuth = json(row.auth_config_json);
  const configPath = calorieConfigs.get(row.id);
  const config = configPath
    ? JSON.parse(readFileSync(resolve(configPath), "utf8")).config
    : genericConfig(row, oldAuth, json(row.proxy_config_json), json(row.limits_json));
  if (oldAuth.dev_access?.secret != null && config.authentication.type === "apple_app_attest") {
    config.authentication.development_access = true;
  }
  statements.push(
    `INSERT INTO apps(id, name, config_json, status, created_at, updated_at) VALUES (${[
      row.id,
      row.name,
      JSON.stringify(config),
      row.status,
      row.created_at,
      row.created_at,
    ].map(sql).join(", ")});`,
  );
  const secret = oldAuth.dev_access?.secret;
  if (typeof secret === "string") {
    statements.push(
      `INSERT INTO development_credentials(app_id, secret_hash, secret_prefix, created_at) VALUES (${[
        row.id,
        createHash("sha256").update(secret).digest("hex"),
        secret.slice(0, 12),
        row.created_at,
      ].map(sql).join(", ")});`,
    );
  }
}

for (const key of apiKeys) {
  statements.push(
    `INSERT INTO api_keys(id, app_id, name, key_hash, key_prefix, status, created_at, last_used_at) VALUES (${[
      key.id,
      key.app_id,
      key.name,
      key.key_hash,
      key.key_prefix,
      key.status,
      key.created_at,
      key.last_used_at,
    ].map(sql).join(", ")});`,
  );
}

statements.push("PRAGMA optimize;");
writeFileSync(resolve(outputPath), `${statements.join("\n")}\n`, { mode: 0o600 });
console.log(`Prepared restore for ${apps.length} apps and ${apiKeys.length} API keys.`);
