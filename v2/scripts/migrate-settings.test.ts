/**
 * The settings half of the v1-to-v2 migration, on made-up v1 data only: a v1
 * database built from v1's own migrations, seeded here, its keys sealed with
 * throwaway vault keys made for each run. No test reaches a deployment.
 *
 * Each rule of plan section 9.1 that the settings half carries has a test
 * here: what moves, what is left out and reported, and how keys are sealed
 * again. The last test runs the script itself on an export and checks the
 * files it writes.
 */
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { secretVault } from "../src/vault/index.ts";
import { secretContext } from "../src/vault/secrets.ts";
import { VAULT_SERVICE } from "../src/vault/types.ts";
import { checkAgainstV2, insertStatements } from "./migrate/output.ts";
import { migrateSettings, v1TimeMs, type MigrationResult, type Row } from "./migrate/settings.ts";
import { loadV1Export, readV1Settings } from "./migrate/v1-rows.ts";
import { vaultResealer } from "./migrate/vault.ts";

const V2_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const V1_MIGRATIONS = join(V2_DIR, "..", "migrations");
const V2_MIGRATIONS = join(V2_DIR, "migrations");
const NOW = new Date("2026-12-01T00:00:00Z");

const kek = () => randomBytes(32).toString("base64");
const V1_VAULT = { SECRET_VAULT_MODE: "local", SECRET_VAULT_LOCAL_KEK_V1: kek() };
// v2 seals under its own key, a version v1 never had, as the rehearsal does.
const V2_VAULT = { SECRET_VAULT_MODE: "local", SECRET_VAULT_LOCAL_KEK_V1: kek(), SECRET_VAULT_LOCAL_KEK_V9: kek(), SECRET_VAULT_LOCAL_KEK_CURRENT_VERSION: "9" };

/** Made-up provider keys: never real ones. */
const KEY = { direct: "sk-test-direct-0000", proxy: "sk-test-proxy-1111", cfBase: "sk-test-cfbase-2222", other: "sk-test-other-3333", broken: "sk-test-broken-4444" };
const CF_TOKEN = "cf-test-token-5555";
const VERCEL_TOKEN = "vercel-test-token-6666";

async function sealV1(secret: string, context: Record<string, string>): Promise<string> {
  return secretVault(V1_VAULT).encryptSecret(secret, { ...context, service: VAULT_SERVICE });
}

const sql = (value: unknown): string => (value === null ? "NULL" : typeof value === "number" ? String(value) : `'${String(value).replaceAll("'", "''")}'`);
const insert = (table: string, row: Record<string, unknown>): string =>
  `INSERT INTO "${table}" (${Object.keys(row).map((column) => `"${column}"`).join(",")}) VALUES(${Object.values(row).map(sql).join(",")});`;

const headerUser = { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } };
const attest = { type: "apple_app_attest", end_user: { source: "app_install" }, app_attest: { team_id: "ABCDE12345", bundle_id: "com.example.demo", environments: ["production"], verify_on: "every_request" } };
const unlimited = { requests: { per_minute: null, per_day: null }, spending: { monthly_usd: null } };
const conversationsOff = { store: false, keep: { images: true, audio: true, files: true }, retention_days: 180 };

function v1App(authentication: object, selected: Record<string, object> | "all", extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    authentication,
    routing: { providers: selected === "all" ? { mode: "all" } : { mode: "selected", selected }, model_rewrites: {} },
    limits: { per_user: { ...unlimited, spending: { monthly_usd: null, scope: authentication === attest ? "apple_account" : "user" } }, per_app: unlimited },
    endpoints: {},
    conversations: conversationsOff,
    ...extra,
  });
}

let exportSql = "";
let result: MigrationResult;

