/**
 * The settings half of the v1-to-v2 migration, on made-up v1 data only: a v1
 * database built from v1's own migrations, seeded here, its keys sealed with
 * throwaway vault keys made for each run. No test reaches a deployment.
 *
 * Each rule of plan section 9.1 that the settings half carries has a test
 * here: what moves, what is left out and reported, and how keys are sealed
 * again. The guiding rule is checked throughout: no access widens, and no
 * traffic or key goes to another destination or account, without a line
 * that says so. The last tests run the script itself on an export and check
 * the files it writes.
 */
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { connectionCredentials, readCloudflareGateway, type ConnectionRecord } from "../src/providers/connections.ts";
import { secretVault } from "../src/vault/index.ts";
import { VAULT_SERVICE } from "../src/vault/types.ts";
import { checkAgainstV2, insertStatements, readFirst, reportMarkdown } from "./migrate/output.ts";
import { budgetNano, migrateSettings, SecretDoesNotOpen, TABLE_ORDER, v1TimeMs, type MigrationResult, type Row, type V2Rows } from "./migrate/settings.ts";
import { loadV1Export, openV1Export, readV1Settings, REQUIRED_TABLES, StatementSplitter } from "./migrate/v1-rows.ts";
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
const KEY = {
  direct: "sk-test-direct-0000",
  proxy: "sk-test-proxy-1111",
  cfBase: "sk-test-cfbase-2222",
  other: "sk-test-other-3333",
  broken: "sk-test-broken-4444",
  regional: "sk-test-regional-7777",
  gemini: "sk-test-gemini-8888",
  groq: "sk-test-groq-9999",
};
const CF_TOKEN = "cf-test-token-5555";
const CF_TOKEN_2 = "cf-test-token-5556";
const VERCEL_TOKEN = "vercel-test-token-6666";
const OTHER_TOKEN = "vercel-test-token-6667";

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

const app = (id: string, organization: string, config: string, extra: Record<string, unknown> = {}) =>
  insert("app", { id, organization_id: organization, name: id, auth_type: "api_key", config_json: config, created_at: "2026-03-01 08:00:00", updated_at: "2026-03-01 08:00:00", ...extra });

let exportSql = "";
let result: MigrationResult;

