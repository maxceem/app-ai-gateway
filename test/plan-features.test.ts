import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingAccess, BillingRuntime } from "../src/billing/contract";
import { planFeatures, planIncludes } from "../src/billing/features";
import type { GatewayBillingAccess } from "../src/billing/gateway";
import app from "../src/index";
import { clearIsolateCaches, seedHuman, seedServerApp } from "./helpers";
import { TEST_MANAGEMENT_KEY } from "./apply-migrations";

const ORIGIN = "https://example.test";
const OPERATOR = { authorization: `Bearer ${TEST_MANAGEMENT_KEY}` };

beforeEach(() => clearIsolateCaches());
afterEach(() => vi.restoreAllMocks());

function onPlan(limits?: unknown, isDefault = false): BillingAccess {
  return { plan: { planKey: "plan", planName: "Plan", isDefault, limits }, subscription: null };
}

function billed(limits?: unknown): GatewayBillingAccess {
  return { state: "billed", ...onPlan(limits) };
}

/** The test environment with a billing service answering `access` — swappable, as a plan change is. */
function hosted(initial: BillingAccess) {
  let access = initial;
  const binding = { getTenantAccess: async () => access } as Partial<BillingRuntime>;
  const bindings = new Proxy(env, {
    get: (target, property, receiver) => property === "BILLING" ? binding : Reflect.get(target, property, receiver),
  }) as Env;
  return {
    env: bindings,
    moveTo(next: BillingAccess) {
      access = next;
      clearIsolateCaches();
    },
  };
}

async function call(bindings: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const context = createExecutionContext();
  const response = await app.fetch(new Request(`${ORIGIN}${path}`, init), bindings, context);
  const bytes = await response.arrayBuffer();
  await waitOnExecutionContext(context);
  return new Response(bytes, { status: response.status, headers: response.headers });
}

/** Saves the app with `conversations.store` set as given, the way the console does. */
async function saveStore(bindings: Env, appId: string, store: boolean): Promise<Response> {
  const current = await (await call(bindings, `/v1/admin/apps/${appId}`, { headers: OPERATOR }))
    .json() as { app: { name: string; config: Record<string, unknown>; revision: number } };
  return call(bindings, `/v1/admin/apps/${appId}`, {
    method: "PUT",
    headers: { ...OPERATOR, "content-type": "application/json" },
    body: JSON.stringify({
      name: current.app.name,
      revision: current.app.revision,
      config: { ...current.app.config, conversations: { store } },
    }),
  });
}

async function proxied(bindings: Env, appId: string, key: string): Promise<Response> {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ id: "resp_1", output_text: "ok", usage: { input_tokens: 1, output_tokens: 1 } }));
  return call(bindings, `/v1/apps/${appId}/proxy/openai/v1/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-end-user-id": "user-1" },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: "hi" }),
  });
}

describe("plan features", () => {
  it("includes every feature without billing, and without an includes list", () => {
    expect(planFeatures({ state: "self_hosted" })).toEqual({ conversationStorage: true, humanSupport: true });
    expect(planFeatures(billed())).toEqual({ conversationStorage: true, humanSupport: true });
    expect(planFeatures(billed({ maxApps: 3 }))).toEqual({ conversationStorage: true, humanSupport: true });
  });

  it("includes only what a plan lists, and ignores names it does not know", () => {
    expect(planFeatures(billed({ includes: [] }))).toEqual({ conversationStorage: false, humanSupport: false });
    expect(planFeatures(billed({ includes: ["conversationStorage", "somethingLater"] })))
      .toEqual({ conversationStorage: true, humanSupport: false });
  });

  it("includes nothing without a plan, and while billing is unreachable only what may wait for it", () => {
    expect(planFeatures({ state: "billed", plan: null, subscription: null }))
      .toEqual({ conversationStorage: false, humanSupport: false });
    expect(planFeatures({ state: "unavailable" })).toEqual({ conversationStorage: false, humanSupport: true });
  });

  it.each([
    ["a string", "conversationStorage"],
    ["null", null],
    ["a list with a non-name", ["conversationStorage", 1]],
  ])("fails closed when includes is %s", (_label, includes) => {
    expect(() => planIncludes(billed({ includes }), "conversationStorage"))
      .toThrowError(/^Billing plan limit includes is invalid$/u);
  });

  it("reports what the plan includes in the billing status", async () => {
    const human = await seedHuman();
    const { env: bindings } = hosted(onPlan({ includes: ["humanSupport"] }));
    const response = await call(bindings, "/v1/admin/billing/status", {
      headers: { cookie: human.cookie, "x-console-request": "1", origin: ORIGIN },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      limits: { includes: ["humanSupport"] },
      features: { conversationStorage: false, humanSupport: true },
    });
  });
});

describe("conversation history as a plan feature", () => {
  it("refuses to turn it on under a plan that leaves it out, and allows it under one that includes it", async () => {
    await seedServerApp("feature-store-on");
    const plan = hosted(onPlan({ includes: [] }, true));
    const refused = await saveStore(plan.env, "feature-store-on", true);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: "billing_feature_not_included" } });

    // Validation answers the same, so the console learns it before saving.
    const current = await (await call(plan.env, "/v1/admin/apps/feature-store-on", { headers: OPERATOR }))
      .json() as { app: { name: string; config: Record<string, unknown> } };
    const validated = await call(plan.env, "/v1/admin/apps/feature-store-on/validate", {
      method: "POST",
      headers: { ...OPERATOR, "content-type": "application/json" },
      body: JSON.stringify({ name: current.app.name, config: { ...current.app.config, conversations: { store: true } } }),
    });
    expect(validated.status).toBe(403);

    plan.moveTo(onPlan({ includes: ["conversationStorage"] }));
    expect((await saveStore(plan.env, "feature-store-on", true)).status).toBe(200);
  });

  it("keeps an app editable after its plan stops including it, and stores nothing new until it does again", async () => {
    const appId = "feature-store-downgrade";
    const key = await seedServerApp(appId);
    const plan = hosted(onPlan({ includes: ["conversationStorage"] }));
    expect((await saveStore(plan.env, appId, true)).status).toBe(200);
    expect((await proxied(plan.env, appId, key)).status).toBe(200);
    expect(await env.CONVERSATION_LOG.getByName(appId).pendingCount()).toBe(1);

    plan.moveTo(onPlan({ includes: [] }, true));
    // Saved again with the setting it already has: accepted, so nothing else about the app is locked.
    expect((await saveStore(plan.env, appId, true)).status).toBe(200);
    expect((await proxied(plan.env, appId, key)).status).toBe(200);
    expect(await env.CONVERSATION_LOG.getByName(appId).pendingCount()).toBe(1);

    plan.moveTo(onPlan({ includes: ["conversationStorage"] }));
    expect((await proxied(plan.env, appId, key)).status).toBe(200);
    expect(await env.CONVERSATION_LOG.getByName(appId).pendingCount()).toBe(2);
  });

  it("asks nothing of billing where there is none", async () => {
    await seedServerApp("feature-store-self-hosted");
    expect((await saveStore(env, "feature-store-self-hosted", true)).status).toBe(200);
  });
});
