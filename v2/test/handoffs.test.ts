/**
 * Step 2d part 3: the writes an agent hands to a person. A provider key
 * entered on the console's approval page, and an app or app key created once
 * in two calls, its key revealed to a person once.
 *
 * Each test acts in an account of its own (a seeded person and their console
 * sign-in), so the per-account operation limit is never shared between tests.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { attestAuthentication, clearCaches, LOAD_MANAGEMENT_TIMEOUT_MS, loadManagement, seedHuman, seedManagementKey } from "./helpers.ts";

beforeAll(loadManagement, LOAD_MANAGEMENT_TIMEOUT_MS);

const API = "https://gateway.test";
const CONSOLE = "https://console.gateway.test";
const KEY = "sk-entered-by-a-person-0123456789";

beforeEach(() => {
  clearCaches();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

type Caller = { cookie: string } | { key: string } | null;

interface Sent {
  base?: string;
  origin?: string;
  environment?: Env;
}

async function send(caller: Caller, method: string, path: string, body?: unknown, { base = API, origin, environment = env }: Sent = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (caller !== null && "key" in caller) headers.set("authorization", `Bearer ${caller.key}`);
  if (caller !== null && "cookie" in caller) {
    headers.set("cookie", caller.cookie);
    headers.set("x-console-request", "1");
  }
  if (origin !== undefined) headers.set("origin", origin);
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    environment,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}

/** The approval page's call: from the console's own origin, with nobody signed in. */
function page(path: string, body: unknown) {
  return send(null, "POST", path, body, { base: CONSOLE, origin: CONSOLE });
}

async function person() {
  const human = await seedHuman();
  return { ...human, caller: { cookie: human.cookie } as const };
}

/** The proof in an approval link's fragment. */
function proofOf(url: string): string {
  return new URL(url).hash.slice(1);
}

const apiKeyConfig = { authentication: { type: "api_key", end_user: { source: "none" } }, routing: { providers: {} } };