before(async () => {
  const schema = readdirSync(V1_MIGRATIONS).filter((name) => name.endsWith(".sql")).sort().map((name) => readFileSync(join(V1_MIGRATIONS, name), "utf8"));
  const providerKey = (id: string, type: string, baseUrl: string | null, secret: string) =>
    sealV1(secret, { organizationId: "org_a", providerId: id, providerType: type, baseUrl: baseUrl ?? "" });
  const rows: string[] = [
    // People: an owner with a password and Google, a member, and the service identity of an unclaimed account.
    insert("mgmt_user", { id: "u_owner", name: "Owner", email: "owner@example.test", kind: "human", email_verified: 1, image: null, created_at: 1_700_000_000_000, updated_at: 1_700_000_000_000 }),
    insert("mgmt_user", { id: "u_member", name: "Member", email: "member@example.test", kind: "human", email_verified: 1, image: null, created_at: 1_700_000_000_000, updated_at: 1_700_000_000_000 }),
    insert("mgmt_user", { id: "u_service", name: "CLI", email: null, kind: "service", email_verified: 0, image: null, created_at: 1_700_000_000_000, updated_at: 1_700_000_000_000 }),
    insert("mgmt_user_account", { id: "l_pw", account_id: "u_owner", provider_id: "credential", user_id: "u_owner", password: "salt:hash", created_at: 1, updated_at: 1 }),
    insert("mgmt_user_account", { id: "l_google", account_id: "google-123", provider_id: "google", user_id: "u_owner", access_token: "ya29.made-up", refresh_token: "1//made-up", id_token: "eyJ.made-up", scope: "openid email", created_at: 1, updated_at: 1 }),
    insert("mgmt_organization", { id: "org_a", name: "Account A", expires_at: null, created_by_user_id: "u_owner", created_at: "2026-01-01 00:00:00", updated_at: "2026-01-01 00:00:00" }),
    insert("mgmt_organization", { id: "org_tmp", name: "Temporary", expires_at: "2026-01-08 00:00:00", created_by_user_id: "u_service", created_at: "2026-01-01 00:00:00", updated_at: "2026-01-01 00:00:00" }),
    insert("mgmt_organization_user", { id: "m1", organization_id: "org_a", user_id: "u_owner", role: "owner", status: "active", joined_at: "2026-01-01 00:00:00", last_active_at: null }),
    insert("mgmt_organization_user", { id: "m2", organization_id: "org_a", user_id: "u_member", role: "member", status: "active", joined_at: "2026-01-02 00:00:00", last_active_at: null }),
    insert("mgmt_organization_user", { id: "m3", organization_id: "org_tmp", user_id: "u_service", role: "owner", status: "active", joined_at: "2026-01-01 00:00:00", last_active_at: null }),
    insert("mgmt_organization_invitation", { id: "i_open", organization_id: "org_a", email: "new@example.test", role: "member", token_hash: "th1", invited_by_user_id: "u_owner", created_at: "2026-11-25 00:00:00", expires_at: "2026-12-05 00:00:00" }),
    insert("mgmt_organization_invitation", { id: "i_old", organization_id: "org_a", email: "old@example.test", role: "member", token_hash: "th2", invited_by_user_id: "u_owner", created_at: "2026-01-01 00:00:00", expires_at: "2026-01-08 00:00:00" }),
    insert("mgmt_organization_invitation", { id: "i_done", organization_id: "org_a", email: "member@example.test", role: "member", token_hash: "th3", invited_by_user_id: "u_owner", created_at: "2026-11-25 00:00:00", expires_at: "2026-12-05 00:00:00", response: "accepted", responded_at: "2026-11-26 00:00:00", responded_by_user_id: "u_member" }),
    insert("mgmt_api_key", { id: "k_console", user_id: "u_owner", organization_id: "org_a", name: "CI", token_hash: "kh1", token_hint: "agw_…abcd", enabled: 1, created_at: 1, source: "console", grant: "manage", credential_type: "apiKey" }),
    insert("mgmt_api_key", { id: "k_cli", user_id: "u_owner", organization_id: "org_a", name: "agw", token_hash: "kh2", token_hint: "agw_…efgh", enabled: 1, created_at: 1, source: "cli", grant: "manage", credential_type: "apiKey" }),
    insert("mgmt_api_key", { id: "k_mcp", user_id: "u_owner", organization_id: "org_a", name: "MCP", token_hash: "kh3", token_hint: "…ijkl", enabled: 1, created_at: 1, source: "console", grant: "manage", client_id: "client-1", resource: "https://example.test/mcp", credential_type: "oauth" }),
    insert("mgmt_api_key", { id: "k_tmp", user_id: "u_service", organization_id: "org_tmp", name: "CLI bootstrap", token_hash: "kh4", token_hint: "…mnop", enabled: 0, created_at: 1, source: "bootstrap", grant: "manage", credential_type: "apiKey" }),
    // Connections.
    insert("provider", { id: "p_direct", organization_id: "org_a", type: "openai", slug: "openai", name: "OpenAI", secret_blob: await providerKey("p_direct", "openai", null, KEY.direct), secret_hint: "sk-…0000", created_by: "u_owner", created_at: "2026-02-01 10:00:00", updated_at: "2026-02-02 10:00:00", pricing_json: JSON.stringify({ "gpt-6.2-sol": { input: 1.25, output: 10 }, "my-tuned": { input: 1 } }) }),
    insert("provider", { id: "p_proxy", organization_id: "org_a", type: "openai", slug: "openai-proxy", name: "Proxy", secret_blob: await providerKey("p_proxy", "openai", "https://llm-proxy.example.com/openai/", KEY.proxy), secret_hint: "sk-…1111", base_url: "https://llm-proxy.example.com/openai/", created_by: "u_owner" }),
    insert("provider", { id: "p_cfbase", organization_id: "org_a", type: "anthropic", slug: "claude", name: "Claude", secret_blob: await providerKey("p_cfbase", "anthropic", "https://gateway.ai.cloudflare.com/v1/acc/gw/anthropic", KEY.cfBase), secret_hint: "sk-…2222", base_url: "https://gateway.ai.cloudflare.com/v1/acc/gw/anthropic", created_by: "u_owner" }),
    insert("provider", { id: "p_other", organization_id: "org_a", type: "openai", slug: "wrong-host", name: "Wrong host", secret_blob: await providerKey("p_other", "openai", "https://api.anthropic.com/v1", KEY.other), secret_hint: "sk-…3333", base_url: "https://api.anthropic.com/v1", created_by: "u_owner" }),
    // Sealed under another base URL than the row holds: does not open.
    insert("provider", { id: "p_broken", organization_id: "org_a", type: "gemini", slug: "gemini", name: "Gemini", secret_blob: await providerKey("p_broken", "gemini", "https://elsewhere.example.com/", KEY.broken), secret_hint: "…4444", created_by: "u_owner" }),
    insert("provider_gateway", { id: "g_cf", organization_id: "org_a", type: "cf_aig", name: "Edge", config_json: JSON.stringify({ accountId: "abc123", gatewayId: "my-gateway" }), secret_blob: await sealV1(CF_TOKEN, { organizationId: "org_a", providerGatewayId: "g_cf" }), secret_hint: "cf-…5555", created_by: "u_owner" }),
    insert("provider_gateway", { id: "g_vercel", organization_id: "org_a", type: "vercel", name: "Vercel", config_json: "{}", secret_blob: await sealV1(VERCEL_TOKEN, { organizationId: "org_a", providerGatewayId: "g_vercel" }), secret_hint: "ve…6666", created_by: "u_owner" }),
    insert("provider", { id: "p_cf", organization_id: "org_a", type: "openai", slug: "openai-edge", name: "OpenAI via edge", provider_gateway_id: "g_cf", created_by: "u_owner" }),
    insert("provider", { id: "p_vercel", organization_id: "org_a", type: "anthropic", slug: "claude-vercel", name: "Claude via Vercel", provider_gateway_id: "g_vercel", gateway_route_json: JSON.stringify({ providerOnly: ["bedrock"] }), pricing_json: JSON.stringify({ "claude-fable-5-2": { input: 3, output: 15 } }), created_by: "u_owner" }),
    insert("provider", { id: "p_tmp", organization_id: "org_tmp", type: "openai", slug: "openai", name: "Temp", secret_blob: await sealV1(KEY.direct, { organizationId: "org_tmp", providerId: "p_tmp", providerType: "openai", baseUrl: "" }), created_by: "u_service" }),
    // Apps.
    insert("app", {
      id: "chat-a1",
      organization_id: "org_a",
      name: "Chat",
      auth_type: "api_key",
      created_at: "2026-03-01 08:00:00",
      updated_at: "2026-03-02 08:00:00",
      config_json: v1App(headerUser, {
        openai: {
          allowed_paths: [
            "v1/chat/completions",
            { path: "/v1/responses", fixed_model: "gpt-6.2-sol" },
            { path: "v1/files", methods: ["GET", "POST"] },
            "v1/realtime/client_secrets",
            "v1beta/models/{model}:generateContent",
            "v1/{a}/{b}",
          ],
          allowed_models: ["gpt-6.2-sol"],
          max_output_tokens: 2048,
        },
        "openai-proxy": { allowed_paths: [], allowed_models: ["made-up-model"] },
        claude: { allowed_paths: ["v1/messages"], allowed_models: [] },
        "wrong-host": { allowed_paths: [], allowed_models: [] },
        "claude-vercel": { allowed_paths: ["v1/messages"], allowed_models: ["claude-fable-5-2"] },
        ghost: { allowed_paths: [], allowed_models: [] },
      }, {
        limits: { per_user: { requests: { per_minute: 10, per_day: null }, spending: { monthly_usd: 12.5, scope: "user" } }, per_app: { requests: { per_minute: null, per_day: 1000 }, spending: { monthly_usd: 0.000000001 } } },
        endpoints: {
          summary: { provider: "openai", model: "gpt-6.2-sol", kind: "text", api_style: "chat_completions", params: { temperature: 0 }, max_output_tokens: 300, fallback: [{ provider: "gemini", model: "gemini-4-neon" }, { provider: "claude-vercel", model: "claude-fable-5-2" }] },
          ask: { provider: "claude-vercel", model: "claude-fable-5-2", kind: "text", api_style: "anthropic_messages" },
        },
        conversations: { store: true, keep: { images: false, audio: true, files: true }, retention_days: 30 },
      }),
    }),
    insert("app", { id: "files-b2", organization_id: "org_a", name: "Files", auth_type: "api_key", config_json: v1App(headerUser, { openai: { allowed_paths: ["v1/batches"], allowed_models: [] } }), created_at: "2026-03-01 08:00:00", updated_at: "2026-03-01 08:00:00" }),
    insert("app", { id: "ios-c3", organization_id: "org_a", name: "iOS", auth_type: "apple_app_attest", status: "disabled", config_json: v1App(attest, "all", { routing: { providers: { mode: "all" }, model_rewrites: { fast: "gpt-6.2-sol" } } }), created_at: "2026-03-01 08:00:00", updated_at: "2026-03-01 08:00:00" }),
    insert("app", { id: "broken-d4", organization_id: "org_a", name: "Broken", auth_type: "api_key", config_json: "{not json", created_at: "2026-03-01 08:00:00", updated_at: "2026-03-01 08:00:00" }),
    insert("app", { id: "tmp-e5", organization_id: "org_tmp", name: "Temp", auth_type: "api_key", config_json: v1App(headerUser, "all"), created_at: "2026-03-01 08:00:00", updated_at: "2026-03-01 08:00:00" }),
    insert("app_api_key", { id: "ak1", app_id: "chat-a1", name: "server", key_hash: "akh1", key_prefix: "agw_live_ab", status: "active", created_at: "2026-03-01 08:00:00", last_used_at: "2026-11-20 12:00:00" }),
    insert("app_api_key", { id: "ak2", app_id: "tmp-e5", name: "server", key_hash: "akh2", key_prefix: "agw_live_cd", status: "active", created_at: "2026-03-01 08:00:00" }),
    insert("app_attest_key", { app_id: "ios-c3", key_id: "kid1", public_key: "pk1", environment: "production", user_id: null, created_at: "2026-03-01 08:00:00", last_seen_at: "2026-11-01 08:00:00" }),
    insert("app_attest_key", { app_id: "ios-c3", key_id: "kid2", public_key: "pk2", environment: "staging", user_id: null, created_at: "2026-03-01 08:00:00", last_seen_at: "2026-11-01 08:00:00" }),
    // An app deleted in v1, which its usage still names.
    insert("app_usage_event", { id: 1, event_id: "ev1", app_id: "gone-f6", organization_id: "org_a", provider_type: "openai", model: "gpt-6.2-sol", route: "chat", status: "ok" }),
  ];
  exportSql = [...schema, ...rows].join("\n");
  result = await migrateSettings(readV1Settings(loadV1Export(exportSql)), { now: NOW, reseal: vaultResealer(V1_VAULT, V2_VAULT) });
});

