/**
 * Step 1d, the rest of the management API: app PATCH, validate and check,
 * end users, the price list, the provider key test, and the plan ceilings
 * checked when settings are created.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { billingPlanLimits } from "../src/billing/access.ts";
import { CUSTOM_PATH_STYLES } from "../src/contracts/admin.ts";
import { BUILT_IN_PROVIDERS } from "../src/providers/index.ts";
import { ACCOUNT_ID, clearCaches, seedManagementKey, LOAD_MANAGEMENT_TIMEOUT_MS, loadManagement, ledger } from "./helpers.ts";

beforeAll(loadManagement, LOAD_MANAGEMENT_TIMEOUT_MS);

const ORIGIN = "https://gateway.test";

async function request(key: string | null, method: string, path: string, body?: unknown, environment: Env = env) {
  const headers = new Headers({ "content-type": "application/json" });
  if (key !== null) headers.set("authorization", `Bearer ${key}`);
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${ORIGIN}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    environment,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { status: response.status, headers: response.headers, body: (await response.json()) as Record<string, any> };
}

const apiKeyConfig = (routing: Record<string, unknown> = {}, endUser: Record<string, unknown> = { source: "none" }) => ({
  authentication: { type: "api_key", end_user: endUser },
  routing: { providers: routing },
});

async function createProvider(key: string, overrides: Record<string, unknown> = {}, environment: Env = env) {
  return request(
    key,
    "POST",
    "/v2/admin/providers",
    { type: "openai", name: "OpenAI", slug: `openai-${crypto.randomUUID().slice(0, 6)}`, secret: "sk-live-secret-abcd", ...overrides },
    environment,
  );
}

async function createApp(key: string, config: unknown = apiKeyConfig(), environment: Env = env) {
  return request(key, "POST", "/v2/admin/apps", { name: "Mgmt", config }, environment);
}

/** An environment whose billing service answers with a plan of these limits, or fails. */
function hosted(limits: Record<string, unknown> | null | "down"): Env {
  return {
    ...env,
    BILLING: {
      getTenantAccess: async () => {
        if (limits === "down") throw new Error("billing down");
        if (limits === null) return { plan: null, subscription: null };
        return { plan: { planKey: "p", planName: "P", isDefault: true, limits }, subscription: null };
      },
    },
  } as unknown as Env;
}

