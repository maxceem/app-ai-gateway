import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  appleConfig,
  defaultProxyConfig,
  seedApp,
  serverConfig,
} from "./helpers";

const ORIGIN = "https://example.test";
const AUTH = { authorization: "Bearer agw_mgmt_test-admin-secret" };
const JSON_AUTH = { ...AUTH, "content-type": "application/json" };

async function get(path: string) {
  const response = await exports.default.fetch(`${ORIGIN}${path}`, { headers: AUTH });
  return { status: response.status, body: (await response.json()) as any };
}

async function recordUsage(
  appId: string,
  overrides: Partial<{
    user: string;
    provider: string;
    model: string;
    cost: number;
    status: string;
    createdAt: string;
    apiKeyId: string | null;
  }> = {},
) {
  const {
    user = "user-1",
    provider = "openai",
    model = "gpt-5.6-terra",
    cost = 0.02,
    status = "ok",
    createdAt = new Date().toISOString().slice(0, 19).replace("T", " "),
    apiKeyId = null,
  } = overrides;
  await env.DB.prepare(
    `INSERT INTO app_usage_event(
       app_id, user_id, provider_type, model, route, input_tokens,
       cached_input_tokens, cache_write_tokens, output_tokens, cost_usd, status, created_at,
       api_key_id
     ) VALUES (?, ?, ?, ?, ?, 10, 2, 1, 5, ?, ?, ?, ?)`,
  )
    .bind(appId, user, provider, model, `${provider}/v1/responses`, cost, status, createdAt, apiKeyId)
    .run();
}

