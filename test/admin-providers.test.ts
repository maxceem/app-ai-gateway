import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { supportsEndpointStyle } from "../src/core/capabilities";
import {
  clearProviderCaches,
  encryptionContext,
  gatewayEncryptionContext,
  organizationProviders,
  resolveProvider,
} from "../src/core/provider-store";
import { PROVIDER_TYPES } from "../src/core/providers";
import { database } from "../src/db";
import { provider, providerGateway } from "../src/db/schema";
import { secretVault } from "../src/vault";
import {
  TEST_ORGANIZATION_ID,
  seedAllProviders,
  seedProvider,
} from "./helpers";

const ORIGIN = "https://example.test";
const AUTH = { authorization: "Bearer agw_mgmt_test-admin-secret" };
const JSON_AUTH = { ...AUTH, "content-type": "application/json" };

interface ProviderSummary {
  id: string;
  type: string;
  slug: string;
  name: string;
  secretHint: string | null;
  providerGatewayId: string | null;
  gatewayRoute: Record<string, unknown> | null;
  baseUrl: string | null;
  pricing: Record<string, { input: number; output: number }> | null;
  status: string;
  createdAt: string;
  createdBy: string;
}

interface GatewaySummary {
  id: string;
  type: "cf_aig" | "vercel";
  name: string;
  config: Record<string, string>;
  secretHint: string;
  providerCount: number;
  status: string;
}

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; text: string; body: any }> {
  const response = await exports.default.fetch(`${ORIGIN}${path}`, {
    method,
    headers: body === undefined ? AUTH : JSON_AUTH,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, text, body: text ? JSON.parse(text) : null };
}

function stubProbe(outcome: "ok" | "rejected" | "outage" | "down" = "ok"): string[] {
  const urls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (request) => {
    urls.push(typeof request === "string"
      ? request
      : request instanceof URL ? request.toString() : request.url);
    if (outcome === "down") throw new Error("connection refused");
    if (outcome === "rejected") return new Response("", { status: 401 });
    if (outcome === "outage") return new Response("", { status: 503 });
    return Response.json({ data: [] });
  });
  return urls;
}

async function createGateway(token = "cf-aig-original-token"): Promise<GatewaySummary> {
  const created = await call("POST", "/v1/admin/provider-gateways", {
    type: "cf_aig",
    name: "Production CF gateway",
    accountId: "acct-1",
    gatewayId: "gw-1",
    token,
  });
  expect(created.status, created.text).toBe(201);
  expect(created.text).not.toContain(token);
  return created.body.gateway as GatewaySummary;
}

async function removeAll(): Promise<void> {
  const db = database(env.DB);
  await db.delete(provider).where(eq(provider.organizationId, TEST_ORGANIZATION_ID));
  await db.delete(providerGateway).where(eq(providerGateway.organizationId, TEST_ORGANIZATION_ID));
  clearProviderCaches();
}

beforeEach(removeAll);

afterEach(async () => {
  vi.restoreAllMocks();
  await removeAll();
  await seedAllProviders();
});

