import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearProviderCaches,
  encryptionContext,
  gatewayEncryptionContext,
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
  pricing: Record<string, { input: number; output: number }> | null;
  status: string;
  createdAt: string;
  createdBy: string;
}

interface GatewaySummary {
  id: string;
  type: "cf_aig";
  name: string;
  config: { accountId: string; gatewayId: string };
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

  it("allows a revoked row's slug to be reused", async () => {
    await seedProvider({
      type: "openai",
      slug: "openai-dev",
      id: "revoked-openai-dev",
      status: "revoked",
    });
    stubProbe();
    const response = await call("POST", "/v1/admin/providers", {
      type: "openai",
      slug: "openai-dev",
      name: "Replacement",
      secret: "replacement-key",
    });
    expect(response.status, response.text).toBe(201);
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

    // Revoked rows are retained for audit and still hold the foreign key, so
    // they must be reported and refused with a message the operator can act on.
    await env.DB
      .prepare("UPDATE provider SET status = 'revoked' WHERE id = ?")
      .bind(routed.body.provider.id)
      .run();
    const listedRevoked = await call("GET", "/v1/admin/provider-gateways");
    expect(listedRevoked.body.gateways[0]).toMatchObject({
      providerCount: 0,
      referencedCount: 1,
    });
    const stillBlocked = await call("DELETE", `/v1/admin/provider-gateways/${gateway.id}`);
    expect(stillBlocked.status).toBe(409);
    expect(stillBlocked.body.error).toMatchObject({
      code: "gateway_in_use",
      message: "Revoked provider instances still reference this gateway; delete them to release it",
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
      type: "vercel",
      name: "Vercel",
      accountId: "acct-1",
      gatewayId: "gw-1",
      token: "vercel-token",
    });
    expect(created.status, created.text).toBe(400);
    expect(created.body.error.message).toContain("cf_aig");
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
});

describe("provider probe coverage", () => {
  it("uses every provider's native probe headers", async () => {
    const seen: { url: string; headers: Headers }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      seen.push({
        url: typeof request === "string" ? request : request instanceof URL ? request.toString() : request.url,
        headers: new Headers(init?.headers),
      });
      return Response.json({ data: [] });
    });
    for (const type of PROVIDER_TYPES) {
      await call("POST", "/v1/admin/providers", {
        type,
        name: type,
        secret: `${type}-secret`,
      });
    }
    expect(seen.map((entry) => entry.url)).toEqual([
      "https://api.openai.com/v1/models",
      "https://api.anthropic.com/v1/models",
      "https://api.x.ai/v1/models",
      "https://generativelanguage.googleapis.com/v1beta/models",
    ]);
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer openai-secret");
    expect(seen[1]?.headers.get("x-api-key")).toBe("anthropic-secret");
    expect(seen[1]?.headers.get("anthropic-version")).toBe("2023-06-01");
  });
});