describe("admin console API", () => {
  it("lists apps with month-to-date usage and user counts", async () => {
    await seedApp("list-apps");
    await env.DB.prepare("INSERT INTO app_user(app_id, id, status) VALUES (?, ?, ?)")
      .bind("list-apps", "user-1", "active")
      .run();
    await env.DB.prepare("INSERT INTO app_user(app_id, id, status) VALUES (?, ?, ?)")
      .bind("list-apps", "user-2", "blocked")
      .run();
    await recordUsage("list-apps");
    await recordUsage("list-apps", { cost: 0.03, model: "gpt-5.6-sol" });

    const { status, body } = await get("/v1/admin/apps");
    expect(status).toBe(200);
    const app = body.apps.find((row: any) => row.id === "list-apps");
    expect(app).toMatchObject({
      name: "Test list-apps",
      status: "active",
      users: { total: 2, blocked: 1 },
    });
    expect(app.providers.sort()).toEqual(["anthropic", "gemini", "openai", "xai"]);
    expect(app.usage).toMatchObject({
      requests: 2,
      input_tokens: 20,
      output_tokens: 10,
      cost_usd: 0.05,
    });
  });

  it("validates a candidate config without writing it", async () => {
    const valid = await exports.default.fetch(`${ORIGIN}/v1/admin/apps/validate-only/validate`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        name: "Validate only",
        config: appleConfig(
          { jwks_url: "https://issuer.test/jwks" },
          { proxy: defaultProxyConfig() },
        ),
      }),
    });
    expect(valid.status).toBe(200);
    await expect(valid.json()).resolves.toMatchObject({ valid: true, exists: false });

    const invalid = await exports.default.fetch(`${ORIGIN}/v1/admin/apps/validate-only/validate`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        name: "Validate only",
        config: appleConfig({ jwks_url: "http://issuer.test/jwks" }),
      }),
    });
    expect(invalid.status).toBe(400);

    expect((await get("/v1/admin/apps/validate-only")).status).toBe(404);
  });

  it("creates apps without overwriting id collisions and returns a server key once", async () => {
    await seedApp("calorie-tracker");

    const created = await exports.default.fetch(`${ORIGIN}/v1/admin/apps`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        id: "calorie-tracker",
        name: "Calorie Tracker",
        config: serverConfig(),
      }),
    });
    expect(created.status).toBe(201);
    const body = await created.json<{
      app_id: string;
      api_key: { id: string; key: string; key_prefix: string };
    }>();
    expect(body.app_id).toMatch(/^calorie-tracker-[a-z0-9]{4}$/u);
    expect(body.api_key.key).toMatch(/^agw_[0-9A-Za-z]{40,}$/u);
    expect(body.api_key.key_prefix).toBe(body.api_key.key.slice(0, 12));

    const original = await get("/v1/admin/apps/calorie-tracker");
    expect(original.body.app.name).toBe("Test calorie-tracker");

    const keyList = await get(`/v1/admin/apps/${body.app_id}/keys`);
    expect(keyList.body.keys).toEqual([
      expect.objectContaining({ id: body.api_key.id, name: "Default key", status: "active" }),
    ]);
    expect(JSON.stringify(keyList.body)).not.toContain(body.api_key.key);

    const defaultAccess = await get(`/v1/admin/apps/${body.app_id}`);
    expect(defaultAccess.body.resolved.routing.providerMode).toBe("all");
    const appList = await get("/v1/admin/apps");
    expect(
      appList.body.apps.find((app: any) => app.id === body.app_id).providers.sort(),
    ).toEqual(["anthropic", "gemini", "openai", "perplexity", "xai"]);
  });

  it("derives an id from the name when the create API receives no preferred id", async () => {
    const created = await exports.default.fetch(`${ORIGIN}/v1/admin/apps`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        name: "Café Companion iOS",
        config: appleConfig({ jwks_url: "https://issuer.test/.well-known/jwks.json" }),
      }),
    });
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      app_id: "cafe-companion-ios",
      api_key: null,
    });
  });

  it("returns a readable row plus the error when a stored config is invalid", async () => {
    await env.DB.prepare(
      `INSERT INTO app(id, organization_id, name, config_json, status)
       VALUES (?, 'operator-test-organization', ?, ?, 'active')`,
    )
      .bind("broken-config", "Broken", JSON.stringify({ authentication: {}, routing: {}, limits: {} }))
      .run();
    const { status, body } = await get("/v1/admin/apps/broken-config");
    expect(status).toBe(200);
    expect(body.resolved).toBeNull();
    expect(body.config_error).toContain("authentication.type");
    expect(body.app.name).toBe("Broken");
  });

  it("deletes an app only with confirmation and keeps its usage history", async () => {
    await seedApp("delete-me");
    await env.DB.prepare("INSERT INTO app_user(app_id, id, status) VALUES (?, ?, ?)")
      .bind("delete-me", "user-1", "active")
      .run();
    await recordUsage("delete-me");

    const unconfirmed = await exports.default.fetch(`${ORIGIN}/v1/admin/apps/delete-me`, {
      method: "DELETE",
      headers: AUTH,
    });
    expect(unconfirmed.status).toBe(400);

    const deleted = await exports.default.fetch(
      `${ORIGIN}/v1/admin/apps/delete-me?confirm=delete-me`,
      { method: "DELETE", headers: AUTH },
    );
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({ deleted: "delete-me", removed_users: 1 });
    expect((await get("/v1/admin/apps/delete-me")).status).toBe(404);

    const remaining = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM app_usage_event WHERE app_id = ?",
    )
      .bind("delete-me")
      .first<{ count: number }>();
    expect(remaining?.count).toBe(1);
  });

  it("lists users with month-to-date usage and supports search", async () => {
    await seedApp("user-list");
    for (const id of ["alpha-user", "beta-user"]) {
      await env.DB.prepare("INSERT INTO app_user(app_id, id, status) VALUES (?, ?, 'active')")
        .bind("user-list", id)
        .run();
    }
    await recordUsage("user-list", { user: "alpha-user" });
    await recordUsage("user-list", { user: "server-attributed-user" });

    const all = await get("/v1/admin/apps/user-list/users");
    expect(all.body.total).toBe(3);
    expect(all.body.users.find((row: any) => row.id === "alpha-user").usage.requests).toBe(1);
    expect(all.body.users.find((row: any) => row.id === "beta-user").usage.requests).toBe(0);
    expect(all.body.users.find((row: any) => row.id === "server-attributed-user")).toMatchObject({
      status: "active",
      is_virtual: true,
      attest_registered: false,
      usage: { requests: 1 },
    });

    const filtered = await get("/v1/admin/apps/user-list/users?query=alpha");
    expect(filtered.body.total).toBe(1);
    expect(filtered.body.users[0].id).toBe("alpha-user");
  });

  it("groups usage by day and by dimension, and pages the event feed", async () => {
    await seedApp("usage-shapes");
    const today = new Date().toISOString().slice(0, 10);
    await recordUsage("usage-shapes", {
      provider: "openai",
      createdAt: `${today} 01:00:00`,
      apiKeyId: "key_usage-shapes",
    });
    await recordUsage("usage-shapes", { provider: "anthropic", model: "claude-sonnet-5", createdAt: `${today} 02:00:00` });
    await recordUsage("usage-shapes", { provider: "openai", status: "provider_error", createdAt: `${today} 03:00:00` });

    const series = await get(`/v1/admin/apps/usage-shapes/usage/timeseries?from=${today}&to=${today}`);
    expect(series.status).toBe(200);
    expect(series.body.buckets).toHaveLength(2);
    expect(series.body.buckets.every((bucket: any) => bucket.date === today)).toBe(true);

    const byProvider = await get(`/v1/admin/apps/usage-shapes/usage/breakdown?by=provider&from=${today}&to=${today}`);
    const openai = byProvider.body.rows.find((row: any) => row.key === "openai");
    expect(openai).toMatchObject({ requests: 2, errors: 1 });

    const rejected = await get("/v1/admin/apps/usage-shapes/usage/breakdown?by=nonsense");
    expect(rejected.status).toBe(400);

    const firstPage = await get("/v1/admin/apps/usage-shapes/events?limit=2");
    expect(firstPage.body.events).toHaveLength(2);
    expect(firstPage.body.next_before_id).toBe(firstPage.body.events[1].id);
    const secondPage = await get(
      `/v1/admin/apps/usage-shapes/events?limit=2&before_id=${firstPage.body.next_before_id}`,
    );
    expect(secondPage.body.events).toHaveLength(1);
    expect(secondPage.body.events[0].id).toBeLessThan(firstPage.body.next_before_id);

    const errors = await get("/v1/admin/apps/usage-shapes/events?status=provider_error");
    expect(errors.body.events).toHaveLength(1);
    const attributed = [...firstPage.body.events, ...secondPage.body.events]
      .find((event: any) => event.api_key_id !== null);
    expect(attributed?.api_key_id).toBe("key_usage-shapes");
  });

  // The console's issuer presets generate exactly these shapes. If the config
  // parser stops accepting them, every preset silently breaks.
  it("accepts the auth configs the console issuer presets generate", async () => {
    const presets = {
      firebase: {
        jwks_url:
          "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
        user_id_claim: "sub",
        required_claims: [
          { path: "aud", equals: "my-app-1a2b3" },
          { path: "iss", equals: "https://securetoken.google.com/my-app-1a2b3" },
          { path: "entitlements", contains: "pro" },
        ],
      },
      supabase: {
        jwks_url: "https://abcdefghijklmnop.supabase.co/auth/v1/.well-known/jwks.json",
        user_id_claim: "sub",
        required_claims: [
          { path: "iss", equals: "https://abcdefghijklmnop.supabase.co/auth/v1" },
          { path: "aud", contains: "authenticated" },
        ],
      },
      auth0: {
        jwks_url: "https://my-tenant.us.auth0.com/.well-known/jwks.json",
        user_id_claim: "sub",
        required_claims: [
          { path: "iss", equals: "https://my-tenant.us.auth0.com/" },
          { path: "aud", contains: "https://api.my-app.com" },
        ],
      },
      clerk: {
        jwks_url: "https://clean-mayfly-62.clerk.accounts.dev/.well-known/jwks.json",
        user_id_claim: "sub",
        required_claims: [{ path: "iss", equals: "https://clean-mayfly-62.clerk.accounts.dev" }],
      },
    };

    for (const [preset, issuer] of Object.entries(presets)) {
      const response = await exports.default.fetch(
        `${ORIGIN}/v1/admin/apps/preset-${preset}/validate`,
        {
          method: "POST",
          headers: JSON_AUTH,
          body: JSON.stringify({
            name: `Preset ${preset}`,
            config: appleConfig(issuer),
          }),
        },
      );
      expect(response.status, `${preset} preset must validate`).toBe(200);
    }
  });

  it("serves the price table for model pickers", async () => {
    const { status, body } = await get("/v1/admin/prices");
    expect(status).toBe(200);
    expect(body.prices.openai["gpt-5.4-mini"]).toMatchObject({
      input: 0.75,
      cached_input: 0.075,
      output: 4.5,
    });
    expect(body.prices.anthropic["claude-opus-5"]).toMatchObject({
      input: expect.any(Number),
    });
  });
});