describe("adding a provider connection through a person", () => {
  it("names the account the key goes into, and where a custom address sends it", async () => {
    const { caller, accountId } = await person();
    const opened = await send(caller, "POST", "/v2/admin/provider-handoffs", {
      type: "openai",
      name: "Own host",
      slug: "own-host",
      baseUrl: "https://llm.example.net/",
    });
    const shown = await page(`/v2/console/handoffs/${opened.body.id}`, { proof: proofOf(opened.body.url) });
    expect(shown.body.account.id).toBe(accountId);
    expect(typeof shown.body.account.name).toBe("string");
    expect(shown.body.review.destinations).toEqual(["https://llm.example.net/"]);
  });

  it("names every host a provider sends the key to", async () => {
    const { caller } = await person();
    const opened = await send(caller, "POST", "/v2/admin/provider-handoffs", { type: "fal", name: "fal" });
    const shown = await page(`/v2/console/handoffs/${opened.body.id}`, { proof: proofOf(opened.body.url) });
    expect(shown.body.review.destinations).toEqual(["https://fal.run/", "https://queue.fal.run/"]);
  });

  it("opens a step, lets the link's holder enter the key, and never answers the key", async () => {
    const { caller } = await person();
    const opened = await send(caller, "POST", "/v2/admin/provider-handoffs", { type: "openai", name: "OpenAI", slug: "openai-person" });
    expect(opened.status).toBe(201);
    expect(opened.body.kind).toBe("provider.add");
    expect(opened.body.url.startsWith(`${CONSOLE}/v2/approve/${opened.body.id}#`)).toBe(true);
    // Nothing is created until a person approves.
    expect((await send(caller, "GET", "/v2/admin/providers")).body.providers).toEqual([]);
    expect((await send(caller, "GET", `/v2/admin/operations/${opened.body.id}`)).body.state).toBe("pending");

    const proof = proofOf(opened.body.url);
    const shown = await page(`/v2/console/handoffs/${opened.body.id}`, { proof });
    expect(shown.status).toBe(200);
    expect(shown.body.review).toEqual({ type: "openai", name: "OpenAI", slug: "openai-person", baseUrl: null, destinations: ["https://api.openai.com/"] });

    const approved = await page(`/v2/console/handoffs/${opened.body.id}/submit`, { proof, secret: KEY });
    expect(approved.status).toBe(200);
    expect(approved.body).toEqual({ state: "completed" });
    expect(approved.text).not.toContain(KEY);

    const providers = (await send(caller, "GET", "/v2/admin/providers")).body.providers;
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({ slug: "openai-person", secretHint: "6789", revision: 1 });
    const status = await send(caller, "GET", `/v2/admin/operations/${opened.body.id}`);
    expect(status.body).toMatchObject({ state: "completed", result: { provider: { slug: "openai-person" } } });
    expect(status.text).not.toContain(KEY);

    // The key is sealed for the connection, and the call path can open it.
    const row = await env.DB.prepare("SELECT secret_blob FROM provider_connection WHERE slug = 'openai-person'").first<{ secret_blob: string }>();
    expect(row!.secret_blob).not.toContain(KEY);

    // Approving again answers as approved, and adds nothing.
    expect((await page(`/v2/console/handoffs/${opened.body.id}/submit`, { proof, secret: KEY })).body).toEqual({ state: "completed" });
    expect((await send(caller, "GET", "/v2/admin/providers")).body.providers).toHaveLength(1);
  });

  it("refuses a wrong proof and a call from anywhere but the console's page", async () => {
    const { caller } = await person();
    const opened = await send(caller, "POST", "/v2/admin/provider-handoffs", { type: "openai", name: "OpenAI" });
    const path = `/v2/console/handoffs/${opened.body.id}`;
    expect((await page(path, { proof: "x".repeat(43) })).status).toBe(403);
    expect((await send(null, "POST", path, { proof: proofOf(opened.body.url) }, { base: CONSOLE })).status).toBe(403);
    expect((await send(null, "POST", path, { proof: proofOf(opened.body.url) }, { base: API, origin: API })).status).toBe(404);
  });

  it("checks what it can before recording anything", async () => {
    const { caller } = await person();
    expect((await send(caller, "POST", "/v2/admin/provider-handoffs", { type: "nope", name: "X" })).status).toBe(400);
    expect((await send(caller, "POST", "/v2/admin/provider-handoffs", { type: "openai", name: "X", secret: KEY })).status).toBe(400);
    expect((await send(caller, "POST", "/v2/admin/provider-handoffs", { type: "openai", name: "X", baseUrl: "http://10.0.0.1" })).status).toBe(400);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM mgmt_operation WHERE kind = 'provider.add.browser'").first<{ n: number }>();
    const before = count!.n;
    await send(caller, "POST", "/v2/admin/providers", { type: "openai", name: "Taken", slug: "taken", secret: KEY });
    expect((await send(caller, "POST", "/v2/admin/provider-handoffs", { type: "openai", name: "X", slug: "taken" })).status).toBe(409);
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM mgmt_operation WHERE kind = 'provider.add.browser'").first<{ n: number }>();
    expect(after!.n).toBe(before);
  });

  it("refuses an approval that would take a slug added meanwhile, and adds nothing", async () => {
    const { caller } = await person();
    const opened = await send(caller, "POST", "/v2/admin/provider-handoffs", { type: "openai", name: "Late", slug: "late" });
    await send(caller, "POST", "/v2/admin/providers", { type: "openai", name: "First", slug: "late", secret: "sk-other-key-000000000" });
    const approved = await page(`/v2/console/handoffs/${opened.body.id}/submit`, { proof: proofOf(opened.body.url), secret: KEY });
    expect(approved.status).toBe(409);
    expect(approved.text).not.toContain(KEY);
    const providers = (await send(caller, "GET", "/v2/admin/providers")).body.providers;
    expect(providers.map((provider: { name: string }) => provider.name)).toEqual(["First"]);
    expect((await send(caller, "GET", `/v2/admin/operations/${opened.body.id}`)).body.state).toBe("pending");
  });

  it("refuses an approval over the plan's ceiling, inside the write", async () => {
    const { caller } = await person();
    const hosted = {
      ...env,
      BILLING: { getTenantAccess: async () => ({ plan: { planKey: "p", planName: "P", isDefault: true, limits: { maxProviders: 1 } }, subscription: null }) },
    } as unknown as Env;
    const opened = await send(caller, "POST", "/v2/admin/provider-handoffs", { type: "openai", name: "Second", slug: "second" }, { environment: hosted });
    expect(opened.status).toBe(201);
    await send(caller, "POST", "/v2/admin/providers", { type: "openai", name: "First", slug: "first", secret: "sk-other-key-000000000" }, { environment: hosted });
    const approved = await send(
      null,
      "POST",
      `/v2/console/handoffs/${opened.body.id}/submit`,
      { proof: proofOf(opened.body.url), secret: KEY },
      { base: CONSOLE, origin: CONSOLE, environment: hosted },
    );
    expect(approved.status).toBe(409);
    expect(approved.body.error.code).toBe("billing_plan_limit_reached");
    expect((await send(caller, "GET", "/v2/admin/providers")).body.providers).toHaveLength(1);
  });

  it("lets the link's holder decline, and the opener is told", async () => {
    const { caller } = await person();
    const opened = await send(caller, "POST", "/v2/admin/provider-handoffs", { type: "openai", name: "OpenAI" });
    const proof = proofOf(opened.body.url);
    expect((await page(`/v2/console/handoffs/${opened.body.id}/deny`, { proof })).body).toEqual({ state: "denied" });
    expect((await send(caller, "GET", `/v2/admin/operations/${opened.body.id}`)).body).toMatchObject({ state: "expired", denied: true });
    const late = await page(`/v2/console/handoffs/${opened.body.id}/submit`, { proof, secret: KEY });
    expect(late.status).toBe(409);
    expect((await send(caller, "GET", "/v2/admin/providers")).body.providers).toEqual([]);
  });
});