const table = (name: keyof MigrationResult["rows"]) => result.rows[name];
const row = (name: keyof MigrationResult["rows"], id: string): Row | undefined => table(name).find((one) => one.id === id);
const lines = (subject: string) => result.report.filter((line) => line.subject.startsWith(subject));
const said = (subject: string, pattern: RegExp, kind?: string) =>
  assert.ok(
    lines(subject).some((line) => pattern.test(line.what) && (kind === undefined || line.kind === kind)),
    `the report should say ${pattern} about ${subject}; it says:\n${lines(subject).map((line) => `  ${line.kind}: ${line.what}`).join("\n")}`,
  );
const config = (id: string) => JSON.parse(row("app", id)!.config_json as string);
const openV2 = (blob: string, context: Parameters<typeof secretContext>) => secretVault(V2_VAULT).decryptSecret(blob, secretContext(...context));

test("an unclaimed account is not moved, nor its people, apps, keys and connections", () => {
  assert.deepEqual(table("mgmt_organization").map((one) => one.id), ["org_a"]);
  said("account org_tmp", /never claimed/u, "left_out");
  assert.equal(row("mgmt_user", "u_service"), undefined);
  assert.equal(row("app", "tmp-e5"), undefined);
  assert.equal(row("app_key", "ak2"), undefined);
  assert.equal(row("provider_connection", "p_tmp"), undefined);
  assert.equal(row("mgmt_api_key", "k_tmp"), undefined);
});