beforeEach(() => {
  clearCaches();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

describe("app warnings (as v1)", () => {
  it("are read with every app, and are empty while nothing produces one", async () => {
    const key = await seedManagementKey();
    const { body } = await createApp(key);
    expect(body.app.warnings).toEqual([]);
    expect((await request(key, "GET", `/v2/admin/apps/${body.app.id}`)).body.app.warnings).toEqual([]);
    const list = await request(key, "GET", "/v2/admin/apps");
    expect(list.body.apps.find((app: { id: string }) => app.id === body.app.id).warnings).toEqual([]);
  });
});

describe("app PATCH", () => {
  it("applies the operations to the app as read, and saves as PUT would", async () => {
    const key = await seedManagementKey();
    const { body } = await createApp(key);
    const path = `/v2/admin/apps/${body.app.id}`;
    const patched = await request(key, "PATCH", path, {
      revision: 1,
      operations: [
        { op: "replace", path: "/name", value: "Renamed" },
        { op: "replace", path: "/config/limits/per_app/requests/per_minute", value: 600 },
      ],
    });
    expect(patched).toMatchObject({ status: 200, body: { app: { name: "Renamed", revision: 2 } } });
    expect(patched.body.app.config.limits.per_app.requests.per_minute).toBe(600);
    // null is a value: it sets the limit back to unlimited.
    const cleared = await request(key, "PATCH", path, {
      revision: 2,
      operations: [{ op: "replace", path: "/config/limits/per_app/requests/per_minute", value: null }],
    });
    expect(cleared.body.app.config.limits.per_app.requests.per_minute).toBeNull();
  });

  it("needs the revision, and writes nothing unless every operation applies and the result is accepted", async () => {
    const key = await seedManagementKey();
    const { body } = await createApp(key);
    const path = `/v2/admin/apps/${body.app.id}`;
    const rename = { op: "replace", path: "/name", value: "Again" };
    expect(await request(key, "PATCH", path, { operations: [rename] })).toMatchObject({
      status: 400,
      body: { error: { code: "app_revision_required" } },
    });
    const missing = await request(key, "PATCH", path, {
      revision: 1,
      operations: [rename, { op: "remove", path: "/config/nothing" }],
    });
    expect(missing).toMatchObject({ status: 400, body: { error: { message: expect.stringContaining("operations[1]") } } });
    const refused = await request(key, "PATCH", path, {
      revision: 1,
      operations: [rename, { op: "add", path: "/config/routing/providers/no-such-slug", value: { operations: ["openai.chat"] } }],
    });
    expect(refused.status).toBe(400);
    expect(await request(key, "PATCH", path, { revision: 1, operations: [{ op: "add", path: "/config/__proto__", value: 1 }] })).toMatchObject({
      status: 400,
      body: { error: { message: expect.stringContaining("reserved") } },
    });
    expect(await request(key, "PATCH", path, { revision: 1, operations: [{ op: "replace", path: "/id", value: "x" }] })).toMatchObject({ status: 400 });
    expect((await request(key, "GET", path)).body.app).toMatchObject({ name: "Mgmt", revision: 1 });
    expect(await request(key, "PATCH", path, { revision: 7, operations: [rename] })).toMatchObject({
      status: 409,
      body: { error: { code: "app_revision_conflict" } },
    });
  });

  it("answers a stale patch with a conflict even when the path it names is gone", async () => {
    const key = await seedManagementKey();
    const config = { ...apiKeyConfig({}, { source: "header", header: "x-end-user-id" }), limits: { per_user: { spending: { scope: "user" } } } };
    const { body } = await createApp(key, config);
    const path = `/v2/admin/apps/${body.app.id}`;
    // `scope` has no default, so once removed it is really gone.
    const scope = "/config/limits/per_user/spending/scope";
    expect((await request(key, "PATCH", path, { revision: 1, operations: [{ op: "remove", path: scope }] })).status).toBe(200);
    expect(await request(key, "PATCH", path, { revision: 1, operations: [{ op: "replace", path: scope, value: "user" }] })).toMatchObject({
      status: 409,
      body: { error: { code: "app_revision_conflict" } },
    });
  });
});

describe("validate and check", () => {
  it("validates with only the read grant, as a create or an update would be judged", async () => {
    const key = await seedManagementKey();
    const reader = await seedManagementKey({ grant: "read" });
    const { body: provider } = await createProvider(key);
    const slug = provider.provider.slug as string;
    const routed = apiKeyConfig({ [slug]: { operations: ["openai.chat"] } });
    const { body } = await createApp(key, routed);
    const appId = body.app.id as string;

    expect(await request(reader, "POST", "/v2/admin/app-drafts/validate", { name: "Draft", config: routed })).toMatchObject({
      status: 200,
      body: { valid: true },
    });
    expect(
      await request(reader, "POST", "/v2/admin/app-drafts/validate", { name: "Draft", config: apiKeyConfig({ [slug]: { operations: ["openai.chat"], models: ["gpt-unpriced-zz"] } }) }),
    ).toMatchObject({ status: 400, body: { error: { code: "pricing_not_configured" } } });

    // After the connection is deleted, an update may keep naming it; a new app may not.
    await request(key, "DELETE", `/v2/admin/providers/${provider.provider.id}`);
    expect(await request(reader, "POST", `/v2/admin/apps/${appId}/validate`, { name: "Kept", config: routed })).toMatchObject({
      status: 200,
      body: { valid: true, app_id: appId },
    });
    expect((await request(reader, "POST", "/v2/admin/app-drafts/validate", { name: "Draft", config: routed })).status).toBe(400);
    expect(await request(key, "PUT", `/v2/admin/apps/${appId}`, { name: "Kept", config: routed, revision: 1 })).toMatchObject({
      status: 200,
      body: { app: { name: "Kept" } },
    });
    // Under the deleted connection's slug, only the unchanged entry is kept: a changed one cannot be checked.
    const changed = apiKeyConfig({ [slug]: { operations: ["openai.chat", "openai.nothing"] } });
    expect((await request(key, "PUT", `/v2/admin/apps/${appId}`, { name: "Kept", config: changed, revision: 2 })).status).toBe(400);
    expect((await request(reader, "POST", `/v2/admin/apps/${appId}/validate`, { name: "Kept", config: changed })).status).toBe(400);
    // A slug the stored config never named is still checked.
    const other = apiKeyConfig({ [slug]: { operations: ["openai.chat"] }, "never-there": { operations: ["openai.chat"] } });
    expect((await request(key, "PUT", `/v2/admin/apps/${appId}`, { name: "Kept", config: other, revision: 2 })).status).toBe(400);
  });

  it("renames an app whose unchanged route's connection has unreadable rates", async () => {
    const key = await seedManagementKey();
    const { body: provider } = await createProvider(key);
    const slug = provider.provider.slug as string;
    const routed = apiKeyConfig({ [slug]: { operations: ["openai.chat"], models: ["gpt-4o-mini"] } });
    const { body } = await createApp(key, routed);
    await env.DB.prepare("UPDATE provider_connection SET rates_json = ? WHERE id = ?").bind("{not json", provider.provider.id).run();
    expect(await request(key, "PUT", `/v2/admin/apps/${body.app.id}`, { name: "Renamed", config: routed, revision: 1 })).toMatchObject({
      status: 200,
      body: { app: { name: "Renamed" } },
    });
  });

  it("judges the apps that route to a connection when its rates change, so a rate added later cannot be charged only partly", async () => {
    const key = await seedManagementKey();
    const slug = `el-${crypto.randomUUID().slice(0, 6)}`;
    const { body: provider } = await createProvider(key, { type: "elevenlabs", name: "ElevenLabs", slug });
    // An app with text to speech and no model list: any model with a price is served.
    const { body: app } = await createApp(key, apiKeyConfig({ [slug]: { operations: ["elevenlabs.tts"] } }));
    expect(app.app.id).toBeDefined();
    // Credits alone cannot charge an answer that comes without its header.
    const partly = await request(key, "PUT", `/v2/admin/providers/${provider.provider.id}`, {
      revision: 1,
      pricing: { custom_x: { per_credit: 0.0001, per_hour: 0.2 } },
    });
    expect(partly).toMatchObject({ status: 400, body: { error: { code: "pricing_not_configured" } } });
    expect(partly.body.error.message).toContain("elevenlabs.tts");
    // A rate for every way text to speech answers saves.
    const full = await request(key, "PUT", `/v2/admin/providers/${provider.provider.id}`, {
      revision: 1,
      pricing: { custom_x: { per_credit: 0.0001, per_million_characters: 80 } },
    });
    expect(full.status).toBe(200);
  });

  it("judges a preset's targets when a connection's rates change (PR #199 S1)", async () => {
    const key = await seedManagementKey();
    const { body: provider } = await createProvider(key, { pricing: { house: { input: 1, output: 2 } } });
    const slug = provider.provider.slug as string;
    const config = { ...apiKeyConfig(), presets: { support: { provider: slug, operation: "openai.chat", model: "house" } } };
    expect((await createApp(key, config)).status).toBe(201);
    // Priced per minute, chat could no longer bill the preset's model: the rate save is refused.
    const changed = await request(key, "PUT", `/v2/admin/providers/${provider.provider.id}`, { revision: 1, pricing: { house: { per_minute: 1 } } });
    expect(changed).toMatchObject({ status: 400, body: { error: { code: "pricing_not_configured" } } });
  });

  it("judges a model a request may name besides its own, under its own name (PR #199 S2)", async () => {
    const key = await seedManagementKey();
    const slug = `vercel-${crypto.randomUUID().slice(0, 6)}`;
    await createProvider(key, { type: "vercel", name: "Vercel", slug });
    // `house` is rewritten for the request's own model, but a fallback model is judged, and billed, as named.
    const config = {
      ...apiKeyConfig({ [slug]: { operations: ["vercel.chat"], models: ["house", "openai/gpt-4o-mini"] } }),
    };
    config.routing = { ...config.routing, model_rewrites: { house: "openai/gpt-4o-mini" } } as typeof config.routing;
    const saved = await createApp(key, config);
    expect(saved).toMatchObject({ status: 400, body: { error: { code: "pricing_not_configured" } } });
    expect(saved.body.error.message).toContain("fallback model");
  });

  it("judges everything when a disabled app is turned on again (PR #199 S4)", async () => {
    const key = await seedManagementKey();
    const { body: provider } = await createProvider(key, { pricing: { house: { input: 1, output: 2 } } });
    const slug = provider.provider.slug as string;
    const config = apiKeyConfig({ [slug]: { operations: ["openai.chat"], models: ["house"] } });
    const { body } = await createApp(key, config);
    const path = `/v2/admin/apps/${body.app.id}`;
    expect((await request(key, "PUT", path, { name: "Mgmt", config, status: "disabled", revision: 1 })).status).toBe(200);
    // The price goes while the app is off: removing a rate is allowed.
    expect((await request(key, "PUT", `/v2/admin/providers/${provider.provider.id}`, { revision: 1, pricing: null })).status).toBe(200);
    expect(await request(key, "POST", `${path}/validate`, { name: "Mgmt", config, status: "active" })).toMatchObject({ status: 400 });
    expect(await request(key, "PUT", path, { name: "Mgmt", config, status: "active", revision: 2 })).toMatchObject({
      status: 400,
      body: { error: { code: "pricing_not_configured" } },
    });
    // Staying off, a rename is not judged again.
    expect((await request(key, "PUT", path, { name: "Off", config, revision: 2 })).status).toBe(200);
  });

  it("adds a model list to a route whose connection's rates cannot be read, without failing (PR #199 S5)", async () => {
    const key = await seedManagementKey();
    const { body: provider } = await createProvider(key);
    const slug = provider.provider.slug as string;
    const { body } = await createApp(key, apiKeyConfig({ [slug]: { operations: ["openai.chat"] } }));
    await env.DB.prepare("UPDATE provider_connection SET rates_json = ? WHERE id = ?").bind("{not json", provider.provider.id).run();
    const listed = apiKeyConfig({ [slug]: { operations: ["openai.chat"], models: ["gpt-4o-mini"] } });
    expect((await request(key, "PUT", `/v2/admin/apps/${body.app.id}`, { name: "Mgmt", config: listed, revision: 1 })).status).toBe(200);
  });

  it("judges a preset fallback a rate edit would drop, as its first target would be (PR #199 round 2 S1)", async () => {
    const key = await seedManagementKey();
    const { body: first } = await createProvider(key);
    const { body: second } = await createProvider(key, { pricing: { house: { input: 1, output: 2 } } });
    const config = {
      ...apiKeyConfig(),
      presets: {
        support: {
          provider: first.provider.slug,
          operation: "openai.chat",
          model: "gpt-4o-mini",
          fallback: [{ provider: second.provider.slug, model: "house" }],
        },
      },
    };
    expect((await createApp(key, config)).status).toBe(201);
    // Priced per minute, chat could no longer bill the fallback: under the new rates it would be dropped, unjudged.
    const changed = await request(key, "PUT", `/v2/admin/providers/${second.provider.id}`, { revision: 1, pricing: { house: { per_minute: 1 } } });
    expect(changed).toMatchObject({ status: 400, body: { error: { code: "pricing_not_configured" } } });
  });

  it("judges a rate deletion like any change: refused when it drops a working fallback, saved when no call needs it (PR #199 round 3 S1)", async () => {
    const key = await seedManagementKey();
    const { body: first } = await createProvider(key);
    const { body: second } = await createProvider(key, { pricing: { house: { input: 1, output: 2 }, spare: { input: 1, output: 2 } } });
    const config = {
      ...apiKeyConfig(),
      presets: {
        support: {
          provider: first.provider.slug,
          operation: "openai.chat",
          model: "gpt-4o-mini",
          fallback: [{ provider: second.provider.slug, model: "house" }],
        },
      },
    };
    expect((await createApp(key, config)).status).toBe(201);
    const path = `/v2/admin/providers/${second.provider.id}`;
    // Deleting `house`'s rate would leave the fallback with no price: refused.
    expect(await request(key, "PUT", path, { revision: 1, pricing: { spare: { input: 1, output: 2 } } })).toMatchObject({
      status: 400,
      body: { error: { code: "pricing_not_configured" } },
    });
    // Deleting `spare`'s rate, which no call needs, saves.
    expect((await request(key, "PUT", path, { revision: 1, pricing: { house: { input: 1, output: 2 } } })).status).toBe(200);
  });

  it("judges `pricing: null` as every rate deleted: refused when a working fallback needs one, saved when none does (PR #199 round 4 S1)", async () => {
    const key = await seedManagementKey();
    const { body: first } = await createProvider(key);
    const { body: needed } = await createProvider(key, { pricing: { house: { input: 1, output: 2 } } });
    const { body: spare } = await createProvider(key, { pricing: { house: { input: 1, output: 2 } } });
    const config = {
      ...apiKeyConfig(),
      presets: {
        support: {
          provider: first.provider.slug,
          operation: "openai.chat",
          model: "gpt-4o-mini",
          fallback: [{ provider: needed.provider.slug, model: "house" }],
        },
      },
    };
    expect((await createApp(key, config)).status).toBe(201);
    expect(await request(key, "PUT", `/v2/admin/providers/${needed.provider.id}`, { revision: 1, pricing: null })).toMatchObject({
      status: 400,
      body: { error: { code: "pricing_not_configured" } },
    });
    // No call reaches the spare connection: clearing its rates saves.
    expect((await request(key, "PUT", `/v2/admin/providers/${spare.provider.id}`, { revision: 1, pricing: null })).status).toBe(200);
  });

  it("judges every call the apps reach on a new connection's slug, not only its own rates (PR #199 round 5 F1)", async () => {
    const key = await seedManagementKey();
    const slug = `openai-${crypto.randomUUID().slice(0, 6)}`;
    const { body: provider } = await createProvider(key, { slug, pricing: { house: { input: 1, output: 2 } } });
    expect((await createApp(key, apiKeyConfig({ [slug]: { operations: ["openai.chat"], models: ["house"] } }))).status).toBe(201);
    await request(key, "DELETE", `/v2/admin/providers/${provider.provider.id}`);
    // Made again with no rates, the app's listed `house` would be served with no price at all: refused.
    expect(await createProvider(key, { slug })).toMatchObject({ status: 400, body: { error: { code: "pricing_not_configured" } } });
    expect((await createProvider(key, { slug, pricing: { house: { input: 1, output: 2 } } })).status).toBe(201);
  });

  it("lets a rate save through when serving refuses the calls it drops openly: a proxy call, a listed model (PR #199 round 5 F2)", async () => {
    const key = await seedManagementKey();
    const rate = { input: 1, output: 2 };
    const { body: provider } = await createProvider(key, { pricing: { house: rate, kept: rate } });
    const slug = provider.provider.slug as string;
    // No model list: `house` is served while it has a price, and refused with `pricing_not_configured` once it has none.
    expect((await createApp(key, apiKeyConfig({ [slug]: { operations: ["openai.chat"] } }))).status).toBe(201);
    expect((await createApp(key, apiKeyConfig({ [slug]: { operations: ["openai.chat"], models: ["kept"] } }))).status).toBe(201);
    const path = `/v2/admin/providers/${provider.provider.id}`;
    // Renaming `house`'s rate, and deleting it, save.
    expect((await request(key, "PUT", path, { revision: 1, pricing: { home: rate, kept: rate } })).status).toBe(200);
    expect((await request(key, "PUT", path, { revision: 2, pricing: { kept: rate } })).status).toBe(200);
    // Priced per minute, chat refuses the listed `kept` openly (`wrong_unit`): the save goes through.
    expect((await request(key, "PUT", path, { revision: 3, pricing: { kept: { per_minute: 1 } } })).status).toBe(200);
  });

  it("judges an operation not served yet as if it were (PR #199 round 6 F9)", async () => {
    const key = await seedManagementKey();
    const { body: provider } = await createProvider(key);
    const slug = provider.provider.slug as string;
    // Chat cannot bill it, but realtime, served in a later release, can: the list saves.
    const both = apiKeyConfig({ [slug]: { operations: ["openai.chat", "openai.realtime"], models: ["gpt-realtime-whisper"] } });
    expect((await createApp(key, both)).status).toBe(201);
    const unpriced = apiKeyConfig({ [slug]: { operations: ["openai.realtime"], models: ["no-such-model"] } });
    expect(await createApp(key, unpriced)).toMatchObject({ status: 400, body: { error: { code: "pricing_not_configured" } } });
  });

  it("refuses on activation only a model the save newly lists, while pricing every call (PR #199 round 6 F10)", async () => {
    const key = await seedManagementKey();
    const { body: provider } = await createProvider(key, { pricing: { house: { input: 1, output: 2 } } });
    const slug = provider.provider.slug as string;
    const config = apiKeyConfig({ [slug]: { operations: ["openai.chat"], models: ["house"] } });
    const { body } = await createApp(key, config);
    const path = `/v2/admin/apps/${body.app.id}`;
    expect((await request(key, "PUT", path, { name: "Mgmt", config, status: "disabled", revision: 1 })).status).toBe(200);
    // Priced per minute, chat refuses `house` openly when it is asked for: the list stays as it was.
    expect((await request(key, "PUT", `/v2/admin/providers/${provider.provider.id}`, { revision: 1, pricing: { house: { per_minute: 1 } } })).status).toBe(200);
    expect((await request(key, "PUT", path, { name: "Mgmt", config, status: "active", revision: 2 })).status).toBe(200);
  });

  it("refuses a rate save that removes the service mode a preset selects (PR #199 Astra A1)", async () => {
    const key = await seedManagementKey();
    const flex = { input: 1, output: 2, modes: { flex: { input: 0.5, output: 1 } } };
    const { body: provider } = await createProvider(key, { pricing: { house: flex } });
    const slug = provider.provider.slug as string;
    const config = { ...apiKeyConfig(), presets: { support: { provider: slug, operation: "openai.chat", model: "house", params: { service_tier: "flex" } } } };
    expect((await createApp(key, config)).status).toBe(201);
    const path = `/v2/admin/providers/${provider.provider.id}`;
    const removed = await request(key, "PUT", path, { revision: 1, pricing: { house: { input: 1, output: 2 } } });
    expect(removed).toMatchObject({ status: 400, body: { error: { code: "pricing_not_configured" } } });
    expect(removed.body.error.message).toContain("flex");
    // A preset with no params selects no mode: the same edit saves for it.
    expect((await createApp(key, { ...apiKeyConfig(), presets: { plain: { provider: slug, operation: "openai.chat", model: "house" } } })).status).toBe(201);
    expect((await request(key, "PUT", path, { revision: 1, pricing: { house: { ...flex, input: 2 } } })).status).toBe(200);
  });

  it("saves a disabled app whose preset only lowers its output cap, though its target lost its price (PR #199 Astra A2)", async () => {
    const key = await seedManagementKey();
    const { body: provider } = await createProvider(key, { pricing: { house: { input: 1, output: 2 } } });
    const slug = provider.provider.slug as string;
    const preset = { provider: slug, operation: "openai.chat", model: "house", max_output_tokens: 500 };
    const config = { ...apiKeyConfig(), presets: { support: preset } };
    const { body } = await createApp(key, config);
    const path = `/v2/admin/apps/${body.app.id}`;
    expect((await request(key, "PUT", path, { name: "Mgmt", config, status: "disabled", revision: 1 })).status).toBe(200);
    // The price goes while the app is off.
    expect((await request(key, "PUT", `/v2/admin/providers/${provider.provider.id}`, { revision: 1, pricing: null })).status).toBe(200);
    const lowered = { ...apiKeyConfig(), presets: { support: { ...preset, max_output_tokens: 200 } } };
    expect((await request(key, "PUT", path, { name: "Mgmt", config: lowered, revision: 2 })).status).toBe(200);
    // Turning it on prices every call: refused until the price is back.
    expect(await request(key, "PUT", path, { name: "Mgmt", config: lowered, status: "active", revision: 3 })).toMatchObject({
      status: 400,
      body: { error: { code: "pricing_not_configured" } },
    });
  });

  it("keeps an unchanged entry's allowances when a disabled app is turned on (PR #199 round 5 F3)", async () => {
    const key = await seedManagementKey();
    const { body: gone } = await createProvider(key);
    const { body: kept } = await createProvider(key);
    const config = apiKeyConfig({
      [gone.provider.slug]: { operations: ["openai.chat"] },
      [kept.provider.slug]: { operations: ["openai.chat"], models: ["gpt-4o-mini"] },
    });
    const { body } = await createApp(key, config);
    const path = `/v2/admin/apps/${body.app.id}`;
    expect((await request(key, "PUT", path, { name: "Mgmt", config, status: "disabled", revision: 1 })).status).toBe(200);
    // Unchanged, the entry may keep a connection deleted since, as on any save.
    await request(key, "DELETE", `/v2/admin/providers/${gone.provider.id}`);
    expect((await request(key, "PUT", path, { name: "Mgmt", config, status: "active", revision: 2 })).status).toBe(200);
  });

  it("reports each named connection's status, and ready only with an active one", async () => {
    const key = await seedManagementKey();
    const { body: first } = await createProvider(key);
    const { body: second } = await createProvider(key);
    const config = apiKeyConfig({
      [first.provider.slug]: { operations: ["openai.chat"] },
      [second.provider.slug]: { operations: ["openai.chat"] },
    });
    const { body } = await createApp(key, config);
    const path = `/v2/admin/apps/${body.app.id}/check`;
    expect((await request(key, "GET", path)).body).toMatchObject({ app_id: body.app.id, status: "active", ready: true });

    await request(key, "PUT", `/v2/admin/providers/${first.provider.id}`, { revision: 1, status: "disabled" });
    await request(key, "DELETE", `/v2/admin/providers/${second.provider.id}`);
    const checked = await request(key, "GET", path);
    expect(checked.body.ready).toBe(false);
    expect(checked.body.providers).toEqual([
      { id: first.provider.id, slug: first.provider.slug, status: "disabled" },
      { id: null, slug: second.provider.slug, status: "missing" },
    ]);
    expect(checked.body.limitations.length).toBeGreaterThan(0);
  });

  it("counts the connections presets use, which serve without a routing entry", async () => {
    const key = await seedManagementKey();
    const { body: first } = await createProvider(key);
    const { body: spare } = await createProvider(key);
    const config = {
      ...apiKeyConfig(),
      presets: {
        chat: {
          provider: first.provider.slug,
          operation: "openai.chat",
          model: "gpt-4o-mini",
          fallback: [{ provider: spare.provider.slug, model: "gpt-4o-mini" }],
        },
      },
    };
    const { body } = await createApp(key, config);
    const path = `/v2/admin/apps/${body.app.id}/check`;
    const checked = await request(key, "GET", path);
    expect(checked.body.ready).toBe(true);
    expect(checked.body.providers).toEqual([
      { id: first.provider.id, slug: first.provider.slug, status: "active" },
      { id: spare.provider.id, slug: spare.provider.slug, status: "active" },
    ]);

    // Turned off, the first connection lets the fallback serve.
    await request(key, "PUT", `/v2/admin/providers/${first.provider.id}`, { revision: 1, status: "disabled" });
    const paused = await request(key, "GET", path);
    expect(paused.body.ready).toBe(true);
    expect(paused.body.providers[0]).toMatchObject({ slug: first.provider.slug, status: "disabled" });

    // Deleted, it refuses the preset before any fallback: nothing serves.
    await request(key, "DELETE", `/v2/admin/providers/${first.provider.id}`);
    const broken = await request(key, "GET", path);
    expect(broken.body.ready).toBe(false);
    expect(broken.body.providers).toEqual([
      { id: null, slug: first.provider.slug, status: "missing" },
      { id: spare.provider.id, slug: spare.provider.slug, status: "active" },
    ]);
  });
});

describe("plan ceilings on saved settings", () => {
  const count = async (sql: string, ...binds: unknown[]) =>
    (await env.DB.prepare(sql).bind(...binds).first<number>("n")) ?? 0;

  it("refuses an app over maxApps, counted in the insert itself", async () => {
    const key = await seedManagementKey();
    const used = await count("SELECT COUNT(*) AS n FROM app WHERE account_id = ?", ACCOUNT_ID);
    const plan = hosted({ maxApps: used + 1 });
    expect((await createApp(key, apiKeyConfig(), plan)).status).toBe(201);
    clearCaches();
    const refused = await createApp(key, apiKeyConfig(), plan);
    expect(refused).toMatchObject({
      status: 409,
      body: { error: { code: "billing_plan_limit_reached", data: { limit: used + 1, used: used + 1 } } },
    });
    expect(await count("SELECT COUNT(*) AS n FROM app WHERE account_id = ?", ACCOUNT_ID)).toBe(used + 1);
    // Two creates at once cannot both slip under the ceiling.
    clearCaches();
    const more = hosted({ maxApps: used + 2 });
    const racing = await Promise.all([createApp(key, apiKeyConfig(), more), createApp(key, apiKeyConfig(), more)]);
    expect(racing.map((result) => result.status).sort()).toEqual([201, 409]);
  });

  it("refuses a provider connection over maxProviders", async () => {
    const key = await seedManagementKey();
    const used = await count("SELECT COUNT(*) AS n FROM provider_connection WHERE account_id = ?", ACCOUNT_ID);
    const plan = hosted({ maxProviders: used });
    expect(await createProvider(key, {}, plan)).toMatchObject({ status: 409, body: { error: { code: "billing_plan_limit_reached" } } });
    expect(await count("SELECT COUNT(*) AS n FROM provider_connection WHERE account_id = ?", ACCOUNT_ID)).toBe(used);
  });

  it("counts only active keys against maxActiveKeysPerApp", async () => {
    const key = await seedManagementKey();
    const plan = hosted({ maxActiveKeysPerApp: 2 });
    const { body } = await createApp(key, apiKeyConfig(), plan);
    const keys = `/v2/admin/apps/${body.app.id}/keys`;
    const second = await request(key, "POST", keys, { name: "Second" }, plan);
    expect(second.status).toBe(201);
    expect(await request(key, "POST", keys, { name: "Third" }, plan)).toMatchObject({
      status: 409,
      body: { error: { code: "billing_plan_limit_reached", data: { limit: 2, used: 2 } } },
    });
    await request(key, "POST", `${keys}/${second.body.id}/revoke`, undefined, plan);
    expect((await request(key, "POST", keys, { name: "Third" }, plan)).status).toBe(201);
  });

  it("refuses a capped create when the plan cannot be read, and caps nothing self-hosted", async () => {
    const key = await seedManagementKey();
    expect(await createApp(key, apiKeyConfig(), hosted("down"))).toMatchObject({ status: 503, body: { error: { code: "billing_unavailable" } } });
    clearCaches();
    expect(await createApp(key, apiKeyConfig(), hosted(null))).toMatchObject({ status: 402, body: { error: { code: "billing_payment_required" } } });
    clearCaches();
    expect((await createApp(key, apiKeyConfig(), hosted({}))).status).toBe(201);
    expect((await createApp(key)).status).toBe(201);
  });

  it("answers 503 with Retry-After when a ceiling in the plan data cannot be read", async () => {
    const key = await seedManagementKey();
    const refused = await request(key, "POST", "/v2/admin/apps", { name: "Mgmt", config: apiKeyConfig() }, hosted({ maxApps: -1 }));
    expect(refused).toMatchObject({ status: 503, body: { error: { code: "billing_unavailable" } } });
    expect(refused.headers.get("retry-after")).toBe("5");
  });

  it("refuses a capped create while only a stale plan is known, even a stale no-plan", async () => {
    const key = await seedManagementKey();
    let state: "plan" | "none" | "down" = "plan";
    const flaky = {
      ...env,
      BILLING: {
        getTenantAccess: async () => {
          if (state === "down") throw new Error("billing down");
          return { plan: state === "plan" ? { planKey: "p", planName: "P", isDefault: true, limits: {} } : null, subscription: null };
        },
      },
    } as unknown as Env;
    for (const known of ["plan", "none"] as const) {
      clearCaches();
      state = known;
      await createApp(key, apiKeyConfig(), flaky);
      // Past the 30 s cache, inside the hour the last reading is kept.
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 60_000 });
      state = "down";
      const refused = await createApp(key, apiKeyConfig(), flaky);
      vi.useRealTimers();
      expect(refused).toMatchObject({ status: 503, body: { error: { code: "billing_unavailable" } } });
    }
  });

  it("refuses an app-key app when the plan allows no keys, but not an App Attest app", async () => {
    const key = await seedManagementKey();
    const plan = hosted({ maxActiveKeysPerApp: 0 });
    expect(await createApp(key, apiKeyConfig(), plan)).toMatchObject({
      status: 409,
      body: { error: { code: "billing_plan_limit_reached", data: { limit: 0 } } },
    });
    const attest = {
      authentication: { type: "apple_app_attest", end_user: { source: "app_install" }, app_attest: { team_id: "AAAAAAAAAA", bundle_id: "com.example.app" } },
    };
    expect((await createApp(key, attest, plan)).status).toBe(201);
  });

  it("never lets a bad ceiling value stop the allowance from being read", () => {
    const access = { state: "billed", plan: { planKey: "p", planName: "P", isDefault: true, limits: { maxRequestsPerMonth: 10, maxApps: -1 } }, subscription: null } as const;
    expect(billingPlanLimits(access)).toEqual({ maxRequestsPerMonth: 10 });
    expect(() => billingPlanLimits(access, ["maxApps"])).toThrow(/maxApps/u);
  });
});