describe("replacing a provider key through a person", () => {
  it("replaces the key at the revision it was asked for", async () => {
    const { caller } = await person();
    const created = await send(caller, "POST", "/v2/admin/providers", { type: "openai", name: "OpenAI", slug: "openai", secret: "sk-old-key-000000001111" });
    const id = created.body.provider.id;
    expect((await send(caller, "POST", `/v2/admin/providers/${id}/key-handoffs`, { revision: 7 })).status).toBe(409);
    const opened = await send(caller, "POST", `/v2/admin/providers/${id}/key-handoffs`, { revision: 1 });
    expect(opened.body.kind).toBe("provider.rotate-key");
    const proof = proofOf(opened.body.url);
    expect((await page(`/v2/console/handoffs/${opened.body.id}`, { proof })).body.review).toMatchObject({ slug: "openai", secretHint: "1111" });

    expect((await page(`/v2/console/handoffs/${opened.body.id}/submit`, { proof, secret: KEY })).body).toEqual({ state: "completed" });
    const provider = (await send(caller, "GET", `/v2/admin/providers/${id}`)).body.provider;
    expect(provider).toMatchObject({ secretHint: "6789", revision: 2 });
  });

  it("refuses the replacement when the connection changed since it was asked for", async () => {
    const { caller } = await person();
    const created = await send(caller, "POST", "/v2/admin/providers", { type: "openai", name: "OpenAI", slug: "openai", secret: "sk-old-key-000000001111" });
    const id = created.body.provider.id;
    const opened = await send(caller, "POST", `/v2/admin/providers/${id}/key-handoffs`, { revision: 1 });
    await send(caller, "PUT", `/v2/admin/providers/${id}`, { revision: 1, name: "Renamed" });
    const approved = await page(`/v2/console/handoffs/${opened.body.id}/submit`, { proof: proofOf(opened.body.url), secret: KEY });
    expect(approved.status).toBe(409);
    expect((await send(caller, "GET", `/v2/admin/providers/${id}`)).body.provider).toMatchObject({ secretHint: "1111", revision: 2 });
  });
});