test("logins move without Google's tokens; only open invitations move", () => {
  assert.deepEqual(table("mgmt_user").map((one) => one.id).sort(), ["u_member", "u_owner"]);
  assert.equal(row("mgmt_user_account", "l_pw")!.password, "salt:hash");
  const google = row("mgmt_user_account", "l_google")!;
  assert.deepEqual([google.access_token, google.refresh_token, google.id_token, google.scope], [null, null, null, null]);
  said("sign-ins", /1 Google sign-in was moved without/u);
  assert.deepEqual(table("mgmt_organization_invitation").map((one) => one.id), ["i_open"]);
  said("invitations", /2 invitations were answered or had ended/u);
});

test("console management keys move; CLI and MCP sign-ins do not", () => {
  assert.deepEqual(table("mgmt_api_key").map((one) => one.id), ["k_console"]);
  said("CLI and MCP sign-ins", /1 MCP or CLI connection/u);
  said("CLI and MCP sign-ins", /1 CLI sign-in key/u);
});

test("a provider key is sealed again for v2 and opens under the v2 connection's context", async () => {
  const direct = row("provider_connection", "p_direct")!;
  assert.equal(direct.type, "openai");
  assert.equal(await openV2(direct.secret_blob as string, ["providerKey", ["org_a", "p_direct", "openai", ""]]), KEY.direct);
  assert.match(direct.secret_blob as string, /9/u, "sealed under v2's current key");
  const proxy = row("provider_connection", "p_proxy")!;
  assert.equal(proxy.base_url, "https://llm-proxy.example.com/openai/");
  assert.equal(await openV2(proxy.secret_blob as string, ["providerKey", ["org_a", "p_proxy", "openai", "https://llm-proxy.example.com/openai/"]]), KEY.proxy);
  assert.equal(direct.created_at, v1TimeMs("2026-02-01 10:00:00"));
  assert.equal(direct.revision, 1);
});