describe("end users", () => {
  let chargeCount = 0;
  async function seedCharge(
    appId: string,
    endUserId: string | null,
    values: { usedAt: number; cost?: number | null; status?: string; kind?: string; accountId?: string },
  ) {
    chargeCount += 1;
    const kind = values.kind ?? "attempt";
    await ledger().prepare(
      `INSERT INTO charge (id, kind, account_id, app_id, end_user_id, owner_type, owner_id, provider_type, operation, model, status,
         cost_nano, measured, price_source, input_tokens, output_tokens, measures_json, correction_kind, used_at, usage_day, written_at)
       VALUES (?, ?, ?, ?, ?, 'call', ?, 'openai', 'openai.chat', 'gpt-4o-mini', ?, ?, 'complete', 'list_rate', 10, 2, '{}', ?, ?, ?, ?)`,
    )
      .bind(
        `ch_${chargeCount}_${crypto.randomUUID().slice(0, 6)}`,
        kind,
        values.accountId ?? ACCOUNT_ID,
        appId,
        endUserId,
        `call_${chargeCount}`,
        values.status ?? "ok",
        values.cost === undefined ? 1_000 : values.cost,
        kind === "correction" ? "pricing" : null,
        values.usedAt,
        new Date(values.usedAt).toISOString().slice(0, 10),
        values.usedAt,
      )
      .run();
  }

  it("lists signed-in users and ids only charges or refusals name, with the month's usage", async () => {
    const key = await seedManagementKey();
    const { body } = await createApp(key, apiKeyConfig({}, { source: "header", header: "x-end-user-id" }));
    const appId = body.app.id as string;
    // At least a minute into the UTC month, so every charge below (dated up to 5 s back) is in it,
    // and the month is asked for by name: the run date and the server's clock never move it.
    const current = new Date();
    const monthStart = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 1);
    const now = Math.max(current.getTime(), monthStart + 60_000);
    const thisMonth = new Date(now).toISOString().slice(0, 7);
    const lastMonth = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() - 1, 15);
    await env.DB.prepare("INSERT INTO app_end_user (app_id, id, status, created_at, last_seen_at) VALUES (?, 'signed-in', 'active', ?, ?)")
      .bind(appId, now - 5_000, now - 5_000)
      .run();
    await seedCharge(appId, "header-user", { usedAt: now - 1_000, cost: 1_500 });
    await seedCharge(appId, "header-user", { usedAt: now - 2_000, cost: null, status: "timeout" });
    await seedCharge(appId, "header-user", { usedAt: now - 2_000, cost: 250, kind: "correction" });
    await seedCharge(appId, "header-user", { usedAt: lastMonth, cost: 9_999 });
    await seedCharge(appId, "100%_user", { usedAt: now - 3_000 });
    await seedCharge(appId, null, { usedAt: now - 3_000 });
    await ledger().prepare(
      "INSERT INTO app_rejection_event (id, app_id, account_id, user_id, reason, created_at) VALUES (?, ?, ?, 'refused-only', 'model_not_allowed', ?)",
    )
      .bind(crypto.randomUUID(), appId, ACCOUNT_ID, now - 4_000)
      .run();
    // Refusals recorded under another account, or with none (recorded before events carried one), are never read (Sol 7b-4 round 2).
    for (const [user, account] of [["their-user", "another-account"], ["old-user", null]] as const) {
      await ledger().prepare("INSERT INTO app_rejection_event (id, app_id, account_id, user_id, reason, created_at) VALUES (?, ?, ?, ?, 'model_not_allowed', ?)")
        .bind(crypto.randomUUID(), appId, account, user, now - 4_000)
        .run();
    }

    // Charges recorded under another account are never read either: not as a user, nor in a user's usage (Sol 7b-4 round 3).
    await seedCharge(appId, "their-charge-user", { usedAt: now - 1_000, accountId: "another-account" });
    await seedCharge(appId, "header-user", { usedAt: now - 1_000, cost: 70_000, accountId: "another-account" });

    const listed = await request(key, "GET", `/v2/admin/apps/${appId}/users?month=${thisMonth}`);
    expect(listed.status).toBe(200);
    expect(listed.body.total).toBe(4);
    expect(listed.body.users.map((user: { id: string }) => user.id)).toEqual(["header-user", "100%_user", "refused-only", "signed-in"]);
    const header = listed.body.users[0];
    expect(header).toMatchObject({
      is_virtual: true,
      status: "active",
      created_at: new Date(lastMonth).toISOString(),
      usage: { charges: 2, failed: 1, cost_nano: 1_750, input_tokens: 30 },
    });
    expect(listed.body.users[3]).toMatchObject({ is_virtual: false, usage: { charges: 0, cost_nano: 0 } });

    const month = new Date(lastMonth).toISOString().slice(0, 7);
    const older = await request(key, "GET", `/v2/admin/apps/${appId}/users/header-user?month=${month}`);
    expect(older.body).toMatchObject({ month, user: { id: "header-user", usage: { charges: 1, cost_nano: 9_999 } } });

    // `%` and `_` in a search match themselves.
    const searched = await request(key, "GET", `/v2/admin/apps/${appId}/users?query=${encodeURIComponent("0%_")}`);
    expect(searched.body.users.map((user: { id: string }) => user.id)).toEqual(["100%_user"]);
    const page = await request(key, "GET", `/v2/admin/apps/${appId}/users?limit=1&offset=1`);
    expect(page.body).toMatchObject({ total: 4, limit: 1, offset: 1, users: [{ id: "100%_user" }] });
    expect((await request(key, "GET", `/v2/admin/apps/${appId}/users?month=2026-13`)).status).toBe(400);
    expect((await request(key, "GET", `/v2/admin/apps/${appId}/users/nobody`)).status).toBe(404);
    expect((await request(key, "GET", `/v2/admin/apps/${appId}/users/their-user`)).status).toBe(404);
    expect((await request(key, "GET", `/v2/admin/apps/${appId}/users/old-user`)).status).toBe(404);
    expect((await request(key, "GET", `/v2/admin/apps/${appId}/users/their-charge-user`)).status).toBe(404);
  });

  it("reads a user's charges through the app-and-user index, the account checked on the rows it finds (Sol 7b-4 round 3)", async () => {
    const plan = async (sql: string) =>
      ((await ledger().prepare(`EXPLAIN QUERY PLAN ${sql}`).bind("app", "acct", "u").all<{ detail: string }>()).results ?? []).map((row) => row.detail).join(" | ");
    expect(await plan("SELECT MIN(used_at) FROM charge WHERE app_id = ?1 AND +account_id = ?2 AND end_user_id = ?3")).toContain("charge_app_user_used");
    expect(await plan("SELECT 1 FROM charge WHERE app_id = ?1 AND +account_id = ?2 AND end_user_id = ?3")).toContain("charge_app_user_used");
  });

  it("blocks and unblocks a user with a row, and refuses a virtual one", async () => {
    const key = await seedManagementKey();
    const reader = await seedManagementKey({ grant: "read" });
    const { body } = await createApp(key, apiKeyConfig({}, { source: "header", header: "x-end-user-id" }));
    const appId = body.app.id as string;
    const now = Date.now();
    await env.DB.prepare("INSERT INTO app_end_user (app_id, id, status, created_at) VALUES (?, 'u1', 'active', ?)").bind(appId, now).run();
    await seedCharge(appId, "virtual-user", { usedAt: now });

    expect((await request(reader, "POST", `/v2/admin/apps/${appId}/users/u1/block`)).status).toBe(403);
    expect(await request(key, "POST", `/v2/admin/apps/${appId}/users/u1/block`)).toMatchObject({
      status: 200,
      body: { app_id: appId, user_id: "u1", blocked: true },
    });
    const blocked = await request(key, "GET", `/v2/admin/apps/${appId}/users?status=blocked`);
    expect(blocked.body.users.map((user: { id: string }) => user.id)).toEqual(["u1"]);
    expect((await request(key, "POST", `/v2/admin/apps/${appId}/users/u1/unblock`)).body.blocked).toBe(false);
    expect((await request(key, "POST", `/v2/admin/apps/${appId}/users/virtual-user/block`)).status).toBe(404);
    expect((await request(key, "POST", `/v2/admin/apps/no-such-app/users/u1/block`)).status).toBe(404);
  });
});