before(async () => {
  const schema = readdirSync(V1_MIGRATIONS).filter((name) => name.endsWith(".sql")).sort().map((name) => readFileSync(join(V1_MIGRATIONS, name), "utf8"));
  const providerKey = (id: string, type: string, baseUrl: string | null, secret: string, organization = "org_a") =>
    sealV1(secret, { organizationId: organization, providerId: id, providerType: type, baseUrl: baseUrl ?? "" });
  const provider = async (id: string, slug: string, type: string, baseUrl: string | null, secret: string, extra: Record<string, unknown> = {}) =>
    insert("provider", { id, organization_id: "org_a", type, slug, name: slug, secret_blob: await providerKey(id, type, baseUrl, secret), secret_hint: "sk-…", base_url: baseUrl, created_by: "u_owner", ...extra });
  const CF_BASE = "https://gateway.ai.cloudflare.com/v1";
  // From a v1 migration that marked every account then: these are activated whatever their owners' addresses.
  const activatedBefore = "DELETE FROM account_activation;";
  const rows: string[] = [
    activatedBefore,
    // People: an owner with a password and Google, a member, the service identity of an unclaimed account, and an owner who never verified.
    insert("mgmt_user", { id: "u_owner", name: "Owner", email: "owner@example.test", kind: "human", email_verified: 1, image: null, created_at: 1_700_000_000_000, updated_at: 1_700_000_000_000 }),
    insert("mgmt_user", { id: "u_member", name: "Member", email: "member@example.test", kind: "human", email_verified: 1, image: null, created_at: 1_700_000_000_000, updated_at: 1_700_000_000_000 }),
    insert("mgmt_user", { id: "u_service", name: "CLI", email: null, kind: "service", email_verified: 0, image: null, created_at: 1_700_000_000_000, updated_at: 1_700_000_000_000 }),
    insert("mgmt_user", { id: "u_unverified", name: "New", email: "new-owner@example.test", kind: "human", email_verified: 0, image: null, created_at: 1_700_000_000_000, updated_at: 1_700_000_000_000 }),
    insert("mgmt_user_account", { id: "l_pw", account_id: "u_owner", provider_id: "credential", user_id: "u_owner", password: "salt:hash", created_at: 1, updated_at: 1 }),
    insert("mgmt_user_account", { id: "l_google", account_id: "google-123", provider_id: "google", user_id: "u_owner", access_token: "ya29.made-up", refresh_token: "1//made-up", id_token: "eyJ.made-up", scope: "openid email", created_at: 1, updated_at: 1 }),
    insert("mgmt_organization", { id: "org_a", name: "Account A", expires_at: null, created_by_user_id: "u_owner", created_at: "2026-01-01 00:00:00", updated_at: "2026-01-01 00:00:00" }),
    insert("mgmt_organization", { id: "org_b", name: "Account B", expires_at: null, created_by_user_id: "u_unverified", created_at: "2026-01-01 00:00:00", updated_at: "2026-01-01 00:00:00" }),
    insert("mgmt_organization", { id: "org_c", name: "Account C", expires_at: null, created_by_user_id: "u_unverified", created_at: "2026-01-01 00:00:00", updated_at: "2026-01-01 00:00:00" }),
    insert("account_activation", { organization_id: "org_c", activated_at: "2026-01-01 00:00:00" }),
    insert("mgmt_organization", { id: "org_tmp", name: "Temporary", expires_at: "2026-01-08 00:00:00", created_by_user_id: "u_service", created_at: "2026-01-01 00:00:00", updated_at: "2026-01-01 00:00:00" }),
    insert("mgmt_organization_user", { id: "m1", organization_id: "org_a", user_id: "u_owner", role: "owner", status: "active", joined_at: "2026-01-01 00:00:00", last_active_at: null }),
    insert("mgmt_organization_user", { id: "m2", organization_id: "org_a", user_id: "u_member", role: "member", status: "active", joined_at: "2026-01-02 00:00:00", last_active_at: null }),
    insert("mgmt_organization_user", { id: "m3", organization_id: "org_tmp", user_id: "u_service", role: "owner", status: "active", joined_at: "2026-01-01 00:00:00", last_active_at: null }),
    insert("mgmt_organization_user", { id: "m4", organization_id: "org_b", user_id: "u_unverified", role: "owner", status: "active", joined_at: "2026-01-01 00:00:00", last_active_at: null }),
    insert("mgmt_organization_user", { id: "m5", organization_id: "org_c", user_id: "u_unverified", role: "owner", status: "active", joined_at: "2026-01-01 00:00:00", last_active_at: null }),
    insert("mgmt_organization_invitation", { id: "i_open", organization_id: "org_a", email: "new@example.test", role: "member", token_hash: "th1", invited_by_user_id: "u_owner", created_at: "2026-11-25 00:00:00", expires_at: "2026-12-05 00:00:00" }),
    insert("mgmt_organization_invitation", { id: "i_old", organization_id: "org_a", email: "old@example.test", role: "member", token_hash: "th2", invited_by_user_id: "u_owner", created_at: "2026-01-01 00:00:00", expires_at: "2026-01-08 00:00:00" }),
    insert("mgmt_organization_invitation", { id: "i_done", organization_id: "org_a", email: "member@example.test", role: "member", token_hash: "th3", invited_by_user_id: "u_owner", created_at: "2026-11-25 00:00:00", expires_at: "2026-12-05 00:00:00", response: "accepted", responded_at: "2026-11-26 00:00:00", responded_by_user_id: "u_member" }),
    insert("mgmt_api_key", { id: "k_console", user_id: "u_owner", organization_id: "org_a", name: "CI", token_hash: "kh1", token_hint: "agw_…abcd", enabled: 1, created_at: 1, source: "console", grant: "manage", credential_type: "apiKey" }),
    insert("mgmt_api_key", { id: "k_cli", user_id: "u_owner", organization_id: "org_a", name: "agw", token_hash: "kh2", token_hint: "agw_…efgh", enabled: 1, created_at: 1, source: "cli", grant: "manage", credential_type: "apiKey" }),
    insert("mgmt_api_key", { id: "k_mcp", user_id: "u_owner", organization_id: "org_a", name: "MCP", token_hash: "kh3", token_hint: "…ijkl", enabled: 1, created_at: 1, source: "console", grant: "manage", client_id: "client-1", resource: "https://example.test/mcp", credential_type: "oauth" }),
    insert("mgmt_api_key", { id: "k_tmp", user_id: "u_service", organization_id: "org_tmp", name: "CLI bootstrap", token_hash: "kh4", token_hint: "…mnop", enabled: 0, created_at: 1, source: "bootstrap", grant: "manage", credential_type: "apiKey" }),
    // Gateways: org_a's Cloudflare and Vercel ones, a second Cloudflare one whose ids a base URL names, and another account's.
    insert("provider_gateway", { id: "g_cf", organization_id: "org_a", type: "cf_aig", name: "Edge", config_json: JSON.stringify({ accountId: "abc123", gatewayId: "my-gateway" }), secret_blob: await sealV1(CF_TOKEN, { organizationId: "org_a", providerGatewayId: "g_cf" }), secret_hint: "cf-…5555", created_by: "u_owner" }),
    insert("provider_gateway", { id: "g_cf2", organization_id: "org_a", type: "cf_aig", name: "Edge 2", config_json: JSON.stringify({ accountId: "acc", gatewayId: "gw" }), secret_blob: await sealV1(CF_TOKEN_2, { organizationId: "org_a", providerGatewayId: "g_cf2" }), secret_hint: "cf-…5556", created_by: "u_owner" }),
    insert("provider_gateway", { id: "g_vercel", organization_id: "org_a", type: "vercel", name: "Vercel", config_json: "{}", secret_blob: await sealV1(VERCEL_TOKEN, { organizationId: "org_a", providerGatewayId: "g_vercel" }), secret_hint: "ve…6666", created_by: "u_owner" }),
    insert("provider_gateway", { id: "g_b", organization_id: "org_b", type: "vercel", name: "B's Vercel", config_json: "{}", secret_blob: await sealV1(OTHER_TOKEN, { organizationId: "org_b", providerGatewayId: "g_b" }), secret_hint: "ve…6667", created_by: "u_unverified" }),
    // Connections.
    await provider("p_direct", "openai", "openai", null, KEY.direct, { created_at: "2026-02-01 10:00:00", updated_at: "2026-02-02 10:00:00", pricing_json: JSON.stringify({ "gpt-6.2-sol": { input: 1.25, output: 10 }, "my-tuned": { input: 1 } }) }),
    await provider("p_proxy", "openai-proxy", "openai", "https://llm-proxy.example.com/openai/", KEY.proxy),
    await provider("p_cfbase", "claude", "anthropic", `${CF_BASE}/acc/gw/anthropic`, KEY.cfBase),
    await provider("p_cfnotoken", "openai-cf", "openai", `${CF_BASE}/acc/elsewhere/openai`, KEY.cfBase),
    await provider("p_cfworkers", "workers", "openai", `${CF_BASE}/acc/gw/workers-ai`, KEY.cfBase),
    await provider("p_cfopenai", "openai-cfbase", "openai", `${CF_BASE}/acc/gw/openai/`, KEY.cfBase),
    await provider("p_cfquery", "claude-query", "anthropic", `${CF_BASE}/acc/gw/anthropic?x=1`, KEY.cfBase),
    await provider("p_eu_plain", "openai-eu-plain", "openai", "https://eu.api.openai.com/", KEY.regional),
    await provider("p_openrouter", "router", "openrouter", "https://openrouter.ai/api/v1/", KEY.regional),
    await provider("p_other", "wrong-host", "openai", "https://api.anthropic.com/v1", KEY.other),
    await provider("p_eu", "openai-eu", "openai", "https://eu.api.openai.com/v1/", KEY.regional),
    await provider("p_mistral_eu", "mistral-eu", "mistral", "https://api.eu.mistral.ai/v1/", KEY.regional),
    await provider("p_moonshot_cn", "moonshot-cn", "moonshot", "https://api.moonshot.cn/v1/", KEY.regional),
    await provider("p_port", "openai-port", "openai", "https://eu.api.openai.com:8443/v1/", KEY.regional),
    await provider("p_http", "openai-http", "openai", "http://llm-proxy.example.com/openai/", KEY.regional),
    await provider("p_gem", "gem", "gemini", null, KEY.gemini),
    await provider("p_groq", "groq", "groq", null, KEY.groq),
    // Sealed under another base URL than the row holds: does not open.
    insert("provider", { id: "p_broken", organization_id: "org_a", type: "gemini", slug: "gemini", name: "Gemini", secret_blob: await providerKey("p_broken", "gemini", "https://elsewhere.example.com/", KEY.broken), secret_hint: "…4444", created_by: "u_owner" }),
    insert("provider", { id: "p_cf", organization_id: "org_a", type: "openai", slug: "openai-edge", name: "OpenAI via edge", provider_gateway_id: "g_cf", created_by: "u_owner" }),
    insert("provider", {
      id: "p_vercel",
      organization_id: "org_a",
      type: "anthropic",
      slug: "claude-vercel",
      name: "Claude via Vercel",
      provider_gateway_id: "g_vercel",
      gateway_route_json: JSON.stringify({ providerOnly: ["bedrock"] }),
      pricing_json: JSON.stringify({ "claude-fable-5-2": { input: 3, output: 15 }, "claude-x": { input: 1, output: 2 }, "claude-x ": { input: 9, output: 9 } }),
      created_by: "u_owner",
    }),
    insert("provider", { id: "p_vercel_groq", organization_id: "org_a", type: "groq", slug: "groq-vercel", name: "Groq via Vercel", provider_gateway_id: "g_vercel", created_by: "u_owner" }),
    insert("provider", { id: "p_xacct", organization_id: "org_a", type: "openai", slug: "borrowed", name: "Borrowed gateway", provider_gateway_id: "g_b", created_by: "u_owner" }),
    insert("provider", { id: "p_tmp", organization_id: "org_tmp", type: "openai", slug: "openai", name: "Temp", secret_blob: await sealV1(KEY.direct, { organizationId: "org_tmp", providerId: "p_tmp", providerType: "openai", baseUrl: "" }), created_by: "u_service" }),
    // Apps.
    app(
      "chat-a1",
      "org_a",
      v1App(headerUser, {
        openai: {
          allowed_paths: [
            { path: "v1/chat/completions", clamp: "anthropic" },
            { path: "/v1/responses", fixed_model: "gpt-6.2-sol" },
            { path: "v1/files", methods: ["GET", "POST"] },
            "v1/files/{file_id}",
            "v1/realtime/client_secrets",
            "v1beta/models/{model}:generateContent",
            "v1/{model}",
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
        limits: { per_user: { requests: { per_minute: 10, per_day: null }, spending: { monthly_usd: 12.5, scope: "user" } }, per_app: { requests: { per_minute: null, per_day: 1000 }, spending: { monthly_usd: 0.0000000001 } } },
        endpoints: {
          summary: { provider: "openai", model: "gpt-6.2-sol", kind: "text", api_style: "responses", params: { temperature: 0 }, max_output_tokens: 300, fallback: [{ provider: "gemini", model: "gemini-4-neon" }, { provider: "claude-vercel", model: "claude-fable-5-2" }] },
          ask: { provider: "claude-vercel", model: "claude-fable-5-2", kind: "text", api_style: "anthropic_messages" },
          listen: { provider: "groq", model: "whisper-large-v3", kind: "transcription", api_style: "audio_transcription" },
        },
        conversations: { store: true, keep: { images: false, audio: true, files: true }, retention_days: 30 },
      }),
      { created_at: "2026-03-01 08:00:00", updated_at: "2026-03-02 08:00:00" },
    ),
    app("files-b2", "org_a", v1App(headerUser, { openai: { allowed_paths: ["v1/batches"], allowed_models: [] } })),
    app("ios-c3", "org_a", v1App(attest, "all", { routing: { providers: { mode: "all" }, model_rewrites: { fast: "gpt-6.2-sol" } } }), { auth_type: "apple_app_attest", status: "disabled" }),
    app("broken-d4", "org_a", "{not json"),
    app("tmp-e5", "org_tmp", v1App(headerUser, "all")),
    // Exact Gemini paths name their model: with no model list, and with one that holds more.
    app("gem-g7", "org_a", v1App(headerUser, { gem: { allowed_paths: ["v1beta/models/gemini-2.5-flash:generateContent", "v1beta/openai/chat/completions", "v1beta/models/gemini-{model}:streamGenerateContent"], allowed_models: [] } })),
    app("gem-h8", "org_a", v1App(headerUser, { gem: { allowed_paths: ["v1beta/models/gemini-2.5-flash:generateContent"], allowed_models: ["gemini-2.5-flash", "gemini-4-neon"] } })),
    // Only Vercel carries its rewrite.
    app("vercel-i9", "org_a", v1App(headerUser, { "claude-vercel": { allowed_paths: [], allowed_models: ["fast", "claude-fable-5-2"] } }, { routing: { providers: { mode: "selected", selected: { "claude-vercel": { allowed_paths: [], allowed_models: ["fast", "claude-fable-5-2"] } } }, model_rewrites: { fast: "claude-fable-5-2" } } })),
    // A rewrite carried by Vercel and by a direct connection.
    app("mixed-j10", "org_a", JSON.stringify({ ...JSON.parse(v1App(headerUser, {})), routing: { providers: { mode: "selected", selected: { openai: { allowed_paths: [], allowed_models: [] }, "claude-vercel": { allowed_paths: [], allowed_models: ["fast"] } } }, model_rewrites: { fast: "claude-fable-5-2" } } })),
    insert("app_api_key", { id: "ak1", app_id: "chat-a1", name: "server", key_hash: "akh1", key_prefix: "agw_live_ab", status: "active", created_at: "2026-03-01 08:00:00", last_used_at: "2026-11-20 12:00:00" }),
    insert("app_api_key", { id: "ak2", app_id: "tmp-e5", name: "server", key_hash: "akh2", key_prefix: "agw_live_cd", status: "active", created_at: "2026-03-01 08:00:00" }),
    insert("app_attest_key", { app_id: "ios-c3", key_id: "kid1", public_key: "pk1", environment: "production", user_id: null, created_at: "2026-03-01 08:00:00", last_seen_at: "2026-11-01 08:00:00" }),
    insert("app_attest_key", { app_id: "ios-c3", key_id: "kid2", public_key: "pk2", environment: "staging", user_id: null, created_at: "2026-03-01 08:00:00", last_seen_at: "2026-11-01 08:00:00" }),
    insert("app_user", { app_id: "chat-a1", id: "end-user-1", status: "blocked" }),
    insert("app_user", { app_id: "chat-a1", id: "end-user-2", status: "blocked" }),
    insert("app_user", { app_id: "chat-a1", id: "end-user-3", status: "active" }),
    // An app deleted in v1, which its usage still names; and what chat-a1 really called on its default route.
    insert("app_usage_event", { id: 1, event_id: "ev1", app_id: "gone-f6", organization_id: "org_a", provider_type: "openai", model: "gpt-6.2-sol", route: "openai/v1/chat/completions", status: "ok" }),
    insert("app_usage_event", { id: 2, event_id: "ev2", app_id: "chat-a1", organization_id: "org_a", provider_type: "openai", model: "gemini-2.5-flash", route: "openai-proxy/v1beta/models/gemini-2.5-flash:generateContent", status: "ok" }),
    insert("app_usage_event", { id: 3, event_id: "ev3", app_id: "chat-a1", organization_id: "org_a", provider_type: "openai", model: "gpt-6.2-sol", route: "openai-proxy/v1/chat/completions", status: "ok" }),
  ];
  exportSql = [...schema, ...rows].join("\n");
  result = await migrateSettings(readV1Settings(loadV1Export(exportSql)), { now: NOW, reseal: vaultResealer(V1_VAULT, V2_VAULT) });
});

const table = (name: keyof MigrationResult["rows"]) => result.rows[name];
const row = (name: keyof MigrationResult["rows"], id: string): Row | undefined => table(name).find((one) => one.id === id);
const lines = (subject: string) => result.report.filter((line) => line.subject.startsWith(subject));
const said = (subject: string, pattern: RegExp, kind?: string) => {
  const found = lines(subject).find((line) => pattern.test(line.what) && (kind === undefined || line.kind === kind));
  assert.ok(found, `the report should say ${pattern} about ${subject}; it says:\n${lines(subject).map((line) => `  ${line.kind}: ${line.what}`).join("\n")}`);
  return found;
};
const config = (id: string) => JSON.parse(row("app", id)!.config_json as string);
/** A moved connection's credentials, opened the way the Worker opens them for a live request (Sol 1). */
const credentials = (id: string) => {
  const moved = row("provider_connection", id)!;
  const record = {
    id: moved.id,
    accountId: moved.account_id,
    type: moved.type,
    slug: moved.slug,
    baseUrl: moved.base_url,
    secretBlob: moved.secret_blob,
    cloudflareGateway: readCloudflareGateway(moved.cloudflare_gateway_json),
  } as unknown as ConnectionRecord;
  return connectionCredentials(V2_VAULT as unknown as Env, record);
};

// ---------------------------------------------------------------- accounts and people

test("an unclaimed account is not moved, nor its people, apps, keys and connections", () => {
  assert.deepEqual(table("mgmt_organization").map((one) => one.id), ["org_a", "org_b", "org_c"]);
  assert.ok(readFirst(said("account org_tmp", /never claimed/u, "left_out")));
  assert.equal(row("mgmt_user", "u_service"), undefined);
  assert.equal(row("app", "tmp-e5"), undefined);
  assert.equal(row("app_key", "ak2"), undefined);
  assert.equal(row("provider_connection", "p_tmp"), undefined);
  assert.equal(row("mgmt_api_key", "k_tmp"), undefined);
});

test("logins move without Google's tokens; only open invitations move", () => {
  assert.deepEqual(table("mgmt_user").map((one) => one.id).sort(), ["u_member", "u_owner", "u_unverified"]);
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

test("an account v1 refused for an unverified owner is named, since v2 serves it (Gemini Neon 1)", () => {
  const line = said("accounts", /1 account v1 refused .* no owner had a verified address: org_b\. v2 has no activation step/u, "check");
  assert.ok(!line.what.includes("org_c"), "an account v1 activated is served by both");
});

// ---------------------------------------------------------------- keys and destinations

test("a provider key is sealed again for v2, and opens as the Worker opens it for a live request (Sol 1)", async () => {
  const direct = row("provider_connection", "p_direct")!;
  assert.equal(direct.type, "openai");
  assert.deepEqual(await credentials("p_direct"), { providerKey: KEY.direct, cloudflareToken: null });
  assert.match(direct.secret_blob as string, /9/u, "sealed under v2's current key");
  assert.equal(row("provider_connection", "p_proxy")!.base_url, "https://llm-proxy.example.com/openai/");
  assert.deepEqual(await credentials("p_proxy"), { providerKey: KEY.proxy, cloudflareToken: null });
  assert.deepEqual(await credentials("p_gem"), { providerKey: KEY.gemini, cloudflareToken: null });
  assert.equal(direct.created_at, v1TimeMs("2026-02-01 10:00:00"));
  assert.equal(direct.revision, 1);
});

test("own prices move as nano-dollar rates; one v2 refuses, or two that land on one name, are reported (Sol 4)", () => {
  const rates = JSON.parse(row("provider_connection", "p_direct")!.rates_json as string);
  assert.ok(rates["gpt-6.2-sol"], "the valid price moved");
  assert.equal(rates["my-tuned"], undefined);
  said("connection openai (p_direct)", /price for my-tuned was left out/u, "changed");
  const vercel = JSON.parse(row("provider_connection", "p_vercel")!.rates_json as string);
  assert.deepEqual(Object.keys(vercel), ["anthropic/claude-fable-5-2"]);
  assert.ok(readFirst(said("connection claude-vercel", /prices for "claude-x", "claude-x " all name "anthropic\/claude-x" in v2, so none of them was kept/u, "changed")));
});

test("a Cloudflare AI Gateway base URL keeps going through that gateway, with the account's token for it (Sol 1, 3, Fable 1)", async () => {
  const claude = row("provider_connection", "p_cfbase")!;
  assert.equal(claude.base_url, null);
  const setting = JSON.parse(claude.cloudflare_gateway_json as string);
  assert.deepEqual([setting.account_id, setting.gateway_id], ["acc", "gw"]);
  // The key is sealed for the gateway's address, which the Worker opens it for: a live request gets it.
  assert.deepEqual(await credentials("p_cfbase"), { providerKey: KEY.cfBase, cloudflareToken: CF_TOKEN_2 });
  said("connection claude", /now goes through the same gateway with the connection's own Cloudflare AI Gateway setting/u, "changed");
});

test("a Cloudflare base URL with no token for its gateway, another provider's endpoint, or a query, is left out, never sent direct (Fable 6, Gemini Neon 4)", () => {
  assert.equal(row("provider_connection", "p_cfnotoken"), undefined);
  said("connection openai-cf", /the account holds none for that gateway\. Add the connection again with its Cloudflare AI Gateway setting and a token/u, "left_out");
  assert.equal(row("provider_connection", "p_cfworkers"), undefined);
  said("connection workers", /Cloudflare AI Gateway's workers-ai endpoint, not the openai one/u, "left_out");
  assert.equal(row("provider_connection", "p_cfquery"), undefined);
  said("connection claude-query", /with a port, a query, a fragment or credentials/u, "left_out");
});

test("a Cloudflare base URL keeps only the requests whose whole URL stays the same (Sol 4)", async () => {
  // v1 joined /openai/ and v1/chat/completions; v2's Cloudflare setting drops v1/. Only the bare paths reach the same URL.
  const ios = config("ios-c3").routing.providers["openai-cfbase"];
  assert.ok(ios.operations.includes("openai.chat.bare") && !ios.operations.includes("openai.chat"));
  said("app ios-c3", /On openai-cfbase, v2 would send these to another URL than v1 did.*openai\.chat \(v1: https:\/\/gateway\.ai\.cloudflare\.com\/v1\/acc\/gw\/openai\/v1\/chat\/completions, v2: https:\/\/gateway\.ai\.cloudflare\.com\/v1\/acc\/gw\/openai\/chat\/completions\)/u, "left_out");
  assert.deepEqual(await credentials("p_cfopenai"), { providerKey: KEY.cfBase, cloudflareToken: CF_TOKEN_2 });
});

test("a regional base URL keeps its host and its URLs, or the connection is left out (Sol 4, Gemini Neon 2, 3)", () => {
  // v1 joined …/v1/ and the request's path; v2 takes only the host's plain address, so no request keeps its URL.
  for (const [id, slug, host] of [["p_eu", "openai-eu", "eu\\.api\\.openai\\.com"], ["p_mistral_eu", "mistral-eu", "api\\.eu\\.mistral\\.ai"], ["p_moonshot_cn", "moonshot-cn", "api\\.moonshot\\.cn"]] as const) {
    assert.equal(row("provider_connection", id), undefined, id);
    said(`connection ${slug}`, new RegExp(`v2 would send none of its requests to the URL v1 sent them to \\(for example https://${host}/v1/`, "u"), "left_out");
  }
  // The same for a provider whose own address has a path: the retry is its plain address, and the URLs are compared.
  assert.equal(row("provider_connection", "p_openrouter"), undefined);
  said("connection router", /v2 would send none of its requests to the URL v1 sent them to/u, "left_out");
  // A regional base URL v1 held as v2 does moves as it is.
  assert.equal(row("provider_connection", "p_eu_plain")!.base_url, "https://eu.api.openai.com/");
  // A custom port, or plain http, is never turned into another address.
  assert.equal(row("provider_connection", "p_port"), undefined);
  said("connection openai-port", /port 8443 is not allowed/u, "left_out");
  assert.equal(row("provider_connection", "p_http"), undefined);
  said("connection openai-http", /must use https/u, "left_out");
});

test("a base URL on another provider's host is never moved, so its key goes nowhere new", () => {
  assert.equal(row("provider_connection", "p_other"), undefined);
  said("connection wrong-host", /on Anthropic's host/u, "left_out");
});

test("a key that does not open is reported, and its connection left out", () => {
  assert.equal(row("provider_connection", "p_broken"), undefined);
  said("connection gemini", /does not open with v1's vault/u, "left_out");
});

test("a gateway token never moves across accounts (Sol 2)", () => {
  assert.equal(row("provider_connection", "p_xacct"), undefined);
  said("connection borrowed", /names provider gateway g_b of another account \(org_b\)/u, "left_out");
});

test("a vault outage stops the run, naming the row; only a blob that does not open leaves its row out (Fable 3, 4)", async () => {
  const v1 = readV1Settings(loadV1Export(exportSql));
  await assert.rejects(
    migrateSettings(v1, { now: NOW, reseal: async () => { throw new Error("cf-kms could not be reached"); } }),
    /connection openai \(p_direct\) of account org_a, its key: cf-kms could not be reached/u,
  );
  const partial = await migrateSettings(v1, { now: NOW, reseal: async () => { throw new SecretDoesNotOpen("decrypt failed"); } });
  assert.equal(partial.rows.provider_connection.length, 0);
  // A v1 vault file that lacks a key version is the file's fault, not the row's.
  const missing = vaultResealer({ SECRET_VAULT_MODE: "local", SECRET_VAULT_LOCAL_KEK_V1: kek() }, V2_VAULT);
  const blob = await secretVault({ SECRET_VAULT_MODE: "local", SECRET_VAULT_LOCAL_KEK_V1: kek(), SECRET_VAULT_LOCAL_KEK_V4: kek(), SECRET_VAULT_LOCAL_KEK_CURRENT_VERSION: "4" }).encryptSecret("x", { service: VAULT_SERVICE });
  await assert.rejects(missing(blob, { kind: "providerGatewayToken", identity: ["o", "g"] }, { kind: "cloudflareGatewayToken", identity: ["o", "c"] }), /v1's vault could not open a secret/u);
});

test("a Cloudflare AI Gateway row becomes the connection's own setting, with the token a live request opens", async () => {
  const edge = row("provider_connection", "p_cf")!;
  assert.equal(edge.secret_blob, null);
  const setting = JSON.parse(edge.cloudflare_gateway_json as string);
  assert.equal(setting.account_id, "abc123");
  assert.equal(setting.gateway_id, "my-gateway");
  assert.equal(setting.token_hint, "cf-…5555");
  assert.deepEqual(await credentials("p_cf"), { providerKey: null, cloudflareToken: CF_TOKEN });
  // v1 and v2 send its requests to the same Cloudflare URLs: they all move.
  assert.ok(config("ios-c3").routing.providers["openai-edge"].operations.includes("openai.chat"));
});

test("a row through Vercel AI Gateway becomes a Vercel connection, with v1's prefix put before every name (Sol 1, 4)", async () => {
  const vercel = row("provider_connection", "p_vercel")!;
  assert.equal(vercel.type, "vercel");
  assert.deepEqual(await credentials("p_vercel"), { providerKey: VERCEL_TOKEN, cloudflareToken: null });
  assert.equal(vercel.serving_providers_json, JSON.stringify(["bedrock"]));
  assert.ok(readFirst(said("connection claude-vercel", /put anthropic\/ before every model name/u, "changed")));
  assert.deepEqual(config("chat-a1").routing.providers["claude-vercel"], { operations: ["vercel.messages"], models: ["anthropic/claude-fable-5-2"] });
  assert.equal(config("chat-a1").presets.ask.model, "anthropic/claude-fable-5-2");
  assert.equal(config("chat-a1").presets.ask.operation, "vercel.messages");
  // A type v1 had no Vercel namespace for served nothing there.
  assert.equal(row("provider_connection", "p_vercel_groq"), undefined);
  said("connection groq-vercel", /v1 could not send a Groq row through Vercel AI Gateway/u, "left_out");
});

test("a Vercel route with no model list is left out: v1's prefix kept it to one namespace (Sol 2)", () => {
  assert.equal(config("ios-c3").routing.providers["claude-vercel"], undefined);
  said("app ios-c3", /On claude-vercel, the app had no model list\. v1 put anthropic\/ before every model/u, "left_out");
});

test("a rewrite only Vercel carries names the full model; a listed name the app rewrites stays as sent (Sol 4)", () => {
  const vercel = config("vercel-i9");
  assert.deepEqual(vercel.routing.model_rewrites, { fast: "anthropic/claude-fable-5-2" });
  assert.deepEqual(vercel.routing.providers["claude-vercel"].models, ["fast", "anthropic/claude-fable-5-2"]);
  said("app vercel-i9", /rewrite of fast to claude-fable-5-2 now names anthropic\/claude-fable-5-2/u, "changed");
  // Carried by Vercel and by a direct connection: one app-wide rewrite cannot name both, and the report says where it now fails.
  assert.deepEqual(config("mixed-j10").routing.model_rewrites, { fast: "claude-fable-5-2" });
  assert.ok(readFirst(said("app mixed-j10", /rewrite of fast to claude-fable-5-2 is carried by Vercel AI Gateway \(claude-vercel\).*Vercel now refuses it/u, "changed")));
});

test("allowed paths become operations, or passthrough paths judged by the console's rules", () => {
  const openai = config("chat-a1").routing.providers.openai;
  assert.deepEqual(new Set(openai.operations), new Set(["openai.chat", "openai.responses", "passthrough"]));
  assert.deepEqual(openai.models, ["gpt-6.2-sol"]);
  assert.equal(openai.max_output_tokens, 2048);
  said("app chat-a1", /v1beta\/models\/\{model\}:generateContent was not moved: it is Gemini's API/u, "left_out");
  said("app chat-a1", /passthrough path POST v1\/\{model\} was not moved/u, "left_out");
  const listed = JSON.parse(row("provider_connection", "p_direct")!.passthrough_json as string).paths as { method: string; path: string; set_fields?: unknown[] }[];
  assert.deepEqual(listed.map((one) => `${one.method} ${one.path}`).sort(), ["GET v1/files", "POST v1/batches", "POST v1/files", "POST v1/realtime/client_secrets"]);
  // A live-session token mint gets the safe defaults a new listing gets.
  assert.ok(listed.find((one) => one.path === "v1/realtime/client_secrets")!.set_fields!.length > 0);
  said("connection openai of account org_a", /v1\/realtime\/client_secrets mints a short-lived secret/u, "changed");
});

test("a {name} part other than {model} was literal text in v1, and is not turned into a wildcard (Fable 7)", () => {
  said("app chat-a1", /the path v1\/files\/\{file_id\} was not moved: v1 matched its \{file_id\} as that literal text/u, "left_out");
  const listed = JSON.parse(row("provider_connection", "p_direct")!.passthrough_json as string).paths as { path: string }[];
  assert.ok(!listed.some((one) => one.path.includes("{file_id}")));
});

test("fixed_model and clamp are reported where v2 behaves differently (Sol 7, Fable)", () => {
  assert.ok(readFirst(said("app chat-a1", /v1 used the model gpt-6\.2-sol for a request to v1\/responses that named none/u, "changed")));
  said("app chat-a1", /v1 capped output on v1\/chat\/completions in its anthropic field\. v2 caps openai\.chat in its chat-completion-tokens field/u, "changed");
});

test("a path one app listed is reported where another app on the connection can now reach it", () => {
  assert.ok(readFirst(said("connection openai of account org_a", /POST v1\/batches, listed in v1 by files-b2, can now be reached by chat-a1/u, "check")));
  said("connection openai of account org_a", /GET v1\/files, listed in v1 by chat-a1, can now be reached by files-b2/u, "check");
});

test("an exact path's model becomes the model list, and every difference from v1 is named (Sol 1)", () => {
  const gem = config("gem-g7").routing.providers.gem;
  assert.deepEqual(new Set(gem.operations), new Set(["gemini.generate.v1beta", "gemini.chat"]));
  assert.deepEqual(gem.models, ["gemini-2.5-flash"]);
  assert.ok(readFirst(said("app gem-g7", /v1 let gemini\.chat take any priced model.*now take only gemini-2\.5-flash/u, "changed")));
  // With a model list that holds more, the exact path's operation widens: said before applying.
  assert.deepEqual(config("gem-h8").routing.providers.gem.models, ["gemini-2.5-flash", "gemini-4-neon"]);
  assert.ok(readFirst(said("app gem-h8", /v1 let gemini\.generate\.v1beta take only gemini-2\.5-flash.*gemini-4-neon too/u, "check")));
});

test("a {model} that covers only part of the model name is left out (Sol 3)", () => {
  said("app gem-g7", /the path v1beta\/models\/gemini-\{model\}:streamGenerateContent was not moved: its \{model\} covers only part of the model name/u, "left_out");
  assert.ok(!config("gem-g7").routing.providers.gem.operations.includes("gemini.stream.v1beta"));
});

test("an empty path list reaches v1's defaults only, never a live session; lost styles and called paths are named (Fable 1, Sol 5)", () => {
  const proxy = config("chat-a1").routing.providers["openai-proxy"];
  assert.ok(proxy.operations.includes("openai.chat") && proxy.operations.includes("openai.images") && proxy.operations.includes("openai.speech"));
  assert.ok(!proxy.operations.includes("openai.realtime") && !proxy.operations.includes("passthrough"));
  said("app chat-a1", /On openai-proxy, v1 allowed its default API styles and OpenAI's own endpoints.*not openai\.realtime/u, "changed");
  // The row had a base URL: v1 sent Gemini-native calls there, and the app made some.
  said("app chat-a1", /On openai-proxy, v1 sent gemini_native requests to the connection's base URL/u, "left_out");
  said("app chat-a1", /On openai-proxy, v1's usage shows the app called v1beta\/models\/gemini-2\.5-flash:generateContent/u, "left_out");
  assert.ok(!lines("app chat-a1").some((line) => line.what.includes("called v1/chat/completions")), "a call v2 still serves is not listed");
});

test("all-mode reaches each moved connection as v1's defaults did, and names the ones left out (Fable 1, 2)", () => {
  const ios = config("ios-c3");
  assert.deepEqual(Object.keys(ios.routing.providers).sort(), ["claude", "gem", "groq", "openai", "openai-cfbase", "openai-edge", "openai-eu-plain", "openai-proxy"]);
  assert.ok(!ios.routing.providers.openai.operations.includes("openai.realtime"));
  said("app ios-c3", /v1 let it reach every connection of its account/u, "changed");
  said("app ios-c3", /It reached .*wrong-host.* in v1, which were not moved/u, "left_out");
  // On the provider's own host, or through Cloudflare, another provider's API style never answered in v1: nothing to report.
  for (const slug of ["claude", "openai-eu-plain"]) assert.ok(!lines("app ios-c3").some((line) => line.what.startsWith(`On ${slug}, v1 sent`)), slug);
  said("app ios-c3", /On openai-proxy, v1 sent gemini_native requests/u, "left_out");
  assert.equal(row("app", "ios-c3")!.status, "disabled");
});

test("an app's access to a connection left out is named on the app, which adding the connection back does not restore (Fable 2)", () => {
  assert.equal(config("chat-a1").routing.providers["wrong-host"], undefined);
  said("app chat-a1", /Its access to wrong-host was dropped with the connection.*allow wrong-host for the app again/u, "left_out");
  said("connection wrong-host", /Each app that allowed wrong-host loses it: see the app's own line/u, "left_out");
  said("app chat-a1", /It allowed ghost, which no connection of its account has/u, "changed");
});

// ---------------------------------------------------------------- presets, limits, keys

test("endpoints become presets on the operation that posts where v1 did; a fallback to a connection not moved is dropped (Sol, Gemini Neon 3)", () => {
  const presets = config("chat-a1").presets;
  assert.deepEqual(presets.summary, {
    provider: "openai",
    operation: "openai.responses",
    model: "gpt-6.2-sol",
    params: { temperature: 0 },
    max_output_tokens: 300,
    fallback: [{ provider: "claude-vercel", operation: "vercel.responses", model: "anthropic/claude-fable-5-2" }],
  });
  // v1 posted Groq transcriptions to openai/v1/audio/transcriptions: the operation that does too, named explicitly.
  assert.equal(presets.listen.operation, "groq.transcription.openai");
  assert.ok(readFirst(said("app chat-a1", /summary's fallback to gemini \(gemini-4-neon\) was dropped/u, "changed")));
});

test("budgets become nano-dollars, one above zero staying above zero; default scope and conversations are not written (Sol 7)", () => {
  const limits = config("chat-a1").limits;
  assert.deepEqual(limits.per_user, { requests: { per_minute: 10, per_day: null }, spending: { monthly_nano: 12_500_000_000 } });
  assert.deepEqual(limits.per_app, { requests: { per_minute: null, per_day: 1000 }, spending: { monthly_nano: 1 } });
  assert.deepEqual([budgetNano(null), budgetNano(0), budgetNano(0.0000000004), budgetNano(1.5)], [null, 0, 1, 1_500_000_000]);
  assert.deepEqual(config("chat-a1").conversations, { store: true, keep: { images: false, audio: true, files: true }, retention_days: 30 });
  assert.equal(config("files-b2").conversations, undefined);
  assert.equal(config("ios-c3").limits.per_user.spending.scope, undefined);
});

test("users v1 blocked, and accounts v1 refused, are read before applying (Fable 3, 4)", () => {
  assert.ok(readFirst(said("app chat-a1", /v1 blocked 2 users: they are not blocked in v2 until the history half/u, "check")));
  assert.ok(readFirst(said("accounts", /v1 refused while email verification was on/u, "check")));
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

// ---------------------------------------------------------------- output

test("every row fits v2's tables, and v2's save checks are run on each app", async () => {
  const judged = await checkAgainstV2(result, insertStatements(result.rows), V2_MIGRATIONS);
  // A model v2 has no price for still moves: it served in v1. The report says the console would refuse it.
  assert.ok(judged.some((line) => line.subject === "app chat-a1" && line.what.includes("made-up-model")));
  for (const line of judged) assert.equal(line.kind, "check");
  // The report never holds a secret.
  const text = JSON.stringify([...result.report, ...judged]);
  for (const secret of [...Object.values(KEY), CF_TOKEN, CF_TOKEN_2, VERCEL_TOKEN, OTHER_TOKEN, "ya29.made-up", "salt:hash"]) assert.ok(!text.includes(secret));
});

test("a row that does not fit names its table and id (Fable 8)", async () => {
  const doubled = insertStatements(result.rows);
  const first = doubled.find((statement) => statement.table === "app")!;
  await assert.rejects(checkAgainstV2(result, [...doubled, first], V2_MIGRATIONS), new RegExp(`the app row ${first.row} does not fit v2's tables`, "u"));
});

test("a text value with a NUL byte is written so SQLite reads it back whole (Sol 8, Gemini Neon 4)", () => {
  const rows = Object.fromEntries(TABLE_ORDER.map((name) => [name, [] as Row[]])) as V2Rows;
  rows.retired_app_id.push({ id: "it's\u0000odd", retired_at: 1 });
  const [statement] = insertStatements(rows);
  assert.match(statement!.sql, /CAST\(X'[0-9a-f]+' AS TEXT\)/u);
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE retired_app_id (id TEXT, retired_at INTEGER);");
  db.exec(statement!.sql);
  assert.equal((db.prepare("SELECT id FROM retired_app_id").get() as { id: string }).id, "it's\u0000odd");
});

test("the report starts with what to read before applying (Fable 5)", () => {
  const markdown = reportMarkdown(result.rows, result.report, NOW);
  const first = markdown.indexOf("## Read before applying");
  assert.ok(first !== -1 && first < markdown.indexOf("## Rows written"));
  const section = markdown.slice(first, markdown.indexOf("## Rows written"));
  for (const pattern of [/can now be reached by/u, /Not moved:/u, /put anthropic\/ before every model name/u]) assert.match(section, pattern);
});

test("the script reads an export and writes three files only its user can read, and says what to read first (Sol 6, Fable 5)", () => {
  const folder = mkdtempSync(join(tmpdir(), "agw-migrate-"));
  const vars = (env: Record<string, string>) => Object.entries(env).map(([name, value]) => `${name}=${value}`).join("\n");
  writeFileSync(join(folder, "v1.vars"), vars(V1_VAULT), { mode: 0o600 });
  writeFileSync(join(folder, "v2.vars"), vars(V2_VAULT), { mode: 0o600 });
  writeFileSync(join(folder, "export.sql"), exportSql);
  // A file already there with a wider mode is replaced, not written into.
  const out = join(folder, "out");
  spawnSync("mkdir", [out]);
  writeFileSync(join(out, "report.md"), "old", { mode: 0o644 });
  const temporary = mkdtempSync(join(tmpdir(), "agw-migrate-tmp-"));
  const run = spawnSync(
    process.execPath,
    ["--experimental-strip-types", join(V2_DIR, "scripts", "migrate-settings.ts"), "--from", "export.sql", "--out", "out", "--v1-vault", "v1.vars", "--v2-vault", "v2.vars", "--now", NOW.toISOString()],
    { cwd: folder, encoding: "utf8", env: { ...process.env, INIT_CWD: folder, TMPDIR: temporary } },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(readdirSync(temporary), [], "the copy of the export is deleted");
  for (const name of ["settings.sql", "report.md", "report.json"]) assert.equal(statSync(join(out, name)).mode & 0o777, 0o600, name);
  assert.deepEqual(readdirSync(out).sort(), ["report.json", "report.md", "settings.sql"], "no temporary file is left");
  const written = readFileSync(join(out, "settings.sql"), "utf8");
  assert.ok(written.includes("INSERT INTO app ") && written.includes("'chat-a1'"));
  const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8")) as { rows: Record<string, number>; report: { kind: string; read_first: boolean }[] };
  assert.equal(report.rows.app, table("app").length);
  assert.match(run.stdout, new RegExp(`Read before applying: ${report.report.filter((line) => line.read_first).length} lines`, "u"));
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

// ---------------------------------------------------------------- reading an export

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

test("an export is read a piece at a time: a statement cut anywhere, even inside a quote or a comment, loads whole (Fable 9)", async () => {
  const text = "CREATE TABLE t (a text); -- it's; a comment\nINSERT INTO t VALUES ('x;y'); /* a; b */ INSERT INTO t VALUES ('it''s');\n";
  for (const size of [1, 2, 3, 5, 8, 1000]) {
    const splitter = new StatementSplitter();
    const statements: string[] = [];
    for (let at = 0; at < text.length; at += size) statements.push(...splitter.push(text.slice(at, at + size)));
    assert.equal(statements.length, 3, `pieces of ${size}`);
    assert.equal(splitter.rest(), "");
  }
  const folder = mkdtempSync(join(tmpdir(), "agw-migrate-"));
  writeFileSync(join(folder, "export.sql"), text);
  const opened = await openV1Export(join(folder, "export.sql"));
  assert.deepEqual(opened.db.prepare("SELECT a FROM t").all().map((one) => one.a), ["x;y", "it's"]);
  opened.close();
  writeFileSync(join(folder, "cut.sql"), "CREATE TABLE t (a text); INSERT INTO t VALUES ('half");
  await assert.rejects(openV1Export(join(folder, "cut.sql")), /cut short/u);
});

test("a run that stops deletes its copy of the export, and a missing core table stops it (Fable 2, Sol 6, 7)", () => {
  const folder = mkdtempSync(join(tmpdir(), "agw-migrate-"));
  const vars = (env: Record<string, string>) => Object.entries(env).map(([name, value]) => `${name}=${value}`).join("\n");
  writeFileSync(join(folder, "v1.vars"), vars(V1_VAULT), { mode: 0o600 });
  writeFileSync(join(folder, "v2.vars"), vars(V2_VAULT), { mode: 0o600 });
  // An export cut before its provider tables: whole statements, but not a whole v1.
  writeFileSync(join(folder, "export.sql"), exportSql.replace(/CREATE TABLE `provider`[\s\S]*$/u, ""));
  const temporary = mkdtempSync(join(tmpdir(), "agw-migrate-tmp-"));
  const run = spawnSync(
    process.execPath,
    ["--experimental-strip-types", join(V2_DIR, "scripts", "migrate-settings.ts"), "--from", "export.sql", "--out", "out", "--v1-vault", "v1.vars", "--v2-vault", "v2.vars"],
    { cwd: folder, encoding: "utf8", env: { ...process.env, INIT_CWD: folder, TMPDIR: temporary } },
  );
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Nothing was written: the export has no .*provider.* table/u);
  assert.deepEqual(readdirSync(temporary), [], "the copy of the export, with its plain-text tokens, is deleted");
  assert.deepEqual(readdirSync(folder).sort(), ["export.sql", "v1.vars", "v2.vars"], "nothing was written");
  assert.ok(REQUIRED_TABLES.includes("provider"));
});

test("a real wrangler export of v1's schema loads whole with a trigger at any batch edge (Fable 1, Sol 5, Gemini Neon)", () => {
  // `fixtures/v1-schema.sql`: `wrangler d1 export --no-data` of v1's migrations, triggers last.
  const schema = readFileSync(join(V2_DIR, "scripts", "migrate", "fixtures", "v1-schema.sql"), "utf8");
  const firstTrigger = schema.indexOf("CREATE TRIGGER");
  const before = new StatementSplitter().push(schema.slice(0, firstTrigger)).length;
  for (const shift of [-2, -1, 0, 1, 2]) {
    // Padding rows, so the first trigger is the 499th, 500th or 501st statement: one batch ends inside it, or at it.
    const padding = Array.from({ length: 499 + shift - before - 1 }, (_, n) => `INSERT INTO "mgmt_verification" ("id","identifier","value","expires_at","created_at","updated_at") VALUES('v${n}','x','y',1,1,1);`).join("\n");
    const db = loadV1Export(`${schema.slice(0, firstTrigger)}${padding}\n${schema.slice(firstTrigger)}`);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger'").get() as { n: number }).n, 7, `shift ${shift}`);
  }
});

test("the splitter keeps a trigger whole, and reads bracket names and comments with ; inside (Sol 5)", () => {
  const text = "CREATE TABLE [odd;name] (a text); /* -- a; b */ CREATE TRIGGER t AFTER INSERT ON [odd;name] BEGIN UPDATE [odd;name] SET a = CASE WHEN 1 THEN ';' END; SELECT 1; END; INSERT INTO [odd;name] VALUES ('x');";
  for (const size of [1, 2, 4, 9, 1000]) {
    const splitter = new StatementSplitter();
    const statements: string[] = [];
    for (let at = 0; at < text.length; at += size) statements.push(...splitter.push(text.slice(at, at + size)));
    assert.equal(statements.length, 3, `pieces of ${size}`);
    assert.match(statements[1]!, /^ \/\* -- a; b \*\/ CREATE TRIGGER[\s\S]*SELECT 1; END;$/u);
  }
  const db = loadV1Export(text);
  assert.equal((db.prepare("SELECT a FROM [odd;name]").get() as { a: string }).a, ";");
});

test("the header says what the export holds in plain text (Fable 5)", () => {
  const header = readFileSync(join(V2_DIR, "scripts", "migrate-settings.ts"), "utf8");
  assert.match(header, /console session\s+\*\s+tokens and Google's sign-in tokens are in plain text/u);
});