test("own prices move as nano-dollar rates; one v2 refuses is reported", () => {
  const rates = JSON.parse(row("provider_connection", "p_direct")!.rates_json as string);
  assert.ok(rates["gpt-6.2-sol"], "the valid price moved");
  assert.equal(rates["my-tuned"], undefined);
  said("connection openai (p_direct)", /price for my-tuned was left out/u, "changed");
});

test("a base URL on Cloudflare AI Gateway goes direct, with the key sealed for no base URL", async () => {
  const claude = row("provider_connection", "p_cfbase")!;
  assert.equal(claude.base_url, null);
  assert.equal(await openV2(claude.secret_blob as string, ["providerKey", ["org_a", "p_cfbase", "anthropic", ""]]), KEY.cfBase);
  said("connection claude", /went through Cloudflare AI Gateway/u, "changed");
});

test("a base URL on another provider's host is never moved, so its key goes nowhere new", () => {
  assert.equal(row("provider_connection", "p_other"), undefined);
  said("connection wrong-host", /on Anthropic's host/u, "left_out");
});

test("a key that does not open is reported, and its connection left out", () => {
  assert.equal(row("provider_connection", "p_broken"), undefined);
  said("connection gemini", /does not open with v1's vault/u, "left_out");
});

test("a Cloudflare AI Gateway becomes the connection's own setting, with the token sealed to it", async () => {
  const edge = row("provider_connection", "p_cf")!;
  assert.equal(edge.secret_blob, null);
  const setting = JSON.parse(edge.cloudflare_gateway_json as string);
  assert.equal(setting.account_id, "abc123");
  assert.equal(setting.gateway_id, "my-gateway");
  assert.equal(setting.token_hint, "cf-…5555");
  assert.equal(await openV2(setting.token_blob, ["cloudflareGatewayToken", ["org_a", "p_cf"]]), CF_TOKEN);
});

test("a row through Vercel AI Gateway becomes a Vercel connection, with full model names", async () => {
  const vercel = row("provider_connection", "p_vercel")!;
  assert.equal(vercel.type, "vercel");
  assert.equal(await openV2(vercel.secret_blob as string, ["providerKey", ["org_a", "p_vercel", "vercel", ""]]), VERCEL_TOKEN);
  assert.equal(vercel.serving_providers_json, JSON.stringify(["bedrock"]));
  said("connection claude-vercel", /put anthropic\/ before every model name/u, "changed");
  const route = config("chat-a1").routing.providers["claude-vercel"];
  assert.deepEqual(route, { operations: ["vercel.messages"], models: ["anthropic/claude-fable-5-2"] });
  assert.equal(config("chat-a1").presets.ask.model, "anthropic/claude-fable-5-2");
  assert.equal(config("chat-a1").presets.ask.operation, "vercel.messages");
});

test("allowed paths become operations, or passthrough paths judged by the console's rules", () => {
  const openai = config("chat-a1").routing.providers.openai;
  assert.deepEqual(new Set(openai.operations), new Set(["openai.chat", "openai.responses", "passthrough"]));
  assert.deepEqual(openai.models, ["gpt-6.2-sol"]);
  assert.equal(openai.max_output_tokens, 2048);
  said("app chat-a1", /v1 sent every request to v1\/responses with the model gpt-6\.2-sol/u, "changed");
  said("app chat-a1", /v1beta\/models\/\{model\}:generateContent was not moved: it is Gemini's API/u, "left_out");
  said("app chat-a1", /passthrough path POST v1\/\{a\}\/\{b\} was not moved/u, "left_out");
  const listed = JSON.parse(row("provider_connection", "p_direct")!.passthrough_json as string).paths as { method: string; path: string; set_fields?: unknown[] }[];
  assert.deepEqual(listed.map((one) => `${one.method} ${one.path}`).sort(), ["GET v1/files", "POST v1/batches", "POST v1/files", "POST v1/realtime/client_secrets"]);
  // A live-session token mint gets the safe defaults a new listing gets.
  assert.ok(listed.find((one) => one.path === "v1/realtime/client_secrets")!.set_fields!.length > 0);
  said("connection openai of account org_a", /v1\/realtime\/client_secrets mints a short-lived secret/u, "changed");
});

test("a path one app listed is reported where another app on the connection can now reach it", () => {
  said("connection openai of account org_a", /POST v1\/batches, listed in v1 by files-b2, can now be reached by chat-a1/u, "check");
  said("connection openai of account org_a", /GET v1\/files, listed in v1 by chat-a1, can now be reached by files-b2/u, "check");
});

test("an empty path list allows every operation; all-mode allows every moved connection", () => {
  const proxy = config("chat-a1").routing.providers["openai-proxy"];
  assert.ok(proxy.operations.includes("openai.chat") && !proxy.operations.includes("passthrough"));
  said("app chat-a1", /On openai-proxy, v1 allowed every API it serves/u, "changed");
  const ios = config("ios-c3");
  assert.deepEqual(Object.keys(ios.routing.providers).sort(), ["claude", "claude-vercel", "openai", "openai-edge", "openai-proxy"]);
  said("app ios-c3", /v1 let it reach every connection of its account/u, "changed");
  assert.deepEqual(ios.routing.model_rewrites, { fast: "gpt-6.2-sol" });
  assert.equal(row("app", "ios-c3")!.status, "disabled");
});

test("an entry for a connection that was not moved is left out with one reason", () => {
  const providers = config("chat-a1").routing.providers;
  assert.equal(providers["wrong-host"], undefined);
  assert.equal(lines("app chat-a1").filter((line) => line.what.includes("wrong-host")).length, 0, "its reason is on the connection");
  said("app chat-a1", /It allowed ghost, which no connection of its account has/u, "changed");
});

test("endpoints become presets; a fallback to a connection not moved is dropped", () => {
  const summary = config("chat-a1").presets.summary;
  assert.deepEqual(summary, {
    provider: "openai",
    operation: "openai.chat",
    model: "gpt-6.2-sol",
    params: { temperature: 0 },
    max_output_tokens: 300,
    fallback: [{ provider: "claude-vercel", model: "anthropic/claude-fable-5-2" }],
  });
  said("app chat-a1", /summary's fallback to gemini \(gemini-4-neon\) was dropped/u, "changed");
});

test("budgets become nano-dollars; a default budget scope and default conversations are not written", () => {
  const limits = config("chat-a1").limits;
  assert.deepEqual(limits.per_user, { requests: { per_minute: 10, per_day: null }, spending: { monthly_nano: 12_500_000_000 } });
  assert.deepEqual(limits.per_app, { requests: { per_minute: null, per_day: 1000 }, spending: { monthly_nano: 1 } });
  assert.deepEqual(config("chat-a1").conversations, { store: true, keep: { images: false, audio: true, files: true }, retention_days: 30 });
  assert.equal(config("files-b2").conversations, undefined);
  assert.equal(config("ios-c3").limits.per_user.spending.scope, undefined);
});

test("app keys and App Attest keys move with their times; an unknown environment is reported", () => {
  const key = row("app_key", "ak1")!;
  assert.equal(key.created_at, v1TimeMs("2026-03-01 08:00:00"));
  assert.equal(key.last_used_at, v1TimeMs("2026-11-20 12:00:00"));
  assert.deepEqual(table("app_attest_key").map((one) => one.key_id), ["kid1"]);
  said("App Attest keys", /1 key names an environment v2 does not know/u, "left_out");
});

test("an app whose settings do not read is reported; its id and every deleted app's id are retired", () => {
  assert.equal(row("app", "broken-d4"), undefined);
  said("app broken-d4", /could not be read/u, "left_out");
  assert.deepEqual(table("retired_app_id").map((one) => one.id), ["broken-d4", "gone-f6", "tmp-e5"]);
  assert.ok(table("retired_app_id").every((one) => one.retired_at === NOW.getTime()));
});

test("every row fits v2's tables, and v2's save checks are run on each app", async () => {
  const judged = await checkAgainstV2(result, insertStatements(result.rows), V2_MIGRATIONS);
  // A model v2 has no price for still moves: it served in v1. The report says the console would refuse it.
  assert.deepEqual(judged.map((line) => [line.kind, line.subject]), [["check", "app chat-a1"]]);
  assert.match(judged[0]!.what, /made-up-model/u);
  // The report never holds a secret.
  const text = JSON.stringify([...result.report, ...judged]);
  for (const secret of [...Object.values(KEY), CF_TOKEN, VERCEL_TOKEN, "ya29.made-up", "salt:hash"]) assert.ok(!text.includes(secret));
});

test("the script reads an export and writes the SQL, readable by its user only, and the report", () => {
  const folder = mkdtempSync(join(tmpdir(), "agw-migrate-"));
  const vars = (env: Record<string, string>) => Object.entries(env).map(([name, value]) => `${name}=${value}`).join("\n");
  writeFileSync(join(folder, "v1.vars"), vars(V1_VAULT), { mode: 0o600 });
  writeFileSync(join(folder, "v2.vars"), vars(V2_VAULT), { mode: 0o600 });
  writeFileSync(join(folder, "export.sql"), exportSql);
  const run = spawnSync(
    process.execPath,
    ["--experimental-strip-types", join(V2_DIR, "scripts", "migrate-settings.ts"), "--from", "export.sql", "--out", "out", "--v1-vault", "v1.vars", "--v2-vault", "v2.vars", "--now", NOW.toISOString()],
    { cwd: folder, encoding: "utf8", env: { ...process.env, INIT_CWD: folder } },
  );
  assert.equal(run.status, 0, run.stderr);
  const sqlFile = join(folder, "out", "settings.sql");
  assert.equal(statSync(sqlFile).mode & 0o777, 0o600);
  const written = readFileSync(sqlFile, "utf8");
  assert.ok(written.includes("INSERT INTO app ") && written.includes("'chat-a1'"));
  const report = JSON.parse(readFileSync(join(folder, "out", "report.json"), "utf8")) as { rows: Record<string, number>; report: { kind: string }[] };
  assert.equal(report.rows.app, 3);
  assert.ok(readFileSync(join(folder, "out", "report.md"), "utf8").includes("## Not moved"));
  for (const output of [run.stdout, run.stderr, written, JSON.stringify(report)]) {
    for (const secret of [...Object.values(KEY), CF_TOKEN, VERCEL_TOKEN, V1_VAULT.SECRET_VAULT_LOCAL_KEK_V1, V2_VAULT.SECRET_VAULT_LOCAL_KEK_V9]) assert.ok(!output.includes(secret));
  }
});

test("a vault file that does not work stops the script before it reads anything", () => {
  const folder = mkdtempSync(join(tmpdir(), "agw-migrate-"));
  writeFileSync(join(folder, "v1.vars"), "SECRET_VAULT_MODE=local\n");
  writeFileSync(join(folder, "v2.vars"), "SECRET_VAULT_MODE=local\n");
  const run = spawnSync(
    process.execPath,
    ["--experimental-strip-types", join(V2_DIR, "scripts", "migrate-settings.ts"), "--from", "missing.sql", "--out", "out", "--v1-vault", "v1.vars", "--v2-vault", "v2.vars"],
    { cwd: folder, encoding: "utf8", env: { ...process.env, INIT_CWD: folder } },
  );
  assert.equal(run.status, 1);
  assert.match(run.stderr, /A vault file does not work: .*SECRET_VAULT_LOCAL_KEK_V1 is required/u);
});

test("an export loads with a row before the table it refers to, as wrangler d1 export writes it", () => {
  const db = loadV1Export(
    [
      "PRAGMA defer_foreign_keys=TRUE;",
      "CREATE TABLE `app` (`id` text PRIMARY KEY NOT NULL, `organization_id` text NOT NULL, FOREIGN KEY (`organization_id`) REFERENCES `mgmt_organization`(`id`));",
      `INSERT INTO "app" ("id","organization_id") VALUES('a1','o1');`,
      "CREATE TABLE `mgmt_organization` (`id` text PRIMARY KEY NOT NULL);",
      `INSERT INTO "mgmt_organization" ("id") VALUES('o1');`,
    ].join("\n"),
  );
  assert.deepEqual(db.prepare("SELECT id FROM app").all().map((one) => one.id), ["a1"]);
});