describe("creating an app once", () => {
  it("reserves, creates once, repeats the answer, and never answers the key", async () => {
    const { caller } = await person();
    const reserved = await send(caller, "POST", "/v2/admin/reserved/apps", { name: "Agent app", config: apiKeyConfig });
    expect(reserved.status).toBe(200);
    expect(reserved.body).toMatchObject({ state: "reserved" });
    expect(reserved.body.handle).not.toBe(reserved.body.id);
    expect((await send(caller, "GET", "/v2/admin/apps")).body.apps).toEqual([]);

    const request = { name: "Agent app", config: apiKeyConfig, handle: reserved.body.handle };
    const created = await send(caller, "POST", "/v2/admin/reserved/apps", request);
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ state: "created", id: reserved.body.id, replayed: false, app: { name: "Agent app" } });
    expect(Object.keys(created.body.api_key).sort()).toEqual(["created_at", "id", "key_prefix", "name"]);
    expect(created.body.reveal_url).toBe(`${CONSOLE}/v2/reveal/${reserved.body.id}`);

    const repeated = await send(caller, "POST", "/v2/admin/reserved/apps", request);
    expect(repeated.body).toMatchObject({ state: "created", replayed: true, app: { id: created.body.app.id } });
    expect((await send(caller, "GET", "/v2/admin/apps")).body.apps).toHaveLength(1);

    // The same handle with other arguments is refused, before and after it ran.
    const other = await send(caller, "POST", "/v2/admin/reserved/apps", { ...request, name: "Other" });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("operation_mismatch");
    const unknown = await send(caller, "POST", "/v2/admin/reserved/apps", { ...request, handle: "never-given-out" });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("operation_not_found");

    const status = await send(caller, "GET", `/v2/admin/operations/${reserved.body.id}`);
    expect(status.body).toMatchObject({ state: "completed", kind: "app.add.reserved", reveal_url: created.body.reveal_url });
    expect(status.body.result.api_key.key).toBeUndefined();
  });

  it("reveals the key once, to a person on the console's page", async () => {
    const { caller } = await person();
    const reserved = await send(caller, "POST", "/v2/admin/reserved/apps", { name: "Revealed", config: apiKeyConfig });
    const created = await send(caller, "POST", "/v2/admin/reserved/apps", { name: "Revealed", config: apiKeyConfig, handle: reserved.body.handle });
    const path = `/v2/admin/operations/${created.body.id}/reveal`;

    expect((await send(caller, "POST", path, undefined, { base: API, origin: API })).status).toBe(403);
    const revealed = await send(caller, "POST", path, undefined, { base: CONSOLE, origin: CONSOLE });
    expect(revealed.status).toBe(200);
    expect(revealed.body.result.api_key.key).toMatch(/^agw_/u);
    expect(revealed.body.result.api_key.id).toBe(created.body.api_key.id);

    const again = await send(caller, "POST", path, undefined, { base: CONSOLE, origin: CONSOLE });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("already_revealed");
    expect((await send(caller, "GET", `/v2/admin/operations/${created.body.id}`)).body.reveal_url).toBeUndefined();
  });

  it("reveals to an admin of the operation's account while another account is selected", async () => {
    const human = await person();
    const reserved = await send(human.caller, "POST", "/v2/admin/reserved/apps", { name: "Elsewhere", config: apiKeyConfig });
    const created = await send(human.caller, "POST", "/v2/admin/reserved/apps", { name: "Elsewhere", config: apiKeyConfig, handle: reserved.body.handle });

    // The same person also owns another account, and the console selects it.
    const other = `acc_other_${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO mgmt_organization(id, name, created_by_user_id, created_at, updated_at) VALUES (?, 'Other', ?, ?, ?)").bind(other, human.userId, now, now),
      env.DB.prepare(
        "INSERT INTO mgmt_organization_user(id, organization_id, user_id, role, status, joined_at) VALUES (?, ?, ?, 'owner', 'active', ?)",
      ).bind(`mem_${other}`, other, human.userId, now),
    ]);
    const selected = await send(human.caller, "POST", "/v2/admin/accounts/select", { accountId: other });
    expect(selected.status).toBe(200);
    // The browser keeps the cookies the answer set, in place of those of the same name.
    const jar = new Map(human.cookie.split(/;\s*/u).map((pair) => [pair.split("=")[0]!, pair] as const));
    for (const set of selected.headers.getSetCookie()) {
      const pair = set.split(";")[0]!;
      jar.set(pair.split("=")[0]!, pair);
    }
    const switched = { cookie: [...jar.values()].join("; ") };
    expect((await send(switched, "GET", "/v2/admin/session")).body.session.account.id).toBe(other);

    const revealed = await send(switched, "POST", `/v2/admin/operations/${created.body.id}/reveal`, undefined, { base: CONSOLE, origin: CONSOLE });
    expect(revealed.status).toBe(200);
    expect(revealed.body.result.api_key.id).toBe(created.body.api_key.id);
  });

  it("refuses a management key on the reveal page's call", async () => {
    const key = await seedManagementKey();
    const reserved = await send({ key }, "POST", "/v2/admin/reserved/apps", { name: "Keyed", config: apiKeyConfig });
    const created = await send({ key }, "POST", "/v2/admin/reserved/apps", { name: "Keyed", config: apiKeyConfig, handle: reserved.body.handle });
    const revealed = await send({ key }, "POST", `/v2/admin/operations/${created.body.id}/reveal`, undefined, { base: CONSOLE, origin: CONSOLE });
    expect(revealed.status).toBe(403);
    expect(revealed.text).not.toMatch(/"key":"agw_/u);
  });

  it("repeats a create's answer after the account changed, without checking it again", async () => {
    const { caller } = await person();
    const provider = (await send(caller, "POST", "/v2/admin/providers", { type: "openai", name: "OpenAI", slug: "routed", secret: "sk-old-key-000000001111" })).body.provider;
    const document = {
      name: "Routed",
      config: { ...apiKeyConfig, routing: { providers: { routed: { operations: ["openai.chat"], models: ["gpt-4o-mini"] } } } },
    };
    const reserved = await send(caller, "POST", "/v2/admin/reserved/apps", document);
    const created = await send(caller, "POST", "/v2/admin/reserved/apps", { ...document, handle: reserved.body.handle });
    expect(created.body.state).toBe("created");
    // The connection the app names is gone: a fresh create would be refused, a repeat is not.
    await send(caller, "DELETE", `/v2/admin/providers/${provider.id}`);
    const repeated = await send(caller, "POST", "/v2/admin/reserved/apps", { ...document, handle: reserved.body.handle });
    expect(repeated.status).toBe(200);
    expect(repeated.body).toMatchObject({ replayed: true, app: { id: created.body.app.id } });
  });

  it("refuses to reserve or create a key no page could reveal", async () => {
    const { caller } = await person();
    const reserved = await send(caller, "POST", "/v2/admin/reserved/apps", { name: "No console", config: apiKeyConfig });
    const noConsole = { ...env, CONSOLE_ORIGIN: "", DEPLOYMENT_ID: "test-deployment" } as unknown as Env;
    const refused = await send(caller, "POST", "/v2/admin/reserved/apps", { name: "No console", config: apiKeyConfig }, { environment: noConsole });
    expect(refused.status).toBe(503);
    const executed = await send(
      caller,
      "POST",
      "/v2/admin/reserved/apps",
      { name: "No console", config: apiKeyConfig, handle: reserved.body.handle },
      { environment: noConsole },
    );
    expect(executed.status).toBe(503);
    expect((await send(caller, "GET", "/v2/admin/apps")).body.apps).toEqual([]);
  });

  it("repeats a finished create's answer after the console origin was removed", async () => {
    const { caller } = await person();
    const reserved = await send(caller, "POST", "/v2/admin/reserved/apps", { name: "Later", config: apiKeyConfig });
    const request = { name: "Later", config: apiKeyConfig, handle: reserved.body.handle };
    const created = await send(caller, "POST", "/v2/admin/reserved/apps", request);
    const noConsole = { ...env, CONSOLE_ORIGIN: "", DEPLOYMENT_ID: "test-deployment" } as unknown as Env;
    const repeated = await send(caller, "POST", "/v2/admin/reserved/apps", request, { environment: noConsole });
    expect(repeated.status).toBe(200);
    expect(repeated.body).toMatchObject({ replayed: true, app: { id: created.body.app.id } });
    expect(repeated.body.reveal_url).toBeUndefined();
    const status = await send(caller, "GET", `/v2/admin/operations/${created.body.id}`, undefined, { environment: noConsole });
    expect(status.status).toBe(200);
    expect(status.body.reveal_url).toBeUndefined();
  });

  it("creates an App Attest app with nothing to reveal", async () => {
    const { caller } = await person();
    const config = { authentication: attestAuthentication(), routing: { providers: {} } };
    const reserved = await send(caller, "POST", "/v2/admin/reserved/apps", { name: "Attest", config });
    expect(reserved.status).toBe(200);
    const created = await send(caller, "POST", "/v2/admin/reserved/apps", { name: "Attest", config, handle: reserved.body.handle });
    expect(created.body).toMatchObject({ state: "created", api_key: null });
    expect(created.body.reveal_url).toBeUndefined();
    // Nothing to reveal is refused, not answered with an empty key.
    const reveal = () => send(caller, "POST", `/v2/admin/operations/${created.body.id}/reveal`, undefined, { base: CONSOLE, origin: CONSOLE });
    expect((await reveal()).status).toBe(410);
    // cf-auth drops what failed to be revealed, so a second try is told it is gone.
    expect((await reveal()).status).toBe(409);
  });

  it("refuses the creation when the plan's ceiling filled after the reservation", async () => {
    const { caller } = await person();
    const hosted = {
      ...env,
      BILLING: { getTenantAccess: async () => ({ plan: { planKey: "p", planName: "P", isDefault: true, limits: { maxApps: 1 } }, subscription: null }) },
    } as unknown as Env;
    const reserved = await send(caller, "POST", "/v2/admin/reserved/apps", { name: "Second", config: apiKeyConfig }, { environment: hosted });
    expect(reserved.status).toBe(200);
    await send(caller, "POST", "/v2/admin/apps", { name: "First", config: apiKeyConfig }, { environment: hosted });
    const created = await send(caller, "POST", "/v2/admin/reserved/apps", { name: "Second", config: apiKeyConfig, handle: reserved.body.handle }, { environment: hosted });
    expect(created.status).toBe(409);
    expect(created.body.error.code).toBe("billing_plan_limit_reached");
    expect((await send(caller, "GET", "/v2/admin/apps")).body.apps.map((app: { name: string }) => app.name)).toEqual(["First"]);
  });
});

describe("creating an app key once", () => {
  it("creates one key for the reservation, however often it is sent", async () => {
    const { caller } = await person();
    const app = (await send(caller, "POST", "/v2/admin/apps", { name: "Keys", config: apiKeyConfig })).body.app;
    const path = `/v2/admin/reserved/apps/${app.id}/keys`;
    const reserved = await send(caller, "POST", path, { name: "Second key" });
    expect(reserved.body.state).toBe("reserved");
    const created = await send(caller, "POST", path, { name: "Second key", handle: reserved.body.handle });
    expect(created.body).toMatchObject({ state: "created", app_id: app.id, api_key: { name: "Second key" } });
    expect(created.body.api_key.key).toBeUndefined();
    expect(created.body.reveal_url).toBeDefined();
    await send(caller, "POST", path, { name: "Second key", handle: reserved.body.handle });
    const keys = (await send(caller, "GET", `/v2/admin/apps/${app.id}/keys`)).body.keys;
    expect(keys.map((key: { name: string }) => key.name).sort()).toEqual(["Initial key", "Second key"]);
  });
});

describe("the tools", () => {
  it("shows a created key's metadata through a tool, and never its value", async () => {
    const key = await seedManagementKey();
    const tool = (body: unknown) => send({ key }, "POST", "/v2/cli/tools/add_app", body);
    const reserved = await tool({ config: { name: "Via tool", config: apiKeyConfig } });
    expect(reserved.status).toBe(200);
    const handle = reserved.body.result.handle;
    const created = await tool({ config: { name: "Via tool", config: apiKeyConfig }, handle });
    expect(created.status).toBe(200);
    expect(created.body.result.api_key).toMatchObject({ name: "Initial key" });
    expect(created.body.result.api_key.key).toBeUndefined();
    expect(created.body.summary).toContain("reveal");

    const status = await send({ key }, "POST", "/v2/cli/tools/get_operation", { id: created.body.result.id });
    expect(status.body.result.result.api_key).toMatchObject({ name: "Initial key" });
    expect(status.body.result.result.api_key.key).toBeUndefined();
  });

  it("answers an approval link from add_provider, and refuses a key as an argument", async () => {
    const key = await seedManagementKey();
    const opened = await send({ key }, "POST", "/v2/cli/tools/add_provider", { type: "openai", name: "Tool", slug: "tool-openai" });
    expect(opened.status).toBe(200);
    expect(opened.body.result.url.startsWith(`${CONSOLE}/v2/approve/`)).toBe(true);
    const refused = await send({ key }, "POST", "/v2/cli/tools/add_provider", { type: "openai", name: "Tool", secret: KEY });
    expect(refused.status).toBe(400);
    expect(refused.text).not.toContain(KEY);
  });
});