describe("admin provider instances", () => {
  it("creates a direct provider with its default slug and never returns the key", async () => {
    const urls = stubProbe();
    const created = await call("POST", "/v1/admin/providers", {
      type: "openai",
      name: "Prod OpenAI",
      secret: "sk-live-super-secret-value",
    });

    expect(created.status).toBe(201);
    expect(urls).toEqual(["https://api.openai.com/v1/models"]);
    expect(created.body.validated).toBe(true);
    expect(created.body.provider).toMatchObject({
      type: "openai",
      slug: "openai",
      name: "Prod OpenAI",
      secretHint: "alue",
      providerGatewayId: null,
      pricing: null,
      status: "active",
    });
    expect(created.text).not.toContain("sk-live-super-secret-value");

    const summary = created.body.provider as ProviderSummary;
    const row = await database(env.DB).query.provider.findFirst({
      where: eq(provider.id, summary.id),
    });
    expect(row?.secretBlob).not.toBeNull();
    await expect(secretVault(env).decryptSecret(
      row!.secretBlob!,
      encryptionContext(TEST_ORGANIZATION_ID, summary.id),
    )).resolves.toBe("sk-live-super-secret-value");
  });

  it("supports multiple instances of one type and reports default-slug collisions", async () => {
    stubProbe();
    expect((await call("POST", "/v1/admin/providers", {
      type: "openai",
      name: "Primary",
      secret: "primary-key",
    })).status).toBe(201);

    const duplicate = await call("POST", "/v1/admin/providers", {
      type: "openai",
      name: "Second without slug",
      secret: "second-key",
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe("slug_taken");

    const custom = await call("POST", "/v1/admin/providers", {
      type: "openai",
      slug: "openai-dev",
      name: "Development",
      secret: "dev-key",
    });
    expect(custom.status).toBe(201);
    expect(custom.body.provider.slug).toBe("openai-dev");

    const listed = await call("GET", "/v1/admin/providers");
    expect((listed.body.providers as ProviderSummary[]).map((entry) => entry.slug).sort())
      .toEqual(["openai", "openai-dev"]);
  });

  it("rejects cross-type use of a reserved default slug", async () => {
    stubProbe();
    const response = await call("POST", "/v1/admin/providers", {
      type: "anthropic",
      slug: "openai",
      name: "Wrong type",
      secret: "secret",
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("invalid_request");
  });

  /**
   * A disabled row keeps its slug: pausing an instance must not let something
   * else quietly take over the URL its apps already call, which is the whole
   * reason disable is safe to undo. The message says so, because "already uses"
   * about a row serving no traffic reads as a bug otherwise.
   */
  it("refuses a slug a disabled row still holds, and says how to free it", async () => {
    await seedProvider({
      type: "openai",
      slug: "openai-dev",
      id: "disabled-openai-dev",
      status: "disabled",
    });
    stubProbe();
    const response = await call("POST", "/v1/admin/providers", {
      type: "openai",
      slug: "openai-dev",
      name: "Replacement",
      secret: "replacement-key",
    });
    expect(response.status, response.text).toBe(409);
    expect(response.body.error).toMatchObject({
      code: "slug_taken",
      message:
        "A disabled provider instance holds slug openai-dev; enable it, delete it, or choose a different slug",
    });

    // Deleting the holder is one of the ways out the message offers.
    expect((await call("DELETE", "/v1/admin/providers/disabled-openai-dev")).status).toBe(200);
    const retried = await call("POST", "/v1/admin/providers", {
      type: "openai",
      slug: "openai-dev",
      name: "Replacement",
      secret: "replacement-key",
    });
    expect(retried.status, retried.text).toBe(201);
  });

  it.each([
    ["neither credential source", { type: "openai", name: "Missing" }],
    ["both credential sources", {
      type: "openai",
      name: "Both",
      secret: "secret",
      providerGatewayId: "gateway-id",
    }],
  ])("rejects %s", async (_label, body) => {
    const response = await call("POST", "/v1/admin/providers", body);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("invalid_request");
  });

  it("enforces the credential-source XOR at the database layer", async () => {
    await expect(database(env.DB).insert(provider).values({
      id: "invalid-xor",
      organizationId: TEST_ORGANIZATION_ID,
      type: "openai",
      slug: "invalid-xor",
      name: "Invalid",
      secretBlob: null,
      secretHint: null,
      providerGatewayId: null,
      createdBy: "operator-test-owner",
    })).rejects.toThrow();
  });

  it("rejects credentials refused by a provider and accepts inconclusive probes", async () => {
    stubProbe("rejected");
    const rejected = await call("POST", "/v1/admin/providers", {
      type: "anthropic",
      name: "Bad key",
      secret: "bad-key",
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe("provider_key_invalid");

    vi.restoreAllMocks();
    stubProbe("down");
    const inconclusive = await call("POST", "/v1/admin/providers", {
      type: "xai",
      name: "xAI",
      secret: "xai-key",
    });
    expect(inconclusive.status).toBe(201);
    expect(inconclusive.body.validated).toBe(false);
  });

  it("probes a credential that has no row yet, and stores nothing", async () => {
    const urls = stubProbe();
    const tested = await call("POST", "/v1/admin/providers/test", {
      type: "openai",
      secret: "sk-live-super-secret-value",
    });

    expect(tested.status, tested.text).toBe(200);
    expect(tested.body).toEqual({ validated: true });
    expect(urls).toEqual(["https://api.openai.com/v1/models"]);
    // A test is a dry run: the operator can still change their mind.
    expect(tested.text).not.toContain("sk-live-super-secret-value");
    const listed = await call("GET", "/v1/admin/providers");
    expect(listed.body.providers).toEqual([]);
  });

  it("reports a refused credential and an inconclusive probe apart", async () => {
    stubProbe("rejected");
    const refused = await call("POST", "/v1/admin/providers/test", {
      type: "anthropic",
      secret: "bad-key",
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe("provider_key_invalid");

    vi.restoreAllMocks();
    stubProbe("outage");
    const inconclusive = await call("POST", "/v1/admin/providers/test", {
      type: "xai",
      secret: "xai-key",
    });
    // Nothing was proven either way, which is not the same as a bad key — and
    // the status is what tells the operator which end to go and fix.
    expect(inconclusive.status).toBe(200);
    expect(inconclusive.body).toEqual({
      validated: false,
      reason: "unexpected_status",
      status: 503,
    });

    vi.restoreAllMocks();
    const urls = stubProbe();
    const unprobeable = await call("POST", "/v1/admin/providers/test", {
      type: "perplexity",
      secret: "pplx-key",
    });
    // Perplexity has no cheap authenticated call, so nothing was even asked.
    expect(unprobeable.body).toEqual({ validated: false, reason: "no_probe" });
    expect(urls).toEqual([]);
  });

  it("probes an existing gateway through its own stored token", async () => {
    stubProbe();
    const gateway = await createGateway();
    vi.restoreAllMocks();
    const urls = stubProbe();

    const tested = await call("POST", "/v1/admin/providers/test", {
      type: "anthropic",
      providerGatewayId: gateway.id,
    });

    expect(tested.status, tested.text).toBe(200);
    expect(tested.body).toEqual({ validated: true });
    expect(urls[0]).toContain("/acct-1/gw-1/anthropic/");
    expect(tested.text).not.toContain("cf-aig-original-token");
  });

  it("refuses to probe a gateway belonging to nobody", async () => {
    stubProbe();
    const missing = await call("POST", "/v1/admin/providers/test", {
      type: "openai",
      providerGatewayId: "gw-does-not-exist",
    });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("not_found");
  });

  it("insists on exactly one credential to probe", async () => {
    stubProbe();
    const both = await call("POST", "/v1/admin/providers/test", {
      type: "openai",
      secret: "sk-live",
      providerGatewayId: "gw-1",
    });
    expect(both.status).toBe(400);
    expect(both.body.error.code).toBe("invalid_request");
  });

  it("rotates direct credentials in place and preserves pricing", async () => {
    stubProbe();
    const created = await call("POST", "/v1/admin/providers", {
      type: "openai",
      name: "Prod",
      secret: "original-value",
      pricing: { "custom-model": { input: 1.25, output: 10 } },
    });
    const id = (created.body.provider as ProviderSummary).id;

    const rotated = await call("PUT", `/v1/admin/providers/${id}`, {
      secret: "rotated-value",
      name: "Prod rotated",
    });
    expect(rotated.status).toBe(200);
    expect(rotated.body.provider).toMatchObject({
      id,
      name: "Prod rotated",
      secretHint: "alue",
      pricing: { "custom-model": { input: 1.25, output: 10 } },
    });
    expect(rotated.text).not.toContain("rotated-value");
  });

  /**
   * Disabling is the reversible half of removing an instance: the secret and
   * the pricing stay, the slug stops answering, and enabling puts it back. The
   * distinction the error carries matters — "paused" is something the operator
   * undoes in one click, "not configured" is a row they have to rebuild.
   */
  it("disables an instance, refuses traffic to its slug, and re-enables it", async () => {
    stubProbe();
    const created = await call("POST", "/v1/admin/providers", {
      type: "openai",
      name: "Prod",
      secret: "original-value",
      pricing: { "custom-model": { input: 1.25, output: 10 } },
    });
    const id = (created.body.provider as ProviderSummary).id;

    const disabled = await call("PUT", `/v1/admin/providers/${id}`, { status: "disabled" });
    expect(disabled.status, disabled.text).toBe(200);
    // The credential and the overrides survive the pause untouched.
    expect(disabled.body.provider).toMatchObject({
      id,
      status: "disabled",
      secretHint: "alue",
      pricing: { "custom-model": { input: 1.25, output: 10 } },
    });
    const listed = await call("GET", "/v1/admin/providers");
    expect((listed.body.providers as ProviderSummary[]).map((entry) => entry.status))
      .toEqual(["disabled"]);

    clearProviderCaches();
    await expect(resolveProvider(env, TEST_ORGANIZATION_ID, "openai"))
      .rejects.toThrow(/is disabled/u);

    const enabled = await call("PUT", `/v1/admin/providers/${id}`, { status: "active" });
    expect(enabled.status, enabled.text).toBe(200);
    expect(enabled.body.provider).toMatchObject({ id, status: "active" });
    clearProviderCaches();
    await expect(resolveProvider(env, TEST_ORGANIZATION_ID, "openai"))
      .resolves.toMatchObject({ slug: "openai" });
  });

  /**
   * The invariant that makes disable safe to undo: a disabled row keeps its
   * slug, so nothing can move in behind it and re-enabling can never conflict.
   * Without this, pausing an instance would be a one-way door the moment
   * someone else created a row on the same slug.
   */
  it("holds a disabled instance's slug against new rows, so re-enabling always works", async () => {
    stubProbe();
    const created = await call("POST", "/v1/admin/providers", {
      type: "openai",
      name: "Prod",
      secret: "original-value",
    });
    const id = (created.body.provider as ProviderSummary).id;
    expect((await call("PUT", `/v1/admin/providers/${id}`, { status: "disabled" })).status)
      .toBe(200);

    // The slug is still spoken for while the row is paused.
    const replacement = await call("POST", "/v1/admin/providers", {
      type: "openai",
      slug: "openai",
      name: "Replacement",
      secret: "replacement-value",
    });
    expect(replacement.status).toBe(409);
    expect(replacement.body.error).toMatchObject({
      code: "slug_taken",
      message:
        "A disabled provider instance holds slug openai; enable it, delete it, or choose a different slug",
    });

    // So enabling it again is unconditional, and the slug resolves to the row
    // that held it all along.
    const enabled = await call("PUT", `/v1/admin/providers/${id}`, { status: "active" });
    expect(enabled.status, enabled.text).toBe(200);
    clearProviderCaches();
    await expect(resolveProvider(env, TEST_ORGANIZATION_ID, "openai"))
      .resolves.toMatchObject({ id });
  });

  it("hard-deletes provider rows while usage attribution survives", async () => {
    stubProbe();
    const created = await call("POST", "/v1/admin/providers", {
      type: "openai",
      name: "Prod",
      secret: "original-value",
    });
    const summary = created.body.provider as ProviderSummary;
    await env.DB.prepare(
      `INSERT INTO app_usage_event(app_id, user_id, provider_type, provider_id, provider_slug, model, route, cost_usd, status)
       VALUES ('deleted-provider-app', 'user-1', 'openai', ?, ?, 'gpt-5.6-sol', 'openai/v1/responses', 0.5, 'ok')`,
    ).bind(summary.id, summary.slug).run();

    expect((await call("DELETE", `/v1/admin/providers/${summary.id}`)).status).toBe(200);
    const event = await env.DB.prepare(
      "SELECT provider_id, provider_slug FROM app_usage_event WHERE app_id = 'deleted-provider-app'",
    ).first<{ provider_id: string; provider_slug: string }>();
    expect(event).toEqual({ provider_id: summary.id, provider_slug: summary.slug });
    await env.DB.prepare("DELETE FROM app_usage_event WHERE app_id = 'deleted-provider-app'").run();
  });
});

describe("admin provider gateway API", () => {
  it("creates, lists, renames, and encrypts a reusable gateway token", async () => {
    const urls = stubProbe();
    const gateway = await createGateway();
    expect(urls).toEqual([
      "https://gateway.ai.cloudflare.com/v1/acct-1/gw-1/openai/models",
    ]);
    expect(gateway).toMatchObject({
      type: "cf_aig",
      name: "Production CF gateway",
      config: { accountId: "acct-1", gatewayId: "gw-1" },
      secretHint: "oken",
      providerCount: 0,
      status: "active",
    });

    const row = await database(env.DB).query.providerGateway.findFirst({
      where: eq(providerGateway.id, gateway.id),
    });
    await expect(secretVault(env).decryptSecret(
      row!.secretBlob,
      gatewayEncryptionContext(TEST_ORGANIZATION_ID, gateway.id),
    )).resolves.toBe("cf-aig-original-token");

    const renamed = await call("PATCH", `/v1/admin/provider-gateways/${gateway.id}`, {
      name: "Renamed gateway",
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.gateway.name).toBe("Renamed gateway");
    const listed = await call("GET", "/v1/admin/provider-gateways");
    expect(listed.body.gateways).toHaveLength(1);
    expect(listed.body.gateways[0].name).toBe("Renamed gateway");

    // A revoked gateway is not renameable, matching rotate's active-only filter.
    await env.DB
      .prepare("UPDATE provider_gateway SET status = 'revoked' WHERE id = ?")
      .bind(gateway.id)
      .run();
    const revoked = await call("PATCH", `/v1/admin/provider-gateways/${gateway.id}`, {
      name: "Renamed again",
    });
    expect(revoked.status).toBe(404);
    expect((await call("POST", `/v1/admin/provider-gateways/${gateway.id}/rotate`, {
      token: "another-token",
    })).status).toBe(404);
  });

  it("stores a connection the gateway refuses, and says the gateway refused it", async () => {
    stubProbe("rejected");
    // A Cloudflare AI Gateway answers 401 for a wrong token and for one that is
    // not finished being set up, so the write reports the probe instead of
    // failing on it — the operator can add the connection and fix the rest.
    const created = await call("POST", "/v1/admin/provider-gateways", {
      type: "cf_aig",
      name: "Half-built gateway",
      accountId: "acct-1",
      gatewayId: "gw-1",
      token: "cf-aig-unproven-token",
    });
    expect(created.status, created.text).toBe(201);
    expect(created.body).toMatchObject({
      validated: false,
      reason: "rejected",
      status: 401,
    });
    expect(created.text).not.toContain("cf-aig-unproven-token");

    const listed = await call("GET", "/v1/admin/provider-gateways");
    expect(listed.body.gateways).toHaveLength(1);

    // The same is true of a token replaced later.
    const rotated = await call(
      "POST",
      `/v1/admin/provider-gateways/${created.body.gateway.id}/rotate`,
      { token: "cf-aig-still-unproven" },
    );
    expect(rotated.status, rotated.text).toBe(200);
    expect(rotated.body).toMatchObject({ validated: false, reason: "rejected", status: 401 });
  });

  it("probes a gateway connection that has no row yet, and stores nothing", async () => {
    const urls = stubProbe();
    const tested = await call("POST", "/v1/admin/provider-gateways/test", {
      type: "cf_aig",
      accountId: "acct-1",
      gatewayId: "gw-1",
      token: "cf-aig-candidate-token",
    });
    expect(tested.status, tested.text).toBe(200);
    expect(tested.body).toEqual({ validated: true });
    expect(urls).toEqual(["https://gateway.ai.cloudflare.com/v1/acct-1/gw-1/openai/models"]);
    expect(tested.text).not.toContain("cf-aig-candidate-token");
    expect((await call("GET", "/v1/admin/provider-gateways")).body.gateways).toEqual([]);

    // A refusal is a verdict the operator reads, not an error: the providers
    // API raises provider_key_invalid here, and this one deliberately does not.
    vi.restoreAllMocks();
    stubProbe("rejected");
    const refused = await call("POST", "/v1/admin/provider-gateways/test", {
      type: "cf_aig",
      accountId: "acct-1",
      gatewayId: "gw-1",
      token: "cf-aig-bad-token",
    });
    expect(refused.status).toBe(200);
    expect(refused.body).toEqual({ validated: false, reason: "rejected", status: 401 });

    vi.restoreAllMocks();
    stubProbe("outage");
    const inconclusive = await call("POST", "/v1/admin/provider-gateways/test", {
      type: "cf_aig",
      accountId: "acct-1",
      gatewayId: "gw-1",
      token: "cf-aig-candidate-token",
    });
    expect(inconclusive.body).toEqual({
      validated: false,
      reason: "unexpected_status",
      status: 503,
    });
  });

  it("attaches providers individually, probes by type, and never stores per-row secrets", async () => {
    const urls = stubProbe();
    const gateway = await createGateway();
    const routed = await call("POST", "/v1/admin/providers", {
      type: "anthropic",
      name: "Anthropic through CF",
      providerGatewayId: gateway.id,
    });
    expect(routed.status, routed.text).toBe(201);
    expect(urls).toEqual([
      "https://gateway.ai.cloudflare.com/v1/acct-1/gw-1/openai/models",
      "https://gateway.ai.cloudflare.com/v1/acct-1/gw-1/anthropic/v1/models",
    ]);
    expect(routed.body.provider).toMatchObject({
      type: "anthropic",
      slug: "anthropic",
      secretHint: null,
      providerGatewayId: gateway.id,
    });
    const row = await database(env.DB).query.provider.findFirst({
      where: eq(provider.id, routed.body.provider.id),
    });
    expect(row?.secretBlob).toBeNull();
    expect(row?.secretHint).toBeNull();

    const listed = await call("GET", "/v1/admin/provider-gateways");
    expect(listed.body.gateways[0].providerCount).toBe(1);
  });

  it("rotates a gateway token once, invalidates joined provider caches, and blocks row rotation", async () => {
    stubProbe();
    const gateway = await createGateway("old-shared-token");
    const routed = await call("POST", "/v1/admin/providers", {
      type: "openai",
      name: "OpenAI through CF",
      providerGatewayId: gateway.id,
    });
    const providerSummary = routed.body.provider as ProviderSummary;

    const before = await resolveProvider(env, TEST_ORGANIZATION_ID, providerSummary.slug);
    expect(before?.secret).toBe("old-shared-token");

    const forbidden = await call("PUT", `/v1/admin/providers/${providerSummary.id}`, {
      secret: "wrong-place",
    });
    expect(forbidden.status).toBe(409);
    expect(forbidden.body.error.code).toBe("provider_gateway_managed");

    const rotated = await call("POST", `/v1/admin/provider-gateways/${gateway.id}/rotate`, {
      token: "new-shared-token",
    });
    expect(rotated.status).toBe(200);
    expect(rotated.body.gateway.providerCount).toBe(1);
    expect(rotated.text).not.toContain("new-shared-token");

    const after = await resolveProvider(env, TEST_ORGANIZATION_ID, providerSummary.slug);
    expect(after?.secret).toBe("new-shared-token");
    const gatewayRows = await database(env.DB).select().from(providerGateway);
    expect(gatewayRows).toHaveLength(1);
    const providerRow = await database(env.DB).query.provider.findFirst({
      where: eq(provider.id, providerSummary.id),
    });
    expect(providerRow?.secretBlob).toBeNull();
  });

  /**
   * A row attached to a gateway must never present as `direct`, whatever state
   * that gateway is in. Reading a revoked one as direct judged its
   * configuration against the provider's *full* API surface — so a
   * transcription endpoint on a Vercel-routed OpenAI row saved cleanly while
   * the gateway was down, and started answering 502 the moment it came back.
   */
  it("keeps a revoked gateway's row on its own route, never direct", async () => {
    stubProbe();
    const gateway = (await call("POST", "/v1/admin/provider-gateways", {
      type: "vercel",
      name: "Team gateway",
      token: "vck_live_super_secret",
    })).body.gateway as GatewaySummary;
    await call("POST", "/v1/admin/providers", {
      type: "openai",
      slug: "openai-vercel",
      name: "OpenAI via Vercel",
      providerGatewayId: gateway.id,
    });
    clearProviderCaches();
    expect((await organizationProviders(env, TEST_ORGANIZATION_ID))["openai-vercel"])
      .toMatchObject({ route: "vercel" });

    await env.DB
      .prepare("UPDATE provider_gateway SET status = 'revoked' WHERE id = ?")
      .bind(gateway.id)
      .run();
    clearProviderCaches();

    const revoked = (await organizationProviders(env, TEST_ORGANIZATION_ID))["openai-vercel"];
    // Still narrowed by Vercel's capabilities, so an endpoint style Vercel does
    // not serve is refused while the gateway is down as well as while it is up.
    expect(revoked).toMatchObject({ route: "vercel" });
    expect(supportsEndpointStyle(revoked!.route!, revoked!.type, "transcription")).toBe(false);
    expect(supportsEndpointStyle(revoked!.route!, revoked!.type, "responses")).toBe(true);

    // And it still cannot serve traffic: a revoked gateway is not a credential.
    await expect(resolveProvider(env, TEST_ORGANIZATION_ID, "openai-vercel"))
      .rejects.toThrow(/missing or revoked/u);
  });

  it("blocks gateway deletion while any provider row references it", async () => {
    stubProbe();
    const gateway = await createGateway();
    const routed = await call("POST", "/v1/admin/providers", {
      type: "openai",
      name: "OpenAI through CF",
      providerGatewayId: gateway.id,
    });

    const listedActive = await call("GET", "/v1/admin/provider-gateways");
    expect(listedActive.body.gateways[0]).toMatchObject({ providerCount: 1, referencedCount: 1 });
    const blocked = await call("DELETE", `/v1/admin/provider-gateways/${gateway.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatchObject({
      code: "gateway_in_use",
      message: "Delete every active provider instance routed through this gateway first",
    });

    // Disabled rows are retained for re-enabling and still hold the foreign
    // key, so they must be reported and refused with a message the operator can
    // act on.
    await env.DB
      .prepare("UPDATE provider SET status = 'disabled' WHERE id = ?")
      .bind(routed.body.provider.id)
      .run();
    const listedDisabled = await call("GET", "/v1/admin/provider-gateways");
    expect(listedDisabled.body.gateways[0]).toMatchObject({
      providerCount: 0,
      referencedCount: 1,
    });
    const stillBlocked = await call("DELETE", `/v1/admin/provider-gateways/${gateway.id}`);
    expect(stillBlocked.status).toBe(409);
    expect(stillBlocked.body.error).toMatchObject({
      code: "gateway_in_use",
      message: "Disabled provider instances still reference this gateway; delete them to release it",
    });

    await env.DB.prepare("DELETE FROM provider WHERE id = ?").bind(routed.body.provider.id).run();
    const deleted = await call("DELETE", `/v1/admin/provider-gateways/${gateway.id}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ deleted: true, provider_gateway_id: gateway.id });
  });

  it("scopes gateway and provider operations to the current organization", async () => {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO console_organization(id, name, created_by_user_id, created_at, updated_at)
       VALUES ('admin-other-org', 'Other', 'operator-test-owner', datetime('now'), datetime('now'))`,
    ).run();
    await seedProvider({
      organizationId: "admin-other-org",
      id: "other-org-openai",
      type: "openai",
    });
    expect((await call("GET", "/v1/admin/providers")).body.providers).toHaveLength(0);
    expect((await call("DELETE", "/v1/admin/providers/other-org-openai")).status).toBe(404);
  });
});

/**
 * The stored gateway type is deliberately wider than the adapter registry, so
 * what a deployment will actually create is decided here rather than by a CHECK
 * constraint that costs a table rebuild to change.
 */
describe("gateway routing configuration", () => {
  it("refuses to create a gateway type this deployment has no adapter for", async () => {
    const created = await call("POST", "/v1/admin/provider-gateways", {
      type: "litellm",
      name: "Self-hosted",
      token: "some-token",
    });
    expect(created.status, created.text).toBe(400);
    expect(created.body.error.message).toContain("cf_aig");
  });

  it("refuses Cloudflare's fields on a Vercel gateway, and Vercel's shape on Cloudflare", async () => {
    stubProbe();
    const withCfFields = await call("POST", "/v1/admin/provider-gateways", {
      type: "vercel",
      name: "Vercel",
      accountId: "acct-1",
      gatewayId: "gw-1",
      token: "vercel-token",
    });
    expect(withCfFields.status, withCfFields.text).toBe(400);
    const withoutCfFields = await call("POST", "/v1/admin/provider-gateways", {
      type: "cf_aig",
      name: "CF",
      token: "cf-token",
    });
    expect(withoutCfFields.status, withoutCfFields.text).toBe(400);
  });

  it("creates a Vercel gateway from a name and a token, probing its credits endpoint", async () => {
    const urls = stubProbe();
    const created = await call("POST", "/v1/admin/provider-gateways", {
      type: "vercel",
      name: "Team gateway",
      token: "vck_live_super_secret",
    });
    expect(created.status, created.text).toBe(201);
    expect(created.text).not.toContain("vck_live_super_secret");
    expect(created.body.gateway.type).toBe("vercel");
    // Empty by construction: the origin is in adapter code and the token names
    // the team, so there is nothing per-connection to store.
    expect(created.body.gateway.config).toEqual({});
    expect(created.body.validated).toBe(true);
    expect(urls).toEqual(["https://ai-gateway.vercel.sh/v1/credits"]);

    // Rotation re-probes the same connection through the same adapter.
    urls.length = 0;
    const rotated = await call(
      "POST",
      `/v1/admin/provider-gateways/${created.body.gateway.id}/rotate`,
      { token: "vck_live_rotated_secret" },
    );
    expect(rotated.status, rotated.text).toBe(200);
    expect(rotated.text).not.toContain("vck_live_rotated_secret");
    expect(urls).toEqual(["https://ai-gateway.vercel.sh/v1/credits"]);
  });

  it("stores a Vercel connection the gateway refuses, and says it refused it", async () => {
    stubProbe("rejected");
    // Reported rather than enforced, exactly as a Cloudflare connection is: a
    // gateway write never fails on a refused token.
    const created = await call("POST", "/v1/admin/provider-gateways", {
      type: "vercel",
      name: "Team gateway",
      token: "vck_not_a_key",
    });
    expect(created.status, created.text).toBe(201);
    expect(created.body).toMatchObject({ validated: false, reason: "rejected", status: 401 });
    expect(created.text).not.toContain("vck_not_a_key");
    expect((await call("GET", "/v1/admin/provider-gateways")).body.gateways).toHaveLength(1);

    const rotated = await call(
      "POST",
      `/v1/admin/provider-gateways/${created.body.gateway.id}/rotate`,
      { token: "vck_still_not_a_key" },
    );
    expect(rotated.status, rotated.text).toBe(200);
    expect(rotated.body).toMatchObject({ validated: false, reason: "rejected", status: 401 });
  });

  it("probes a Vercel connection from its token alone, and stores nothing", async () => {
    const urls = stubProbe();
    const tested = await call("POST", "/v1/admin/provider-gateways/test", {
      type: "vercel",
      token: "vck_candidate_token",
    });
    expect(tested.status, tested.text).toBe(200);
    expect(tested.body).toEqual({ validated: true });
    expect(urls).toEqual(["https://ai-gateway.vercel.sh/v1/credits"]);
    expect(tested.text).not.toContain("vck_candidate_token");
    expect((await call("GET", "/v1/admin/provider-gateways")).body.gateways).toEqual([]);

    // The dry run carries the same fields the create does and no others, so a
    // Cloudflare field on a Vercel body is refused rather than ignored.
    const withCfFields = await call("POST", "/v1/admin/provider-gateways/test", {
      type: "vercel",
      accountId: "acct-1",
      token: "vck_candidate_token",
    });
    expect(withCfFields.status, withCfFields.text).toBe(400);
  });

  it("stores and validates a Vercel-routed instance's routing configuration", async () => {
    stubProbe();
    const gateway = (await call("POST", "/v1/admin/provider-gateways", {
      type: "vercel",
      name: "Team gateway",
      token: "vck_live_super_secret",
    })).body.gateway as { id: string };

    // A provider type Vercel's catalog has no namespace for is refused at
    // configuration time rather than on its first request.
    const unmapped = await call("POST", "/v1/admin/providers", {
      type: "mistral",
      name: "Mistral via Vercel",
      providerGatewayId: gateway.id,
    });
    expect(unmapped.status, unmapped.text).toBe(400);
    expect(unmapped.body.error.code).toBe("provider_not_supported_by_gateway");

    const routed = await call("POST", "/v1/admin/providers", {
      type: "gemini",
      slug: "gemini-vercel",
      name: "Gemini via Vercel",
      providerGatewayId: gateway.id,
      gatewayRoute: { providerOnly: ["google"] },
    });
    expect(routed.status, routed.text).toBe(201);
    expect(routed.body.provider.gatewayRoute).toEqual({ providerOnly: ["google"] });

    const badPrefix = await call("PUT", `/v1/admin/providers/${routed.body.provider.id}`, {
      gatewayRoute: { modelPrefix: "google" },
    });
    expect(badPrefix.status, badPrefix.text).toBe(400);
    expect(badPrefix.body.error.message).toContain("end with a slash");

    const unknownKey = await call("PUT", `/v1/admin/providers/${routed.body.provider.id}`, {
      gatewayRoute: { modelPrefix: "google/", region: "us" },
    });
    expect(unknownKey.status, unknownKey.text).toBe(400);
  });

  it("stores no routing configuration for a Cloudflare-routed instance", async () => {
    stubProbe();
    const gateway = await createGateway();
    const routed = await call("POST", "/v1/admin/providers", {
      type: "openai",
      name: "OpenAI through CF",
      providerGatewayId: gateway.id,
    });
    expect(routed.status, routed.text).toBe(201);
    expect(routed.body.provider.gatewayRoute).toBeNull();

    const listed = await call("GET", "/v1/admin/providers");
    expect(listed.body.providers[0].gatewayRoute).toBeNull();
  });

  it("refuses a routing configuration Cloudflare AI Gateway cannot honour", async () => {
    stubProbe();
    const gateway = await createGateway();
    const rejected = await call("POST", "/v1/admin/providers", {
      type: "openai",
      name: "OpenAI through CF",
      providerGatewayId: gateway.id,
      gatewayRoute: { modelPrefix: "openai/" },
    });
    expect(rejected.status, rejected.text).toBe(400);
    expect(rejected.body.error.message).toContain("no per-provider routing configuration");

    const listed = await call("GET", "/v1/admin/providers");
    expect(listed.body.providers).toEqual([]);
  });

  it("refuses a routing configuration on a direct instance, and on updating one", async () => {
    stubProbe();
    const rejected = await call("POST", "/v1/admin/providers", {
      type: "openai",
      name: "Direct OpenAI",
      secret: "sk-live-super-secret-value",
      gatewayRoute: { modelPrefix: "openai/" },
    });
    expect(rejected.status, rejected.text).toBe(400);
    expect(rejected.body.error.message).toContain("routed through a gateway");

    const created = await call("POST", "/v1/admin/providers", {
      type: "openai",
      name: "Direct OpenAI",
      secret: "sk-live-super-secret-value",
    });
    expect(created.status, created.text).toBe(201);
    const updated = await call("PUT", `/v1/admin/providers/${created.body.provider.id}`, {
      gatewayRoute: { providerOnly: ["azure"] },
    });
    expect(updated.status, updated.text).toBe(400);
    // Clearing what was never set stays a legal no-op.
    const cleared = await call("PUT", `/v1/admin/providers/${created.body.provider.id}`, {
      gatewayRoute: null,
    });
    expect(cleared.status, cleared.text).toBe(200);
    expect(cleared.body.provider.gatewayRoute).toBeNull();
  });

  /**
   * Validating a route needs the gateway's *type* and nothing else. Reading it
   * through the token path 404ed on a revoked gateway and decrypted a secret
   * nothing here spends — so a row could be left holding configuration its
   * operator was no longer allowed to remove.
   */
  it("clears a routing configuration on a revoked gateway, and decrypts nothing", async () => {
    stubProbe();
    const gateway = (await call("POST", "/v1/admin/provider-gateways", {
      type: "vercel",
      name: "Team gateway",
      token: "vck_live_super_secret",
    })).body.gateway as GatewaySummary;
    const routed = await call("POST", "/v1/admin/providers", {
      type: "gemini",
      slug: "gemini-vercel",
      name: "Gemini via Vercel",
      providerGatewayId: gateway.id,
      gatewayRoute: { providerOnly: ["google"] },
    });
    expect(routed.status, routed.text).toBe(201);

    await env.DB
      .prepare("UPDATE provider_gateway SET status = 'revoked' WHERE id = ?")
      .bind(gateway.id)
      .run();
    clearProviderCaches();

    // Counted rather than asserted absent by structure: the edit must not go
    // near the vault, and a spy is the only way to say so about a private path.
    const decrypt = vi.spyOn(secretVault(env), "decryptSecret");
    const cleared = await call("PUT", `/v1/admin/providers/${routed.body.provider.id}`, {
      gatewayRoute: null,
    });
    expect(cleared.status, cleared.text).toBe(200);
    expect(cleared.body.provider.gatewayRoute).toBeNull();
    expect(decrypt).not.toHaveBeenCalled();

    const stored = await call("GET", "/v1/admin/providers");
    expect((stored.body.providers as ProviderSummary[])[0]!.gatewayRoute).toBeNull();
  });

  /**
   * Setting one is the other half: a route has to be a route some adapter agreed
   * to, so a non-null value still needs a gateway row with an adapter behind it.
   * Status is deliberately not part of that — a revoked gateway is a credential
   * state, and the row is being saved either way.
   */
  it("still validates a non-null route, and accepts one on a revoked gateway", async () => {
    stubProbe();
    const gateway = (await call("POST", "/v1/admin/provider-gateways", {
      type: "vercel",
      name: "Team gateway",
      token: "vck_live_super_secret",
    })).body.gateway as GatewaySummary;
    const routed = await call("POST", "/v1/admin/providers", {
      type: "gemini",
      slug: "gemini-vercel",
      name: "Gemini via Vercel",
      providerGatewayId: gateway.id,
    });
    expect(routed.status, routed.text).toBe(201);
    await env.DB
      .prepare("UPDATE provider_gateway SET status = 'revoked' WHERE id = ?")
      .bind(gateway.id)
      .run();
    clearProviderCaches();

    const decrypt = vi.spyOn(secretVault(env), "decryptSecret");
    // The adapter still judges it, so a bad namespace is still refused.
    const bad = await call("PUT", `/v1/admin/providers/${routed.body.provider.id}`, {
      gatewayRoute: { modelPrefix: "google" },
    });
    expect(bad.status, bad.text).toBe(400);
    expect(bad.body.error.message).toContain("end with a slash");

    const good = await call("PUT", `/v1/admin/providers/${routed.body.provider.id}`, {
      gatewayRoute: { modelPrefix: "google/" },
    });
    expect(good.status, good.text).toBe(200);
    expect(good.body.provider.gatewayRoute).toEqual({ modelPrefix: "google/" });
    expect(decrypt).not.toHaveBeenCalled();
  });

});

describe("operator-configurable base URL", () => {
  it("stores the canonical origin, probes it, and proxies through it", async () => {
    const urls = stubProbe();
    const created = await call("POST", "/v1/admin/providers", {
      type: "openai",
      name: "Self-hosted",
      slug: "vllm",
      secret: "sk-self-hosted-value",
      // Deliberately not canonical: mixed case, no trailing slash.
      baseUrl: "https://My-Vllm.Example.com/v1",
    });

    expect(created.status, created.text).toBe(201);
    expect(created.body.provider).toMatchObject({
      slug: "vllm",
      baseUrl: "https://my-vllm.example.com/v1/",
      providerGatewayId: null,
    });
    // The probe went to the operator's origin, not to OpenAI's.
    expect(urls).toEqual(["https://my-vllm.example.com/v1/v1/models"]);
    expect(created.body.validated).toBe(true);

    // And the resolved row the proxy uses carries it.
    clearProviderCaches();
    const resolved = await resolveProvider(env, TEST_ORGANIZATION_ID, "vllm");
    expect(resolved?.baseUrl).toBe("https://my-vllm.example.com/v1/");
  });

  it("lists the override and leaves every other instance null", async () => {
    stubProbe();
    await call("POST", "/v1/admin/providers", {
      type: "openai",
      name: "Stock",
      secret: "sk-stock-value",
    });
    await call("POST", "/v1/admin/providers", {
      type: "openai",
      name: "Custom",
      slug: "openai-custom",
      secret: "sk-custom-value",
      baseUrl: "https://my-resource.openai.azure.com/openai/v1/",
    });

    const listed = await call("GET", "/v1/admin/providers");
    const rows = listed.body.providers as ProviderSummary[];
    expect(rows.find((row) => row.slug === "openai")?.baseUrl).toBeNull();
    expect(rows.find((row) => row.slug === "openai-custom")?.baseUrl)
      .toBe("https://my-resource.openai.azure.com/openai/v1/");
  });

  it("refuses every origin the guard refuses, naming the rule", async () => {
    stubProbe();
    const cases: [string, RegExp][] = [
      ["http://my-vllm.example.com/", /https/u],
      ["https://127.0.0.1/", /IP address/u],
      ["https://[::1]/", /IPv6/u],
      ["https://0x7f000001/", /IP address/u],
      ["https://vllm.internal/", /reserved local name/u],
      ["https://localhost/", /domain suffix|reserved/u],
      ["https://my-vllm.example.com:8443/", /default https port/u],
      ["https://user:pass@my-vllm.example.com/", /credentials/u],
      ["https://my-vllm.example.com/?api-version=2024-10-21", /query/u],
    ];
    for (const [baseUrl, because] of cases) {
      const response = await call("POST", "/v1/admin/providers", {
        type: "openai",
        name: "Bad",
        slug: "bad-openai",
        secret: "sk-value",
        baseUrl,
      });
      expect(response.status, `${baseUrl} was accepted`).toBe(400);
      expect(response.body.error.message).toMatch(because);
    }
    // Nothing was stored by any of them.
    expect((await call("GET", "/v1/admin/providers")).body.providers).toHaveLength(0);
  });

  it("refuses a base URL alongside a gateway, on create and on update", async () => {
    stubProbe();
    const gateway = await createGateway();
    const rejected = await call("POST", "/v1/admin/providers", {
      type: "openai",
      name: "Routed",
      providerGatewayId: gateway.id,
      baseUrl: "https://my-vllm.example.com/v1/",
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.message).toMatch(/gateway owns the upstream origin/u);

    const routed = await call("POST", "/v1/admin/providers", {
      type: "openai",
      name: "Routed",
      providerGatewayId: gateway.id,
    });
    expect(routed.status).toBe(201);
    expect(routed.body.provider.baseUrl).toBeNull();
    const id = (routed.body.provider as ProviderSummary).id;

    const updated = await call("PUT", `/v1/admin/providers/${id}`, {
      baseUrl: "https://my-vllm.example.com/v1/",
    });
    expect(updated.status).toBe(400);
    expect(updated.body.error.message).toMatch(/gateway owns the upstream origin/u);
  });

  it("re-probes the stored credential when the origin changes, and clears with null", async () => {
    const urls = stubProbe();
    const created = await call("POST", "/v1/admin/providers", {
      type: "openai",
      name: "Custom",
      secret: "sk-original-value",
      baseUrl: "https://first.example.com/v1/",
    });
    const id = (created.body.provider as ProviderSummary).id;
    urls.length = 0;

    const moved = await call("PUT", `/v1/admin/providers/${id}`, {
      baseUrl: "https://second.example.com/v1/",
    });
    expect(moved.status, moved.text).toBe(200);
    expect(moved.body.provider.baseUrl).toBe("https://second.example.com/v1/");
    // Proven against the key already stored, at the origin it is moving to.
    expect(urls).toEqual(["https://second.example.com/v1/v1/models"]);
    expect(moved.body.validated).toBe(true);
    urls.length = 0;

    const cleared = await call("PUT", `/v1/admin/providers/${id}`, { baseUrl: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.provider.baseUrl).toBeNull();
    expect(urls).toEqual(["https://api.openai.com/v1/models"]);
    clearProviderCaches();
    expect((await resolveProvider(env, TEST_ORGANIZATION_ID, "openai"))?.baseUrl).toBeNull();
  });

  it("rotates a key at the row's own origin, and refuses an invalid update outright", async () => {
    const urls = stubProbe();
    const created = await call("POST", "/v1/admin/providers", {
      type: "openai",
      name: "Custom",
      secret: "sk-original-value",
      baseUrl: "https://my-vllm.example.com/v1/",
    });
    const id = (created.body.provider as ProviderSummary).id;
    urls.length = 0;

    const rotated = await call("PUT", `/v1/admin/providers/${id}`, { secret: "sk-rotated-value" });
    expect(rotated.status).toBe(200);
    expect(urls).toEqual(["https://my-vllm.example.com/v1/v1/models"]);

    const invalid = await call("PUT", `/v1/admin/providers/${id}`, {
      baseUrl: "http://my-vllm.example.com/v1/",
    });
    expect(invalid.status).toBe(400);
    const listed = await call("GET", "/v1/admin/providers");
    expect((listed.body.providers as ProviderSummary[])[0]?.baseUrl)
      .toBe("https://my-vllm.example.com/v1/");
  });

  it("probes a base URL without storing anything, and guards the dry run too", async () => {
    const urls = stubProbe();
    const probed = await call("POST", "/v1/admin/providers/test", {
      type: "openai",
      secret: "sk-value",
      baseUrl: "https://my-vllm.example.com/v1",
    });
    expect(probed.status).toBe(200);
    expect(probed.body.validated).toBe(true);
    expect(urls).toEqual(["https://my-vllm.example.com/v1/v1/models"]);

    urls.length = 0;
    const refused = await call("POST", "/v1/admin/providers/test", {
      type: "openai",
      secret: "sk-value",
      baseUrl: "https://169.254.169.254/",
    });
    expect(refused.status).toBe(400);
    // The point of guarding the dry run: nothing was fetched at all.
    expect(urls).toEqual([]);
    expect((await call("GET", "/v1/admin/providers")).body.providers).toHaveLength(0);
  });
});

describe("provider probe coverage", () => {
  it("creates every provider type and probes each at its own documented path", async () => {
    const seen: { url: string; headers: Headers }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      seen.push({
        url: typeof request === "string" ? request : request instanceof URL ? request.toString() : request.url,
        headers: new Headers(init?.headers),
      });
      return Response.json({ data: [] });
    });
    for (const type of PROVIDER_TYPES) {
      const created = await call("POST", "/v1/admin/providers", {
        type,
        // Slug defaults to the type, and the fixture already owns those, so
        // each row gets one of its own.
        slug: `probe-${type}`,
        name: type,
        secret: `${type}-secret`,
      });
      expect([type, created.status]).toEqual([type, 201]);
      expect(created.body.provider.type).toBe(type);
    }
    // A provider with no probe of its own contributes no request here: the key
    // is stored unvalidated rather than checked against a guessed URL.
    expect(seen.map((entry) => entry.url)).toEqual([
      "https://api.openai.com/v1/models",
      "https://api.anthropic.com/v1/models",
      "https://api.x.ai/v1/models",
      "https://generativelanguage.googleapis.com/v1beta/models",
      "https://api.deepseek.com/models",
      "https://api.groq.com/openai/v1/models",
      "https://api.mistral.ai/v1/models",
      "https://api.together.ai/v1/models",
      "https://api.cerebras.ai/v1/models",
      "https://api.moonshot.ai/v1/models",
      "https://inference.baseten.co/v1/models",
      // OpenRouter's key-status call: its model list is public, so probing that
      // would report every key as good.
      "https://openrouter.ai/api/v1/key",
    ]);
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer openai-secret");
    expect(seen[1]?.headers.get("x-api-key")).toBe("anthropic-secret");
    expect(seen[1]?.headers.get("anthropic-version")).toBe("2023-06-01");
    // The whole OpenAI-compatible batch authenticates the same way.
    for (const entry of seen.slice(4)) {
      expect([entry.url, entry.headers.get("authorization")?.startsWith("Bearer ")])
        .toEqual([entry.url, true]);
    }
  });

  it("stores a key unvalidated for a provider with no probe of its own", async () => {
    // Perplexity has no unmetered authenticated call; Fireworks needs an
    // account id the key does not carry; Hugging Face's model list answers 200
    // to any token, so probing it would report every key as good.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ data: [] }));
    for (const type of ["perplexity", "fireworks", "huggingface"] as const) {
      const created = await call("POST", "/v1/admin/providers", {
        type,
        slug: `unprobed-${type}`,
        name: type,
        secret: `${type}-secret`,
      });
      expect([type, created.status, created.body.validated]).toEqual([type, 201, false]);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a provider type its gateway cannot serve", async () => {
    // The gateway create probes too, so the upstream is stubbed for both calls.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ data: [] }));
    const gateway = await call("POST", "/v1/admin/provider-gateways", {
      type: "cf_aig",
      name: "Unsupported types",
      accountId: "acct-unsupported",
      gatewayId: "gw-unsupported",
      token: "cf-aig-unsupported-token",
    });
    expect(gateway.status).toBe(201);
    const created = await call("POST", "/v1/admin/providers", {
      type: "deepseek",
      slug: "deepseek-via-gateway",
      name: "DeepSeek via CF",
      providerGatewayId: gateway.body.gateway.id,
    });
    expect(created.status).toBe(400);
    expect(created.body.error.code).toBe("provider_not_supported_by_gateway");
    const tested = await call("POST", "/v1/admin/providers/test", {
      type: "deepseek",
      providerGatewayId: gateway.body.gateway.id,
    });
    expect(tested.status).toBe(400);
    expect(tested.body.error.code).toBe("provider_not_supported_by_gateway");
  });
});