describe("price list and key test", () => {
  it("serves the price file", async () => {
    const reader = await seedManagementKey({ grant: "read" });
    const prices = await request(reader, "GET", "/v2/admin/prices");
    expect(prices.status).toBe(200);
    expect(prices.body.prices.openai["gpt-4o-mini"]).toMatchObject({ input: expect.any(Number), output: expect.any(Number) });
  });

  it("lists the provider types with the API styles of their operations, built-in ones by label, then custom", async () => {
    const reader = await seedManagementKey({ grant: "read" });
    const listed = await request(reader, "GET", "/v2/admin/provider-types");
    expect(listed.status).toBe(200);
    const types = listed.body.types as { type: string; label: string; styles: string[]; operations: string[]; cloudflareGateway: boolean; custom: boolean }[];
    expect(types.map((entry) => entry.type)).toEqual([...Object.values(BUILT_IN_PROVIDERS).map((description) => description.type).sort((a, b) => BUILT_IN_PROVIDERS[a]!.label.localeCompare(BUILT_IN_PROVIDERS[b]!.label)), "custom"]);
    const openai = types.find((entry) => entry.type === "openai")!;
    expect(openai).toMatchObject({ label: "OpenAI", cloudflareGateway: true, custom: false });
    // Each style once, in the order the description declares its operations.
    expect(openai.styles.slice(0, 3)).toEqual(["openai-chat", "openai-responses", "openai-transcription"]);
    expect(new Set(openai.styles).size).toBe(openai.styles.length);
    // The operations an app's routing names, in the description's order.
    expect(openai.operations).toEqual(BUILT_IN_PROVIDERS.openai!.operations.map((operation) => operation.name));
    expect(types.at(-1)).toEqual({
      type: "custom",
      label: "Custom provider",
      styles: [...CUSTOM_PATH_STYLES],
      operations: CUSTOM_PATH_STYLES.map((style) => `custom.${style}`),
      cloudflareGateway: false,
      custom: true,
    });
  });

  it("tests a key on the host live requests would use, and stores nothing", async () => {
    const key = await seedManagementKey();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const test = (body: Record<string, unknown>) => request(key, "POST", "/v2/admin/providers/test", { type: "openai", secret: "sk-test-key-1234", ...body });

    fetchSpy.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    expect((await test({})).body).toEqual({ validated: true });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/models");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-test-key-1234");
    expect(init?.redirect).toBe("manual");

    fetchSpy.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    expect((await test({})).body).toEqual({ validated: false, reason: "rejected", status: 401 });
    // A 403 is a key that works but may not list models: it proves nothing.
    fetchSpy.mockResolvedValueOnce(new Response("{}", { status: 403 }));
    expect((await test({})).body).toEqual({ validated: false, reason: "unexpected_status", status: 403 });
    fetchSpy.mockResolvedValueOnce(new Response("{}", { status: 404 }));
    expect((await test({ baseUrl: "https://llm.example.com/" })).body).toEqual({ validated: false, reason: "unexpected_status", status: 404 });
    expect(fetchSpy.mock.calls[3]![0]).toBe("https://llm.example.com/v1/models");
    fetchSpy.mockRejectedValueOnce(new Error("connection refused"));
    expect((await test({})).body).toEqual({ validated: false, reason: "unreachable" });
    expect((await test({ type: "fal" })).body).toEqual({ validated: false, reason: "no_probe" });
    expect(fetchSpy).toHaveBeenCalledTimes(5);

    expect((await test({ baseUrl: "https://10.0.0.1/" })).status).toBe(400);
    expect((await test({ type: "nobody" })).status).toBe(400);
    const reader = await seedManagementKey({ grant: "read" });
    expect((await request(reader, "POST", "/v2/admin/providers/test", { type: "openai", secret: "sk-x" })).status).toBe(403);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM provider_connection WHERE secret_hint = '1234'").first("n")).toBe(0);
  });
});
