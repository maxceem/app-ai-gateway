import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { clearAppConfigCache } from "../src/core/config";
import { clearProviderCaches } from "../src/core/provider-store";
import { PROVIDER_TYPES } from "../src/core/providers";
import type { ProviderType } from "../src/core/types";
import { database } from "../src/db";
import { provider } from "../src/db/schema";
import {
  TEST_ORGANIZATION_ID,
  gatewayToken,
  seedApp,
  seedProvider,
  testProviderSecret,
} from "./helpers";

interface CapturedRequest {
  url: string;
  headers: Headers;
}

const OTHER_ORGANIZATION_ID = "provider-scope-organization";

let pending: ExecutionContext[] = [];

async function proxy(input: {
  appId: string;
  token: string;
  path: string;
  body: Record<string, unknown>;
}): Promise<Response> {
  const executionCtx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://example.test/v1/apps/${input.appId}/proxy/${input.path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.token}`,
        "content-type": "application/json",
        "x-app-version": "1.2.3",
      },
      body: JSON.stringify(input.body),
    }),
    env,
    executionCtx,
  );
  pending.push(executionCtx);
  return response;
}

function captureUpstream(): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
    captured.push({
      url: typeof request === "string"
        ? request
        : request instanceof URL ? request.toString() : request.url,
      headers: new Headers(init?.headers),
    });
    return Response.json({
      usage: { input_tokens: 1, output_tokens: 1, prompt_tokens: 1, completion_tokens: 1 },
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    });
  });
  return captured;
}

/** One representative native request per provider, using its own path shape. */
const NATIVE_CASES: Array<{
  type: ProviderType;
  path: string;
  body: Record<string, unknown>;
  nativeUrl: string;
  gatewayUrl: string;
  authHeader: string;
  authValue: string;
}> = [
  {
    type: "openai",
    path: "openai/v1/responses",
    body: { model: "gpt-5.6-sol", input: "hello" },
    nativeUrl: "https://api.openai.com/v1/responses",
    // Cloudflare's openai slug implies the v1/ prefix, so it is stripped there
    // and only there.
    gatewayUrl: "https://gateway.ai.cloudflare.com/v1/acct-1/gw-1/openai/responses",
    authHeader: "authorization",
    authValue: "Bearer test-openai-secret",
  },
  {
    type: "anthropic",
    path: "anthropic/v1/messages",
    body: { model: "claude-sonnet-5", max_tokens: 16, messages: [] },
    nativeUrl: "https://api.anthropic.com/v1/messages",
    gatewayUrl: "https://gateway.ai.cloudflare.com/v1/acct-1/gw-1/anthropic/v1/messages",
    authHeader: "x-api-key",
    authValue: "test-anthropic-secret",
  },
  {
    type: "xai",
    path: "xai/v1/responses",
    body: { model: "grok-4.5", input: "hello" },
    nativeUrl: "https://api.x.ai/v1/responses",
    gatewayUrl: "https://gateway.ai.cloudflare.com/v1/acct-1/gw-1/grok/v1/responses",
    authHeader: "authorization",
    authValue: "Bearer test-xai-secret",
  },
  {
    type: "gemini",
    path: "gemini/v1beta/models/gemini-3.6-flash:generateContent",
    body: { contents: [] },
    nativeUrl:
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent",
    gatewayUrl:
      "https://gateway.ai.cloudflare.com/v1/acct-1/gw-1/google-ai-studio/v1beta/models/gemini-3.6-flash:generateContent",
    authHeader: "x-goog-api-key",
    authValue: "test-gemini-secret",
  },
  {
    type: "perplexity",
    path: "perplexity/chat/completions",
    body: { model: "sonar-pro", messages: [] },
    nativeUrl: "https://api.perplexity.ai/chat/completions",
    gatewayUrl: "https://gateway.ai.cloudflare.com/v1/acct-1/gw-1/perplexity-ai/chat/completions",
    authHeader: "authorization",
    authValue: "Bearer test-perplexity-secret",
  },
];

