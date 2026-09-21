import { env, exports } from "cloudflare:workers";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { clearAppConfigCache, loadApp } from "../src/core/config";
import {
  clearProviderCaches,
  organizationProviders,
} from "../src/core/provider-store";
import { PROVIDER_TYPES } from "../src/core/providers";
import { database } from "../src/db";
import type { AdminVariables } from "../src/middleware/admin";
import { appRoutes } from "../src/routes/admin/apps";
import {
  appleConfig,
  defaultProxyConfig,
  seedApp,
  seedProvider,
  seedServerApp,
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
    providerSlug: string;
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
    providerSlug = provider,
    model = "gpt-5.6-terra",
    cost = 0.02,
    status = "ok",
    createdAt = new Date().toISOString().slice(0, 19).replace("T", " "),
    apiKeyId = null,
  } = overrides;
  await env.DB.prepare(
    `INSERT INTO app_usage_event(
       app_id, user_id, provider_type, provider_slug, model, route, input_tokens,
       cached_input_tokens, cache_write_tokens, output_tokens, cost_usd, status, created_at,
       api_key_id
     ) VALUES (?, ?, ?, ?, ?, ?, 10, 2, 1, 5, ?, ?, ?, ?)`,
  )
    .bind(appId, user, provider, providerSlug, model, `${providerSlug}/v1/responses`, cost, status, createdAt, apiKeyId)
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

  /**
   * The list is where an operator sees the month's spend, so it carries what
   * that spend is measured against. An app that set no budget reports `null`,
   * which is unlimited everywhere in limits — not zero.
   */
  it("reports the app's own monthly budget, and null when it has none", async () => {
    await seedApp("list-apps-budget", { appBudgetUsd: 25 });
    await seedApp("list-apps-no-budget");

    const { body } = await get("/v1/admin/apps");
    const budgeted = body.apps.find((row: any) => row.id === "list-apps-budget");
    const unlimited = body.apps.find((row: any) => row.id === "list-apps-no-budget");

    expect(budgeted.monthly_budget_usd).toBe(25);
    expect(unlimited.monthly_budget_usd).toBeNull();
  });

  /**
   * `providers` answers "what can this app reach", so an all-mode app loses a
   * paused slug from it. `referenced_providers` answers a different question —
   * "which apps name this slug outright" — which is what the console needs to
   * warn before a disable or a delete, and which an all-mode app answers with
   * nothing at all rather than with every instance the organization owns.
   */
  it("reports referenced provider slugs and drops disabled ones from all-mode reach", async () => {
    await seedProvider({ type: "openai", id: "listed-openai-paused", slug: "openai-paused" });
    await seedProvider({ type: "openai", id: "listed-openai-named", slug: "openai-named" });
    clearProviderCaches();
    await seedApp("list-apps-all", { proxy: {} });
    await seedApp("list-apps-named", {
      proxy: {
        "openai-named": { allowed_paths: ["v1/responses"], allowed_models: ["gpt-5.6-sol"] },
      },
      endpoints: {
        chat: {
          api_style: "responses",
          provider: "openai-paused",
          model: "gpt-5.6-luna",
          fallback: [{ provider: "openai", model: "gpt-5.6-luna" }],
        },
      },
    });
    await env.DB
      .prepare("UPDATE provider SET status = 'disabled' WHERE id = 'listed-openai-paused'")
      .run();
    clearProviderCaches();

    const { body } = await get("/v1/admin/apps");
    const allMode = body.apps.find((row: any) => row.id === "list-apps-all");
    const named = body.apps.find((row: any) => row.id === "list-apps-named");

    expect(allMode.providers).not.toContain("openai-paused");
    expect(allMode.providers).toContain("openai-named");
    // Reaching everything is not naming anything.
    expect(allMode.referenced_providers).toEqual([]);

    // Policy keys, endpoint targets, and endpoint fallbacks alike.
    expect([...named.referenced_providers].sort())
      .toEqual(["openai", "openai-named", "openai-paused"]);

    await env.DB.prepare(
      "DELETE FROM provider WHERE id IN ('listed-openai-paused', 'listed-openai-named')",
    ).run();
    clearProviderCaches();
  });

  /**
   * A disabled instance still exists, so configuration may keep naming it —
   * otherwise pausing an instance would lock every app that uses it out of
   * every unrelated edit until it came back.
   */
  it("saves an app configuration that references a disabled provider instance", async () => {
    await seedProvider({
      type: "openai",
      id: "app-save-paused",
      slug: "openai-app-paused",
      status: "disabled",
    });
    clearProviderCaches();

    const config = serverConfig({
      proxy: {
        "openai-app-paused": { allowed_paths: ["v1/responses"], allowed_models: ["gpt-5.6-sol"] },
      },
    });
    const created = await exports.default.fetch(`${ORIGIN}/v1/admin/apps`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ name: "On a paused instance", config }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const { app: createdApp } = await created.json<{ app: { id: string } }>();
    const createdId = createdApp.id;

    await env.DB.prepare("DELETE FROM app_api_key WHERE app_id = ?").bind(createdId).run();
    await env.DB.prepare("DELETE FROM app WHERE id = ?").bind(createdId).run();
    await env.DB.prepare("DELETE FROM provider WHERE id = 'app-save-paused'").run();
    clearProviderCaches();
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

    const unknownProvider = await exports.default.fetch(
      `${ORIGIN}/v1/admin/apps/validate-only/validate`,
      {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({
          name: "Validate only",
          config: appleConfig(
            { jwks_url: "https://issuer.test/jwks" },
            {
              proxy: {
                "missing-instance": {
                  allowed_paths: ["v1/responses"],
                  allowed_models: ["gpt-5.6-sol"],
                },
              },
            },
          ),
        }),
      },
    );
    expect(unknownProvider.status).toBe(400);
    await expect(unknownProvider.json()).resolves.toMatchObject({
      error: { code: "invalid_request", message: "Unknown provider instance missing-instance" },
    });

    expect((await get("/v1/admin/apps/validate-only")).status).toBe(404);
  });

  // Deleting a provider must not brick every later edit of an app that still
  // names its slug; only newly introduced slugs have to exist.
  it("keeps editing an app whose stored provider instance was deleted", async () => {
    const appId = "grandfathered-slug";
    await seedProvider({ type: "openai", id: "grandfathered-openai-dev", slug: "openai-dev" });
    clearProviderCaches();
    // PUT only ever updates, so the row this test edits has to exist first.
    await seedApp(appId, { proxy: { "openai-dev": { allowed_paths: ["v1/responses"], allowed_models: ["gpt-5.6-sol"] } } });
    const config = (extra: Record<string, unknown> = {}) => serverConfig({
      proxy: {
        "openai-dev": { allowed_paths: ["v1/responses"], allowed_models: ["gpt-5.6-sol"] },
        ...extra,
      },
    });
    const put = async (name: string, body: Record<string, unknown>) => {
      const current = await get(`/v1/admin/apps/${appId}`);
      return exports.default.fetch(`${ORIGIN}/v1/admin/apps/${appId}`, {
        method: "PUT", headers: JSON_AUTH,
        body: JSON.stringify({ name, config: body, revision: current.body.app.revision }),
      });
    };

    expect((await put("Grandfathered", config())).status).toBe(200);
    await env.DB.prepare("DELETE FROM provider WHERE id = 'grandfathered-openai-dev'").run();
    clearProviderCaches();

    // An unrelated edit still saves, and validate agrees with the write.
    const renamed = await put("Grandfathered renamed", config());
    expect(renamed.status).toBe(200);
    const validated = await exports.default.fetch(`${ORIGIN}/v1/admin/apps/${appId}/validate`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ name: "Grandfathered renamed", config: config() }),
    });
    expect(validated.status).toBe(200);

    // A slug the stored configuration never named is still refused.
    const introduced = await put("Grandfathered renamed", config({
      "openai-staging": { allowed_paths: ["v1/responses"], allowed_models: ["gpt-5.6-sol"] },
    }));
    expect(introduced.status).toBe(400);
    await expect(introduced.json()).resolves.toMatchObject({
      error: { message: "Unknown provider instance openai-staging" },
    });

    // Creating a brand-new app on a dangling slug stays strict.
    const created = await exports.default.fetch(`${ORIGIN}/v1/admin/apps`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ name: "Grandfathered new", config: config() }),
    });
    expect(created.status).toBe(400);
  });

  it("suffixes a generated id even when the stem is free", async () => {
    const created = await exports.default.fetch(`${ORIGIN}/v1/admin/apps`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ name: "Unclaimed Name", config: serverConfig() }),
    });
    expect(created.status).toBe(201);
    const { app: createdApp } = await created.json<{ app: { id: string } }>();
    const appId = createdApp.id;
    // Nothing held `unclaimed-name`, and it is still not what was created: the
    // suffix is the format, not a collision repair.
    expect(appId).toMatch(/^unclaimed-name-[0-9abcdefghjkmnpqrstvwxyz]{12}$/u);
    expect((await get(`/v1/admin/apps/${appId}`)).status).toBe(200);
    expect((await get("/v1/admin/apps/unclaimed-name")).status).toBe(404);
  });

  it("refuses a body that names an id, and says who assigns it", async () => {
    const created = await exports.default.fetch(`${ORIGIN}/v1/admin/apps`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ id: "chosen-id", name: "Chosen Id", config: serverConfig() }),
    });
    expect(created.status).toBe(400);
    await expect(created.json()).resolves.toMatchObject({
      error: {
        code: "invalid_request",
        message: "id is assigned by the server: omit it and read app.id from the response",
      },
    });

    // Nothing was created, under the asked-for id or any other.
    expect((await get("/v1/admin/apps/chosen-id")).status).toBe(404);
    const listed = (await get("/v1/admin/apps")).body.apps as Array<{ id: string }>;
    expect(listed.filter((row) => row.id.startsWith("chosen-id"))).toHaveLength(0);
  });

  it("updates through PUT but never creates: an unknown id is a 404", async () => {
    const body = JSON.stringify({ name: "Bare Id", config: serverConfig() });
    const missing = await exports.default.fetch(`${ORIGIN}/v1/admin/apps/bare-id`, {
      method: "PUT",
      headers: JSON_AUTH,
      body,
    });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: "app_not_found" },
    });
    // The refusal wrote nothing: the id is still free of any row.
    const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM app WHERE id = ?")
      .bind("bare-id")
      .first<{ count: number }>();
    expect(row?.count).toBe(0);

    await seedServerApp("put-updates-me");
    const updated = await exports.default.fetch(`${ORIGIN}/v1/admin/apps/put-updates-me`, {
      method: "PUT",
      headers: JSON_AUTH,
      body: JSON.stringify({ name: "Renamed", config: serverConfig(), revision: 1 }),
    });
    expect(updated.status, await updated.clone().text()).toBe(200);
    // An update answers with the same object a read does, already renamed.
    const updatedBody = await updated.json<{ app: { id: string; name: string }; config_error: null }>();
    expect(updatedBody.app.id).toBe("put-updates-me");
    expect(updatedBody.app.name).toBe("Renamed");
    expect(updatedBody.config_error).toBeNull();
    expect((await get("/v1/admin/apps/put-updates-me")).body.app).toEqual(updatedBody.app);
  });

  it("assigns the id from the name, and returns a server key once", async () => {
    await seedApp("calorie-tracker");

    const created = await exports.default.fetch(`${ORIGIN}/v1/admin/apps`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        name: "Calorie Tracker",
        config: serverConfig(),
      }),
    });
    expect(created.status).toBe(201);
    const body = await created.json<{
      app: {
        id: string;
        name: string;
        status: string;
        created_at: string;
        updated_at: string;
        config: { routing: { providers: { mode: string } } };
      };
      config_error: string | null;
      api_key: { id: string; key: string; key_prefix: string };
    }>();
    expect(body.app.id).toMatch(/^calorie-tracker-[0-9abcdefghjkmnpqrstvwxyz]{12}$/u);
    expect(body.api_key.key).toMatch(/^agw_[0-9A-Za-z]{40,}$/u);
    expect(body.api_key.key_prefix).toBe(body.api_key.key.slice(0, 12));

    // A create answers with the application, in the shape a read answers with.
    const readBack = await get(`/v1/admin/apps/${body.app.id}`);
    expect(body.app).toEqual(readBack.body.app);
    expect(body.config_error).toBeNull();

    const original = await get("/v1/admin/apps/calorie-tracker");
    expect(original.body.app.name).toBe("Test calorie-tracker");

    const keyList = await get(`/v1/admin/apps/${body.app.id}/keys`);
    expect(keyList.body.keys).toEqual([
      expect.objectContaining({ id: body.api_key.id, name: "Default key", status: "active" }),
    ]);
    expect(JSON.stringify(keyList.body)).not.toContain(body.api_key.key);

    // Stored is resolved: the response carries the configuration itself, and
    // there is no second view of it to compare against.
    expect(body.app.config.routing.providers.mode).toBe("all");
    const appList = await get("/v1/admin/apps");
    // The fixture configures one instance of every provider type, and an
    // all-providers app reaches all of them.
    expect(
      appList.body.apps.find((app: any) => app.id === body.app.id).providers.sort(),
    ).toEqual([...PROVIDER_TYPES].sort());
  });

  it("derives the readable stem of an assigned id from the name", async () => {
    const created = await exports.default.fetch(`${ORIGIN}/v1/admin/apps`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        name: "Café Companion iOS",
        config: appleConfig({ jwks_url: "https://issuer.test/.well-known/jwks.json" }),
      }),
    });
    expect(created.status).toBe(201);
    const body = await created.json<{ app: { id: string }; api_key: null }>();
    expect(body.app.id).toMatch(/^cafe-companion-ios-[0-9abcdefghjkmnpqrstvwxyz]{12}$/u);
    expect(body.api_key).toBeNull();
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
    // Returned as it is stored, so the repair editor has something to open.
    expect(body.app.config).toEqual({ authentication: {}, routing: {}, limits: {} });
    expect(body.config_error).toContain("authentication.type");
    expect(body.app.name).toBe("Broken");
  });

  it("deletes an app only with confirmation, keeping usage but not auth history", async () => {
    await seedApp("delete-me");
    await env.DB.prepare("INSERT INTO app_user(app_id, id, status) VALUES (?, ?, ?)")
      .bind("delete-me", "user-1", "active")
      .run();
    await env.DB.prepare(
      "INSERT INTO app_auth_event(app_id, event, outcome) VALUES (?, 'token_exchange', 'ok')",
    )
      .bind("delete-me")
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
    await expect(deleted.json()).resolves.toEqual({
      deleted: true,
      app_id: "delete-me",
      removed_users: 1,
      usage_events_retained: true,
    });
    expect((await get("/v1/admin/apps/delete-me")).status).toBe(404);

    // Usage is billing history and is kept; authentication history is
    // diagnostic, unreachable once the app is gone, and goes with it. Leaving
    // it behind would strand rows that no account purge could ever find.
    const counted = async (table: string) =>
      (await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE app_id = ?`)
        .bind("delete-me")
        .first<{ count: number }>())?.count;
    expect(await counted("app_usage_event")).toBe(1);
    expect(await counted("app_auth_event")).toBe(0);
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
    await recordUsage("usage-shapes", {
      provider: "openai",
      providerSlug: "openai-dev",
      status: "provider_error",
      createdAt: `${today} 03:00:00`,
    });

    const series = await get(`/v1/admin/apps/usage-shapes/usage/timeseries?from=${today}&to=${today}`);
    expect(series.status).toBe(200);
    expect(series.body.buckets).toHaveLength(2);
    expect(series.body.buckets.every((bucket: any) => bucket.date === today)).toBe(true);

    const byProvider = await get(`/v1/admin/apps/usage-shapes/usage/breakdown?by=provider&from=${today}&to=${today}`);
    const openai = byProvider.body.rows.find((row: any) => row.key === "openai");
    expect(openai).toMatchObject({ requests: 2, errors: 1 });

    const bySlug = await get(`/v1/admin/apps/usage-shapes/usage/breakdown?by=provider_slug&from=${today}&to=${today}`);
    expect(bySlug.body.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "openai", requests: 1 }),
      expect.objectContaining({ key: "openai-dev", requests: 1, errors: 1 }),
    ]));

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
    expect(firstPage.body.events.some((event: any) => event.provider_slug === "openai-dev")).toBe(true);
  });

  // The console's issuer presets generate exactly these shapes. If the config
  // parser stops accepting them, every preset silently breaks.
  it("accepts the auth configs the console issuer presets generate", async () => {
    const presets = {
      firebase: {
        jwks_url:
          "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
        issuer: "https://securetoken.google.com/my-app-1a2b3",
        audience: "my-app-1a2b3",
        user_id_claim: "sub",
        required_claims: [{ path: "revenueCatEntitlements", contains: "pro" }],
        entitlement: "revenuecat",
      },
      supabase: {
        jwks_url: "https://abcdefghijklmnop.supabase.co/auth/v1/.well-known/jwks.json",
        issuer: "https://abcdefghijklmnop.supabase.co/auth/v1",
        audience: "authenticated",
        user_id_claim: "sub",
        required_claims: [],
      },
      auth0: {
        jwks_url: "https://my-tenant.us.auth0.com/.well-known/jwks.json",
        issuer: "https://my-tenant.us.auth0.com/",
        audience: "https://api.my-app.com",
        user_id_claim: "sub",
        required_claims: [],
      },
      clerk: {
        jwks_url: "https://clean-mayfly-62.clerk.accounts.dev/.well-known/jwks.json",
        issuer: "https://clean-mayfly-62.clerk.accounts.dev",
        audience: "my-app",
        user_id_claim: "sub",
        required_claims: [],
      },
    };

    for (const [preset, issuer] of Object.entries(presets)) {
      const response = await exports.default.fetch(
        `${ORIGIN}/v1/admin/apps/preset-${preset}/validate`,
        {
          method: "POST",
          headers: JSON_AUTH,
          // The console names the preset it wrote the block with, so the form
          // it reopens is the one that was filled in.
          body: JSON.stringify({
            name: `Preset ${preset}`,
            config: appleConfig({ ...issuer, provider: preset }),
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


describe("application conditional writes", () => {
  it("requires the revision it was read at and rejects a stale edit without overwriting", async () => {
    const appId = "conditional-edit";
    await seedServerApp(appId);
    const read = await get(`/v1/admin/apps/${appId}`);
    expect(read.body.app.revision).toBe(1);
    // The revision travels in the resource and nowhere else. No ETag is
    // published: a CDN rewrites that header when it compresses, and a browser
    // cannot read it cross-origin unless the server exposes it.
    const response = await exports.default.fetch(`${ORIGIN}/v1/admin/apps/${appId}`, { headers: AUTH });
    expect(response.headers.get("etag")).toBeNull();
    const update = (revision?: number) => exports.default.fetch(`${ORIGIN}/v1/admin/apps/${appId}`, {
      method: "PUT",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ name: "Edited", config: serverConfig(), ...(revision === undefined ? {} : { revision }) }),
    });
    const blind = await update();
    expect(blind.status).toBe(400);
    await expect(blind.json()).resolves.toMatchObject({ error: { code: "app_revision_required" } });
    expect((await update(1)).status).toBe(200);
    const stale = await update(1);
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({ error: { code: "app_revision_conflict" } });
    const latest = await get(`/v1/admin/apps/${appId}`);
    expect(latest.body.app.revision).toBe(2);
    expect(latest.body.app.name).toBe("Edited");
  });
});

describe("authoritative admin configuration", () => {
  const appIds = [
    "admin-primary-get",
    "admin-primary-put",
    "admin-primary-key-mode",
  ];
  const providerId = "admin-primary-provider-pricing";

  afterEach(async () => {
    const placeholders = appIds.map(() => "?").join(", ");
    await env.DB.prepare(`DELETE FROM app_api_key WHERE app_id IN (${placeholders})`)
      .bind(...appIds)
      .run();
    await env.DB.prepare(`DELETE FROM app WHERE id IN (${placeholders})`)
      .bind(...appIds)
      .run();
    await env.DB.prepare("DELETE FROM provider WHERE id = ?").bind(providerId).run();
    clearAppConfigCache();
    clearProviderCaches();
  });

  it("resolves GET from its scoped primary row while the runtime cache is stale", async () => {
    const appId = "admin-primary-get";
    await seedApp(appId);
    const cached = await loadApp(env, appId);
    expect(cached.config.authentication.type).toBe("apple_app_attest");

    await env.DB.prepare(
      "UPDATE app SET name = ?, config_json = ?, status = 'disabled' WHERE id = ?",
    ).bind("Current primary row", JSON.stringify(serverConfig()), appId).run();

    const current = await get(`/v1/admin/apps/${appId}`);
    expect(current.status).toBe(200);
    expect(current.body.app).toMatchObject({
      name: "Current primary row",
      status: "disabled",
      config: { authentication: { type: "api_key" } },
    });
    // The admin response did not refresh or consult the still-stale runtime cache.
    await expect(loadApp(env, appId)).resolves.toMatchObject({
      name: `Test ${appId}`,
      status: "active",
      config: { authentication: { type: "apple_app_attest" } },
    });
    clearAppConfigCache();
  });

  it("resolves PUT from the row returned by its write with a warm runtime cache", async () => {
    const appId = "admin-primary-put";
    await seedApp(appId);
    await expect(loadApp(env, appId)).resolves.toMatchObject({
      config: { authentication: { type: "apple_app_attest" } },
    });

    const scopedRow = await database(env.DB).query.app.findFirst({
      where: (app, { eq }) => eq(app.id, appId),
    });
    expect(scopedRow).toBeDefined();
    let sessionCalls = 0;
    const primaryOnly = {
      prepare: (query: string) => env.DB.prepare(query),
      batch: <T = unknown>(statements: D1PreparedStatement[]) => env.DB.batch<T>(statements),
      exec: (query: string) => env.DB.exec(query),
      withSession: () => {
        sessionCalls += 1;
        throw new Error("PUT attempted to reread its write through a replica session");
      },
    } as unknown as D1Database;
    const requestEnv = new Proxy(env, {
      get: (target, property, receiver) =>
        property === "DB" ? primaryOnly : Reflect.get(target, property, receiver),
    }) as Env;
    const route = new Hono<{ Bindings: Env; Variables: AdminVariables }>();
    route.use("*", async (c, next) => {
      c.set("billingRequestCache", new Map());
      c.set("admin", {
        userId: "operator-test-owner",
        identityKind: "service",
        credentialId: "test-management-key",
        organizationId: "operator-test-organization",
        role: "owner",
        credentialType: "apiKey",
      });
      c.set("adminApp", scopedRow);
      await next();
    });
    route.route("/", appRoutes);

    const response = await route.request(`/apps/${appId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        revision: 1,
        name: "Written primary row",
        status: "disabled",
        config: serverConfig(),
      }),
    }, requestEnv);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      app: {
        name: "Written primary row",
        status: "disabled",
        revision: 2,
        config: { authentication: { type: "api_key" } },
      },
      config_error: null,
    });
    expect(sessionCalls).toBe(0);
  });

  it("uses the scoped primary row when deciding whether an app can create API keys", async () => {
    const appId = "admin-primary-key-mode";
    await seedApp(appId);
    await loadApp(env, appId);
    // `auth_type` travels with the configuration it is lifted from, which is
    // what the key routes read: they ask what kind of application this is, not
    // what its whole configuration says.
    await env.DB.prepare("UPDATE app SET config_json = ?, auth_type = 'api_key' WHERE id = ?")
      .bind(JSON.stringify(serverConfig()), appId)
      .run();

    const response = await exports.default.fetch(`${ORIGIN}/v1/admin/apps/${appId}/keys`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ name: "Primary mode key" }),
    });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ name: "Primary mode key" });
    clearAppConfigCache();
  });

  it("validates provider pricing from current rows despite a stale runtime cache", async () => {
    const providerSlug = "admin-primary-provider-pricing";
    const model = "admin-primary-custom-model";
    await seedProvider({
      type: "openai",
      id: providerId,
      slug: providerSlug,
      pricing: { [model]: { input: 1, output: 2 } },
    });
    expect((await organizationProviders(env, "operator-test-organization"))[providerSlug]?.pricing)
      .toHaveProperty(model);
    await env.DB.prepare("UPDATE provider SET pricing_json = NULL WHERE id = ?")
      .bind(providerId)
      .run();
    // The runtime cache intentionally retains its TTL; management must bypass it.
    expect((await organizationProviders(env, "operator-test-organization"))[providerSlug]?.pricing)
      .toHaveProperty(model);

    const response = await exports.default.fetch(
      `${ORIGIN}/v1/admin/apps/admin-primary-provider-validate/validate`,
      {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({
          name: "Current provider pricing",
          config: serverConfig({
            proxy: {
              [providerSlug]: {
                allowed_paths: ["v1/responses"],
                allowed_models: [model],
              },
            },
          }),
        }),
      },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining("has no configured price") },
    });
  });
});
