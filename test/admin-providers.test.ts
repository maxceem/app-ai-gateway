import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearProviderCaches, encryptionContext } from "../src/core/provider-store";
import { PROVIDER_TYPES } from "../src/core/providers";
import { database } from "../src/db";
import { provider } from "../src/db/schema";
import { secretVault } from "../src/vault";
import { TEST_ORGANIZATION_ID, seedAllProviders } from "./helpers";

const ORIGIN = "https://example.test";
const AUTH = { authorization: "Bearer agw_mgmt_test-admin-secret" };
const JSON_AUTH = { ...AUTH, "content-type": "application/json" };

interface ProviderSummary {
  id: string;
  type: string;
  name: string;
  secretHint: string;
  gateway: string | null;
  gatewayConfig: { accountId: string; gatewayId: string } | null;
  pricing: Record<string, { input: number; output: number }> | null;
  status: string;
  createdAt: string;
  createdBy: string;
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

/** Every probe answer the plan distinguishes, in one place. */
function stubProbe(outcome: "ok" | "rejected" | "outage" | "down"): string[] {
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

async function removeAll(): Promise<void> {
  await database(env.DB).delete(provider).where(eq(provider.organizationId, TEST_ORGANIZATION_ID));
  clearProviderCaches();
}

beforeEach(removeAll);

afterEach(async () => {
  vi.restoreAllMocks();
  await removeAll();
  // Restore the fixture every other suite depends on.
  await seedAllProviders();
});

describe("admin provider API", () => {
  it("stores a probed credential and never echoes it back", async () => {
    const urls = stubProbe("ok");
    const created = await call("POST", "/v1/admin/providers", {
      type: "openai",
      name: "Prod OpenAI",
      secret: "sk-live-super-secret-value",
    });

    expect(created.status).toBe(201);
    expect(urls).toEqual(["https://api.openai.com/v1/models"]);
    expect(created.body.validated).toBe(true);
    const summary = created.body.provider as ProviderSummary;
    expect(summary).toMatchObject({
      type: "openai",
      name: "Prod OpenAI",
      secretHint: "alue",
      gateway: null,
      gatewayConfig: null,
      pricing: null,
      status: "active",
    });
    expect(created.text).not.toContain("sk-live-super-secret-value");

    const listed = await call("GET", "/v1/admin/providers");
    expect(listed.status).toBe(200);
    expect(listed.text).not.toContain("sk-live-super-secret-value");
    expect(listed.body.providers).toHaveLength(1);

    // The stored blob really is the plaintext, bound to this row.
    const row = await database(env.DB).query.provider.findFirst({
      where: eq(provider.id, summary.id),
    });
    expect(row?.secretBlob.startsWith("local1.")).toBe(true);
    await expect(secretVault(env).decryptSecret(
      row!.secretBlob,
      encryptionContext(TEST_ORGANIZATION_ID, summary.id),
    )).resolves.toBe("sk-live-super-secret-value");
  });

  it("rejects a credential the provider refuses, without storing anything", async () => {
    stubProbe("rejected");
    const response = await call("POST", "/v1/admin/providers", {
      type: "anthropic",
      name: "Bad key",
      secret: "sk-ant-wrong",
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("provider_key_invalid");
    expect(response.text).not.toContain("sk-ant-wrong");
    const rows = await database(env.DB).select().from(provider);
    expect(rows).toHaveLength(0);
  });

  it("accepts a credential the provider could not confirm during an outage", async () => {
    stubProbe("down");
    const response = await call("POST", "/v1/admin/providers", {
      type: "xai",
      name: "xAI",
      secret: "xai-key-value",
    });

    expect(response.status).toBe(201);
    expect(response.body.validated).toBe(false);
  });

  it("accepts Perplexity unvalidated, because it has no cheap probe", async () => {
    const urls = stubProbe("ok");
    const response = await call("POST", "/v1/admin/providers", {
      type: "perplexity",
      name: "Perplexity",
      secret: "pplx-key-value",
    });

    expect(response.status).toBe(201);
    expect(response.body.validated).toBe(false);
    expect(urls).toHaveLength(0);
  });

  it("refuses a second active credential for the same provider type", async () => {
    stubProbe("ok");
    const first = await call("POST", "/v1/admin/providers", {
      type: "gemini",
      name: "First",
      secret: "gemini-one",
    });
    expect(first.status).toBe(201);

    const second = await call("POST", "/v1/admin/providers", {
      type: "gemini",
      name: "Second",
      secret: "gemini-two",
    });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("provider_exists");
  });

  it("fans a Cloudflare AI Gateway preset out to one row per provider", async () => {
    const urls = stubProbe("ok");
    const response = await call("POST", "/v1/admin/providers/cf-aig-preset", {
      accountId: "acct-1",
      gatewayId: "gw-1",
      token: "cf-aig-run-token",
      types: ["openai", "anthropic"],
      name: "Via our CF gateway",
    });

    expect(response.status).toBe(201);
    expect(urls).toEqual([
      "https://gateway.ai.cloudflare.com/v1/acct-1/gw-1/openai/models",
    ]);
    expect(response.body.validated).toBe(true);
    expect(response.body.conflicts).toEqual([]);
    expect(response.text).not.toContain("cf-aig-run-token");
    const providers = response.body.providers as ProviderSummary[];
    expect(providers.map((entry) => entry.type).sort()).toEqual(["anthropic", "openai"]);
    for (const entry of providers) {
      expect(entry.gateway).toBe("cf_aig");
      expect(entry.gatewayConfig).toEqual({ accountId: "acct-1", gatewayId: "gw-1" });
    }
  });

  it("reports per-provider conflicts when a preset partially overlaps", async () => {
    stubProbe("ok");
    await call("POST", "/v1/admin/providers", {
      type: "openai",
      name: "Direct OpenAI",
      secret: "sk-direct",
    });

    const response = await call("POST", "/v1/admin/providers/cf-aig-preset", {
      accountId: "acct-1",
      gatewayId: "gw-1",
      token: "cf-aig-run-token",
      types: ["openai", "xai"],
      name: "Via our CF gateway",
    });

    expect(response.status).toBe(201);
    expect(response.body.conflicts).toEqual(["openai"]);
    expect((response.body.providers as ProviderSummary[]).map((entry) => entry.type)).toEqual(["xai"]);
  });

  it("fails the whole preset when every listed provider is already configured", async () => {
    stubProbe("ok");
    await call("POST", "/v1/admin/providers", { type: "openai", name: "A", secret: "sk-a" });

    const response = await call("POST", "/v1/admin/providers/cf-aig-preset", {
      accountId: "acct-1",
      gatewayId: "gw-1",
      token: "cf-aig-run-token",
      types: ["openai"],
      name: "Via our CF gateway",
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("provider_exists");
  });

  it("rotates a credential in place, keeping its id and encryption context", async () => {
    stubProbe("ok");
    const created = await call("POST", "/v1/admin/providers", {
      type: "openai",
      name: "Prod OpenAI",
      secret: "sk-original-value",
      pricing: { "gpt-brand-new": { input: 1.25, output: 10 } },
    });
    const id = (created.body.provider as ProviderSummary).id;

    const rotated = await call("PUT", `/v1/admin/providers/${id}`, {
      secret: "sk-rotated-value",
      name: "Prod OpenAI (rotated)",
    });

    expect(rotated.status).toBe(200);
    expect(rotated.body.validated).toBe(true);
    expect(rotated.text).not.toContain("sk-rotated-value");
    const summary = rotated.body.provider as ProviderSummary;
    expect(summary.id).toBe(id);
    expect(summary.secretHint).toBe("alue");
    expect(summary.name).toBe("Prod OpenAI (rotated)");
    // Rotation keeps the pricing overrides; only a delete discards them.
    expect(summary.pricing).toEqual({ "gpt-brand-new": { input: 1.25, output: 10 } });

    const row = await database(env.DB).query.provider.findFirst({ where: eq(provider.id, id) });
    await expect(secretVault(env).decryptSecret(
      row!.secretBlob,
      encryptionContext(TEST_ORGANIZATION_ID, id),
    )).resolves.toBe("sk-rotated-value");
  });

  it("replaces custom pricing without touching the credential", async () => {
    stubProbe("ok");
    const created = await call("POST", "/v1/admin/providers", {
      type: "openai",
      name: "Prod OpenAI",
      secret: "sk-original-value",
      pricing: { "old-model": { input: 1, output: 2 } },
    });
    const id = (created.body.provider as ProviderSummary).id;
    const before = await database(env.DB).query.provider.findFirst({ where: eq(provider.id, id) });

    const updated = await call("PUT", `/v1/admin/providers/${id}`, {
      pricing: { "new-model": { input: 0, output: 0 } },
    });

    expect(updated.status).toBe(200);
    // No rotation happened, so there was nothing to probe.
    expect(updated.body.validated).toBeNull();
    expect((updated.body.provider as ProviderSummary).pricing).toEqual({
      "new-model": { input: 0, output: 0 },
    });
    const after = await database(env.DB).query.provider.findFirst({ where: eq(provider.id, id) });
    expect(after?.secretBlob).toBe(before?.secretBlob);
  });

  it.each([
    ["a negative price", { pricing: { model: { input: -1, output: 1 } } }],
    ["an unknown field", { pricing: { model: { input: 1, output: 1, extra: 2 } } }],
    ["an empty body", {}],
  ])("rejects %s", async (_label, body) => {
    stubProbe("ok");
    const created = await call("POST", "/v1/admin/providers", {
      type: "openai",
      name: "Prod OpenAI",
      secret: "sk-original-value",
    });
    const id = (created.body.provider as ProviderSummary).id;

    const response = await call("PUT", `/v1/admin/providers/${id}`, body);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("invalid_request");
  });

  it("hard-deletes a provider and its overrides", async () => {
    stubProbe("ok");
    const created = await call("POST", "/v1/admin/providers", {
      type: "openai",
      name: "Prod OpenAI",
      secret: "sk-original-value",
      pricing: { "gpt-brand-new": { input: 1, output: 2 } },
    });
    const id = (created.body.provider as ProviderSummary).id;

    const deleted = await call("DELETE", `/v1/admin/providers/${id}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ deleted: true, provider_id: id });

    const rows = await database(env.DB).select().from(provider);
    expect(rows).toHaveLength(0);
    expect((await call("DELETE", `/v1/admin/providers/${id}`)).status).toBe(404);
  });

  it("scopes reads and writes to the caller's organization", async () => {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO console_organization(id, name, created_by_user_id, created_at, updated_at)
       VALUES ('admin-other-org', 'Other', 'operator-test-owner', datetime('now'), datetime('now'))`,
    ).run();
    await database(env.DB).insert(provider).values({
      id: "other-org-openai",
      organizationId: "admin-other-org",
      type: "openai",
      name: "Someone else's",
      secretBlob: "local1.1.iv.ct",
      secretHint: "zzzz",
      createdBy: "operator-test-owner",
    });

    const listed = await call("GET", "/v1/admin/providers");
    expect(listed.body.providers).toHaveLength(0);
    expect((await call("DELETE", "/v1/admin/providers/other-org-openai")).status).toBe(404);
    expect((await call("PUT", "/v1/admin/providers/other-org-openai", { name: "x" })).status).toBe(404);

    await database(env.DB).delete(provider).where(eq(provider.id, "other-org-openai"));
  });

  it("uses each provider's own probe endpoint and auth header", async () => {
    const seen: Array<{ url: string; headers: Headers }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      seen.push({
        url: typeof request === "string"
          ? request
          : request instanceof URL ? request.toString() : request.url,
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
    expect(seen[2]?.headers.get("authorization")).toBe("Bearer xai-secret");
    expect(seen[3]?.headers.get("x-goog-api-key")).toBe("gemini-secret");

    const listed = await call("GET", "/v1/admin/providers");
    expect((listed.body.providers as ProviderSummary[]).map((entry) => entry.type).sort())
      .toEqual([...PROVIDER_TYPES].sort());
  });

  it("requires an owner or admin to write", async () => {
    const response = await exports.default.fetch(`${ORIGIN}/v1/admin/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "openai", name: "x", secret: "y" }),
    });
    expect(response.status).toBe(401);
  });
});

describe("provider rows referenced by usage", () => {
  it("keeps usage history readable after a provider is deleted", async () => {
    stubProbe("ok");
    const created = await call("POST", "/v1/admin/providers", {
      type: "openai",
      name: "Prod OpenAI",
      secret: "sk-original-value",
    });
    const id = (created.body.provider as ProviderSummary).id;
    await env.DB.prepare(
      `INSERT INTO app_usage_event(app_id, user_id, provider_type, provider_id, model, route, cost_usd, status)
       VALUES ('deleted-provider-app', 'user-1', 'openai', ?, 'gpt-5.6-sol', 'openai/v1/responses', 0.5, 'ok')`,
    ).bind(id).run();

    expect((await call("DELETE", `/v1/admin/providers/${id}`)).status).toBe(200);

    const row = await env.DB.prepare(
      "SELECT provider_id, cost_usd FROM app_usage_event WHERE app_id = 'deleted-provider-app'",
    ).first<{ provider_id: string; cost_usd: number }>();
    expect(row?.provider_id).toBe(id);
    expect(row?.cost_usd).toBe(0.5);

    await env.DB.prepare("DELETE FROM app_usage_event WHERE app_id = 'deleted-provider-app'").run();
  });
});