const UNRESTRICTED = { provider_mode: "all", model_rewrites: {} };

beforeAll(async () => {
  // A second organization with no credentials of its own, so "not configured"
  // and cross-organization isolation can be exercised without disturbing the
  // fully provisioned default fixture.
  await env.DB.prepare(
    `INSERT OR IGNORE INTO console_organization(id, name, created_by_user_id, created_at, updated_at)
     VALUES (?, 'Scope Test', 'operator-test-owner', datetime('now'), datetime('now'))`,
  ).bind(OTHER_ORGANIZATION_ID).run();
});

beforeEach(() => {
  clearProviderCaches();
  clearAppConfigCache();
});

afterEach(async () => {
  await Promise.all(pending.map((context) => waitOnExecutionContext(context)));
  pending = [];
  vi.restoreAllMocks();
  vi.useRealTimers();
  clearProviderCaches();
  clearAppConfigCache();
});

describe("provider resolution on the hot path", () => {
  it.each(NATIVE_CASES)(
    "sends $type traffic to its native API with the organization's own key",
    async (testCase) => {
      const appId = `native-${testCase.type}`;
      await seedApp(appId, { proxy: UNRESTRICTED });
      const token = await gatewayToken(appId);
      const captured = captureUpstream();

      const response = await proxy({ appId, token, path: testCase.path, body: testCase.body });

      expect(response.status).toBe(200);
      expect(captured[0]?.url).toBe(testCase.nativeUrl);
      expect(captured[0]?.headers.get(testCase.authHeader)).toBe(testCase.authValue);
      for (const name of ["cf-aig-authorization", "cf-aig-metadata"]) {
        expect(captured[0]?.headers.get(name)).toBeNull();
      }
    },
  );

  it.each(NATIVE_CASES)(
    "routes $type through the organization's Cloudflare AI Gateway when configured",
    async (testCase) => {
      const appId = `aig-${testCase.type}`;
      await seedApp(appId, { proxy: UNRESTRICTED });
      const token = await gatewayToken(appId);
      await database(env.DB).delete(provider).where(eq(provider.type, testCase.type));
      await seedProvider({
        type: testCase.type,
        id: `aig-${testCase.type}`,
        secret: "cf-aig-run-token",
        gateway: "cf_aig",
        gatewayConfig: { accountId: "acct-1", gatewayId: "gw-1" },
      });
      const captured = captureUpstream();

      const response = await proxy({ appId, token, path: testCase.path, body: testCase.body });

      expect(response.status).toBe(200);
      expect(captured[0]?.url).toBe(testCase.gatewayUrl);
      expect(captured[0]?.headers.get("cf-aig-authorization")).toBe("Bearer cf-aig-run-token");
      expect(JSON.parse(captured[0]?.headers.get("cf-aig-metadata") ?? "null")).toEqual({
        app_id: appId,
        user_id: "user-1",
      });
      // The organization's gateway injects the provider key from its own store.
      expect(captured[0]?.headers.get(testCase.authHeader)).toBeNull();

      await database(env.DB).delete(provider).where(eq(provider.id, `aig-${testCase.type}`));
      await seedProvider({ type: testCase.type });
    },
  );

  it("fails loudly when the organization has no credential for the provider", async () => {
    const appId = "provider-missing";
    await seedApp(appId, { proxy: UNRESTRICTED, organizationId: OTHER_ORGANIZATION_ID });
    const token = await gatewayToken(appId);
    const fetchSpy = captureUpstream();

    const response = await proxy({
      appId,
      token,
      path: "openai/v1/responses",
      body: { model: "gpt-5.6-sol", input: "hello" },
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "provider_not_configured" },
    });
    expect(fetchSpy).toHaveLength(0);
  });

  it("reports provider_unavailable when the stored blob cannot be decrypted", async () => {
    const appId = "provider-broken-blob";
    await seedApp(appId, { proxy: UNRESTRICTED, organizationId: OTHER_ORGANIZATION_ID });
    const token = await gatewayToken(appId);
    await seedProvider({
      type: "openai",
      id: "broken-openai",
      organizationId: OTHER_ORGANIZATION_ID,
    });
    await database(env.DB)
      .update(provider)
      .set({ secretBlob: "local1.1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAA" })
      .where(eq(provider.id, "broken-openai"));
    clearProviderCaches();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await proxy({
      appId,
      token,
      path: "openai/v1/responses",
      body: { model: "gpt-5.6-sol", input: "hello" },
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "provider_unavailable" },
    });
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("provider_secret_unavailable");
    // Nothing that could leak the credential reaches the log line.
    expect(errorSpy.mock.calls.flat().join(" ")).not.toContain(testProviderSecret("openai"));

    await database(env.DB).delete(provider).where(eq(provider.id, "broken-openai"));
    clearProviderCaches();
  });

  it("reports provider_unavailable when the vault itself is misconfigured", async () => {
    const appId = "provider-broken-vault";
    await seedApp(appId, { proxy: UNRESTRICTED });
    const token = await gatewayToken(appId);
    const fetchSpy = captureUpstream();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const executionCtx = createExecutionContext();

    // Flipping the mode without clearing the other mode's bindings is caught as
    // mixed configuration; a deployment that cannot open its vault must say so
    // rather than proxy unauthenticated.
    const response = await worker.fetch(
      new Request(`https://example.test/v1/apps/${appId}/proxy/openai/v1/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-app-version": "1.2.3",
        },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello" }),
      }),
      { ...env, SECRET_VAULT_MODE: "kms" },
      executionCtx,
    );
    pending.push(executionCtx);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "provider_unavailable" },
    });
    expect(fetchSpy).toHaveLength(0);
    const logged = errorSpy.mock.calls.flat().join(" ");
    expect(logged).toContain("secret_vault_misconfigured");
    expect(logged).toContain("SECRET_VAULT_LOCAL_KEK_CURRENT_VERSION is not allowed in kms mode");
  });

  it("keeps a revoked credential in rotation only until the cache TTL expires", async () => {
    const appId = "provider-revocation";
    await seedApp(appId, { proxy: UNRESTRICTED, organizationId: OTHER_ORGANIZATION_ID });
    const token = await gatewayToken(appId);
    await seedProvider({
      type: "openai",
      id: "revocable-openai",
      organizationId: OTHER_ORGANIZATION_ID,
    });
    captureUpstream();
    vi.useFakeTimers();

    const warm = await proxy({
      appId,
      token,
      path: "openai/v1/responses",
      body: { model: "gpt-5.6-sol", input: "hello" },
    });
    expect(warm.status).toBe(200);

    await database(env.DB)
      .update(provider)
      .set({ status: "revoked" })
      .where(eq(provider.id, "revocable-openai"));

    const stillWarm = await proxy({
      appId,
      token,
      path: "openai/v1/responses",
      body: { model: "gpt-5.6-sol", input: "hello" },
    });
    expect(stillWarm.status).toBe(200);

    vi.advanceTimersByTime(61_000);
    const afterTtl = await proxy({
      appId,
      token,
      path: "openai/v1/responses",
      body: { model: "gpt-5.6-sol", input: "hello" },
    });
    expect(afterTtl.status).toBe(502);
    await expect(afterTtl.json()).resolves.toMatchObject({
      error: { code: "provider_not_configured" },
    });

    await database(env.DB).delete(provider).where(eq(provider.id, "revocable-openai"));
  });

  it("keeps one organization's credentials out of another's requests", async () => {
    const appId = "provider-scoped";
    await seedApp(appId, { proxy: UNRESTRICTED, organizationId: OTHER_ORGANIZATION_ID });
    const token = await gatewayToken(appId);
    await seedProvider({
      type: "openai",
      id: "scoped-openai",
      organizationId: OTHER_ORGANIZATION_ID,
      secret: "sk-other-organization",
    });
    const captured = captureUpstream();

    const response = await proxy({
      appId,
      token,
      path: "openai/v1/responses",
      body: { model: "gpt-5.6-sol", input: "hello" },
    });

    expect(response.status).toBe(200);
    expect(captured[0]?.headers.get("authorization")).toBe("Bearer sk-other-organization");

    await database(env.DB).delete(provider).where(eq(provider.id, "scoped-openai"));
  });
});

describe("custom model pricing", () => {
  it("rejects a model the catalog does not price, and names where to fix it", async () => {
    const appId = "pricing-missing";
    await seedApp(appId, { proxy: UNRESTRICTED });
    const token = await gatewayToken(appId);
    const fetchSpy = captureUpstream();

    const response = await proxy({
      appId,
      token,
      path: "openai/v1/responses",
      body: { model: "gpt-brand-new", input: "hello" },
    });

    expect(response.status).toBe(400);
    const body = await response.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("pricing_not_configured");
    expect(body.error.message).toContain("custom model pricing");
    expect(fetchSpy).toHaveLength(0);
  });

  it("proxies and bills a model priced only by the provider row's overrides", async () => {
    const appId = "pricing-override";
    await seedApp(appId, { proxy: UNRESTRICTED, organizationId: OTHER_ORGANIZATION_ID });
    const token = await gatewayToken(appId);
    await seedProvider({
      type: "openai",
      id: "priced-openai",
      organizationId: OTHER_ORGANIZATION_ID,
      pricing: { "gpt-brand-new": { input: 2, output: 10 } },
    });
    captureUpstream();

    const response = await proxy({
      appId,
      token,
      path: "openai/v1/responses",
      body: { model: "gpt-brand-new", input: "hello" },
    });
    expect(response.status).toBe(200);
    await response.text();
    await Promise.all(pending.map((context) => waitOnExecutionContext(context)));
    pending = [];

    const row = await env.DB.prepare(
      `SELECT cost_usd, provider_id, provider_type FROM app_usage_event
        WHERE app_id = ? ORDER BY id DESC LIMIT 1`,
    ).bind(appId).first<{ cost_usd: number; provider_id: string; provider_type: string }>();
    // 1 input token at $2/1M plus 1 output token at $10/1M.
    expect(row?.cost_usd).toBeCloseTo(12 / 1_000_000, 12);
    expect(row?.provider_id).toBe("priced-openai");
    expect(row?.provider_type).toBe("openai");

    await database(env.DB).delete(provider).where(eq(provider.id, "priced-openai"));
  });

  it("lets an override win over a stale catalog price", async () => {
    const appId = "pricing-stale";
    await seedApp(appId, { proxy: UNRESTRICTED, organizationId: OTHER_ORGANIZATION_ID });
    const token = await gatewayToken(appId);
    await seedProvider({
      type: "openai",
      id: "restated-openai",
      organizationId: OTHER_ORGANIZATION_ID,
      pricing: { "gpt-5.6-sol": { input: 0, output: 0 } },
    });
    captureUpstream();

    const response = await proxy({
      appId,
      token,
      path: "openai/v1/responses",
      body: { model: "gpt-5.6-sol", input: "hello" },
    });
    expect(response.status).toBe(200);
    await response.text();
    await Promise.all(pending.map((context) => waitOnExecutionContext(context)));
    pending = [];

    const row = await env.DB.prepare(
      "SELECT cost_usd FROM app_usage_event WHERE app_id = ? ORDER BY id DESC LIMIT 1",
    ).bind(appId).first<{ cost_usd: number }>();
    expect(row?.cost_usd).toBe(0);

    await database(env.DB).delete(provider).where(eq(provider.id, "restated-openai"));
  });
});

describe("the default fixture", () => {
  it("configures every provider type for the test organization", async () => {
    const rows = await database(env.DB)
      .select({ type: provider.type })
      .from(provider)
      .where(eq(provider.organizationId, TEST_ORGANIZATION_ID));
    expect(rows.map((row) => row.type).sort()).toEqual([...PROVIDER_TYPES].sort());
  });
});
