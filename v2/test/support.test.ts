/**
 * Human support (v1's `support.test.ts`, ported): a message opens a ticket at
 * the help desk bound as `HELPDESK`, only where the deployment has plans and
 * an inbox, and only for a plan that includes `humanSupport`. The help desk
 * here is a fake that records what it was given; nothing is sent anywhere.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import type { HelpdeskRuntime, HelpdeskTicketInput, HelpdeskTicketResult } from "../src/helpdesk/contract.ts";
import { BILLING_ACCESS_CACHE_TTL_MS, CONSOLE_BILLING_DEADLINE_MS, getAppTrafficBillingAccess, requirePlanFeature } from "../src/billing/access.ts";
import { clearCaches, LOAD_MANAGEMENT_TIMEOUT_MS, loadManagement, seedHuman, seedManagementKey, useFakeClock, type SeededHuman } from "./helpers.ts";

beforeAll(loadManagement, LOAD_MANAGEMENT_TIMEOUT_MS);

beforeEach(() => {
  clearCaches();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const API = "https://gateway.test";
const CONSOLE = "https://console.gateway.test";

interface Access {
  plan: { planKey: string; planName: string; isDefault: boolean; limits?: Record<string, unknown> | null } | null;
  subscription: null;
}

/** A plan, with the features its plan data says it includes; without a list, every one. */
function plan(planName: string, isDefault: boolean, includes?: string[]): Access {
  return { plan: { planKey: planName.toLowerCase(), planName, isDefault, ...(includes ? { limits: { includes } } : {}) }, subscription: null };
}

/** A deployment as a test needs it: with or without billing, a help desk and an inbox. */
function runtime(
  options: {
    access?: Access | "unreachable" | null;
    helpdesk?: false | "unreachable" | ((input: HelpdeskTicketInput) => HelpdeskTicketResult);
    inbox?: string | null;
  } = {},
) {
  const tickets: HelpdeskTicketInput[] = [];
  const helpdesk: HelpdeskRuntime = {
    createTicket: async (input) => {
      if (options.helpdesk === "unreachable") throw new Error("the help desk is down");
      tickets.push(input);
      if (typeof options.helpdesk === "function") return options.helpdesk(input);
      return { ok: true, reference: "SUP-7F3K2Q", duplicate: false, delivered: true, replyTo: input.customer.email };
    },
  };
  const billing =
    options.access === null
      ? undefined
      : {
          getTenantAccess: async () => {
            if (options.access === "unreachable") throw new Error("billing is down");
            return options.access ?? plan("Pro", false);
          },
        };
  const testEnv = new Proxy(env, {
    get(target, property, receiver) {
      if (property === "BILLING") return billing;
      if (property === "HELPDESK") return options.helpdesk === false ? undefined : helpdesk;
      if (property === "SUPPORT_EMAIL") return options.inbox === null ? undefined : (options.inbox ?? "support@example.test");
      return Reflect.get(target, property, receiver);
    },
  }) as Env;
  return { env: testEnv, tickets };
}

async function call(testEnv: Env, request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function capabilities(testEnv: Env): Promise<{ supportEmail?: string }> {
  return (await call(testEnv, new Request(`${CONSOLE}/v2/console/capabilities`))).json();
}

/** Sent as the console sends it, with the session cookie (in the account a tab names), or as the CLI does, with a key. */
function send(testEnv: Env, credential: { cookie: string; account?: string } | { key: string }, body: Record<string, unknown>): Promise<Response> {
  const auth: Record<string, string> =
    "cookie" in credential
      ? { cookie: credential.cookie, "x-console-request": "1", ...(credential.account === undefined ? {} : { "x-account-id": credential.account }) }
      : { authorization: `Bearer ${credential.key}` };
  return call(
    testEnv,
    new Request(`${"cookie" in credential ? CONSOLE : API}/v2/admin/support`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function errorCode(response: Response): Promise<string | undefined> {
  return ((await response.json()) as { error?: { code?: string } }).error?.code;
}

/** A management key of this person, in their account, with the grant asked for. */
function managementKey(human: SeededHuman, grant: "read" | "manage"): Promise<string> {
  return seedManagementKey({ userId: human.userId, accountId: human.accountId, grant });
}

async function listedTools(testEnv: Env): Promise<string[]> {
  const response = await call(testEnv, new Request(`${API}/v2/cli/tools`));
  expect(response.status).toBe(200);
  return ((await response.json()) as { tools: { name: string }[] }).tools.map((tool) => tool.name);
}

/** As the console sends it: the page as the browser shows it, below the console's `/v2` base. */
const MESSAGE = { kind: "bug", message: "Streams stop halfway.", page: "/v2/apps/demo/usage" };

describe("support", () => {
  it("is advertised only where billing, a help desk and an inbox are all configured", async () => {
    expect((await capabilities(runtime().env)).supportEmail).toBe("support@example.test");
    expect((await capabilities(runtime({ access: null }).env)).supportEmail).toBeUndefined();
    expect((await capabilities(runtime({ helpdesk: false }).env)).supportEmail).toBeUndefined();
    expect((await capabilities(runtime({ inbox: null }).env)).supportEmail).toBeUndefined();
    expect((await capabilities(runtime({ inbox: "not an address" }).env)).supportEmail).toBeUndefined();
  });

  it("opens a ticket for a plan that includes it, as the person, with their account and the page", async () => {
    const human = await seedHuman();
    const { env: testEnv, tickets } = runtime();
    const response = await send(testEnv, human, MESSAGE);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "sent", reference: "SUP-7F3K2Q", replyTo: human.email, duplicate: false });
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({
      serviceId: "app-ai-gateway",
      kind: "bug",
      message: "Streams stop halfway.",
      customer: { email: human.email, userId: human.userId },
      account: { tenantId: human.accountId, plan: "Pro" },
      channel: "console",
      page: `${CONSOLE}/v2/apps/demo/usage`,
    });
  });

  it("takes a manage key, as the CLI sends, with its diagnostics, and refuses a read key", async () => {
    const human = await seedHuman();
    const { env: testEnv, tickets } = runtime();
    const read = await send(testEnv, { key: await managementKey(human, "read") }, MESSAGE);
    expect(read.status).toBe(403);
    expect(await errorCode(read)).toBe("grant_insufficient");

    const response = await send(testEnv, { key: await managementKey(human, "manage") }, {
      kind: "support",
      message: "How do I rotate a key?",
      context: { app_id: "demo", agw_version: "2.0.0" },
      client: "agw 2.0.0",
    });
    expect(response.status).toBe(200);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({
      kind: "support",
      customer: { email: human.email },
      channel: expect.stringMatching(/^(cli|api)$/u),
      client: "agw 2.0.0",
      context: { app_id: "demo", agw_version: "2.0.0" },
    });
  });

  it("lists contact_support only where the deployment offers support", async () => {
    expect(await listedTools(runtime().env)).toContain("contact_support");
    expect(await listedTools(runtime({ access: null }).env)).not.toContain("contact_support");
    expect(await listedTools(runtime({ helpdesk: false }).env)).not.toContain("contact_support");
  });

  it("refuses a plan that does not include support with its own code, and a deployment that offers no support", async () => {
    const human = await seedHuman();
    // Paid or not makes no difference: the plan's data says what it includes.
    for (const access of [plan("Free", true, []), plan("Starter", false, ["conversationStorage"])]) {
      clearCaches();
      const without = runtime({ access });
      const refused = await send(without.env, human, MESSAGE);
      expect(refused.status).toBe(403);
      expect(await errorCode(refused)).toBe("support_plan_required");
      expect(without.tickets).toHaveLength(0);
    }
    clearCaches();
    expect((await send(runtime({ access: plan("Growth", false, ["humanSupport"]) }).env, human, MESSAGE)).status).toBe(200);

    // A self-hosted deployment, without billing, offers none, as v1.
    for (const options of [{ access: null }, { helpdesk: false }, { inbox: null }] as const) {
      const unsupported = runtime(options);
      const response = await send(unsupported.env, human, MESSAGE);
      expect(response.status).toBe(404);
      expect(await errorCode(response)).toBe("not_found");
      expect(unsupported.tickets).toHaveLength(0);
    }
  });

  it("still sends while billing cannot be reached, and says the plan is unknown", async () => {
    const human = await seedHuman();
    const { env: testEnv, tickets } = runtime({ access: "unreachable" });
    expect((await send(testEnv, human, MESSAGE)).status).toBe(200);
    expect(tickets[0]!.account?.plan).toBe("unknown (billing unreachable)");
  });

  it("answers what the help desk refuses with the gateway's own errors", async () => {
    const human = await seedHuman();
    const cases: [HelpdeskTicketResult & { ok: false }, number, string][] = [
      [{ ok: false, code: "credential_detected", message: "The message looks like it contains a provider API key." }, 400, "invalid_request"],
      [{ ok: false, code: "invalid_input", message: "page: Invalid URL" }, 400, "invalid_request"],
      [{ ok: false, code: "rate_limited", message: "Too many tickets.", retryAfterSeconds: 120 }, 429, "rate_limited"],
      [{ ok: false, code: "unknown_service", message: "Unknown service." }, 404, "not_found"],
    ];
    for (const [result, status, code] of cases) {
      const response = await send(runtime({ helpdesk: () => result }).env, human, MESSAGE);
      expect(response.status, result.code).toBe(status);
      if (result.code !== "unknown_service") expect(await response.clone().text()).toContain(result.message);
      expect(await errorCode(response)).toBe(code);
      if (result.code === "rate_limited") expect(response.headers.get("Retry-After")).toBe("120");
    }
  });

  it("passes on a repeat the help desk recognised", async () => {
    const human = await seedHuman();
    const { env: testEnv } = runtime({
      helpdesk: (input) => ({ ok: true, reference: "SUP-7F3K2Q", duplicate: true, delivered: true, replyTo: input.customer.email }),
    });
    expect(await (await send(testEnv, human, MESSAGE)).json()).toMatchObject({ reference: "SUP-7F3K2Q", duplicate: true });
  });

  it("asks to try again later when the help desk cannot be reached, and logs nothing the person wrote or their address", async () => {
    const human = await seedHuman();
    const logged = [vi.spyOn(console, "error").mockImplementation(() => undefined), vi.spyOn(console, "warn").mockImplementation(() => undefined), vi.spyOn(console, "log").mockImplementation(() => undefined)];
    // The help desk's own error carries both, as an RPC failure may.
    const failed = await send(
      runtime({
        helpdesk: (input) => {
          throw new Error(`could not open a ticket for ${input.customer.email}: ${input.message}`);
        },
      }).env,
      human,
      MESSAGE,
    );
    expect(failed.status).toBe(503);
    expect(await errorCode(failed)).toBe("email_unavailable");
    const written = JSON.stringify(logged.map((spy) => spy.mock.calls));
    expect(written).toContain("support_helpdesk_failed");
    expect(written).not.toContain("Streams stop halfway.");
    expect(written).not.toContain(human.email);
  });

  it("refuses an address its owner has not verified: support replies to it", async () => {
    const human = await seedHuman();
    await env.DB.prepare("UPDATE mgmt_user SET email_verified = 0 WHERE id = ?").bind(human.userId).run();
    const { env: testEnv, tickets } = runtime();
    const refused = await send(testEnv, human, MESSAGE);
    expect(refused.status).toBe(403);
    expect(await errorCode(refused)).toBe("email_unverified");
    expect(tickets).toHaveLength(0);
  });

  it("reads the plan fresh within the console's deadline: late or failed sends with the plan unknown, no plan or no support refuses", async () => {
    const human = await seedHuman();
    // No plan at all, from a read that answered: refused.
    const none = runtime({ access: { plan: null, subscription: null } });
    const refused = await send(none.env, human, MESSAGE);
    expect(refused.status).toBe(403);
    expect(await errorCode(refused)).toBe("support_plan_required");
    expect(none.tickets).toHaveLength(0);

    // An eligible plan is named in the ticket.
    const eligible = runtime({ access: plan("Growth", false, ["humanSupport"]) });
    expect((await send(eligible.env, human, MESSAGE)).status).toBe(200);
    expect(eligible.tickets[0]!.account?.plan).toBe("Growth");

    // A read held past the deadline sends the ticket, the plan unknown.
    let release!: () => void;
    const held = runtime();
    const billing = (held.env as unknown as { BILLING: { getTenantAccess: () => Promise<Access> } }).BILLING;
    const answer = billing.getTenantAccess;
    billing.getTenantAccess = async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return answer();
    };
    useFakeClock();
    const pending = send(held.env, human, MESSAGE);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await vi.advanceTimersByTimeAsync(CONSOLE_BILLING_DEADLINE_MS);
    expect((await pending).status).toBe(200);
    expect(held.tickets[0]!.account?.plan).toBe("unknown (billing unreachable)");
    vi.useRealTimers();
    release();
  });

  it("sends while billing cannot be read, whatever plan app traffic kept, with the plan unknown (the owner's decision)", async () => {
    const human = await seedHuman();
    let down = false;
    const kept = runtime({ access: plan("Free", true, ["conversationStorage"]) });
    const billing = (kept.env as unknown as { BILLING: { getTenantAccess: () => Promise<Access> } }).BILLING;
    const answer = billing.getTenantAccess;
    billing.getTenantAccess = async () => {
      if (down) throw new Error("billing is down");
      return answer();
    };
    // App traffic keeps a plan without support for the outage; support never reads it.
    expect(await getAppTrafficBillingAccess(kept.env, human.accountId, () => undefined)).toMatchObject({ plan: { planName: "Free" } });
    down = true;
    expect((await send(kept.env, human, MESSAGE)).status).toBe(200);
    expect(kept.tickets[0]!.account?.plan).toBe("unknown (billing unreachable)");
  });

  it("refuses a plan whose limits are malformed, as v1, rather than guessing either way", async () => {
    const human = await seedHuman();
    // Only the limits v1 recognized: a v2-only limit is not support's to judge.
    const v2Only = runtime({ access: { plan: { planKey: "pro", planName: "Pro", isDefault: false, limits: { maxSessionMinutesPerMonth: "lots" } }, subscription: null } });
    expect((await send(v2Only.env, human, MESSAGE)).status).toBe(200);
    // The legacy maxProviderGateways too, which v2 otherwise never reads.
    for (const limits of [null, { maxApps: "many" }, { includes: "humanSupport" }, { maxProviderGateways: -1 }, { maxProviderGateways: null }]) {
      const broken = runtime({ access: { plan: { planKey: "pro", planName: "Pro", isDefault: false, limits }, subscription: null } });
      const response = await send(broken.env, human, MESSAGE);
      expect(response.status).toBe(502);
      expect(await errorCode(response)).toBe("billing_unavailable");
      expect(broken.tickets).toHaveLength(0);
    }
  });

  it("refuses a console message started by someone else than the one signed in now, and sends one started by them", async () => {
    const human = await seedHuman();
    const other = await seedHuman();
    const { env: testEnv, tickets } = runtime();
    const changed = await send(testEnv, human, { ...MESSAGE, sender: other.userId });
    expect(changed.status).toBe(409);
    expect(await errorCode(changed)).toBe("sender_changed");
    expect(tickets).toHaveLength(0);
    expect((await send(testEnv, human, { ...MESSAGE, sender: human.userId })).status).toBe(200);
    expect(tickets).toHaveLength(1);
  });

  it("keeps settings writes strict: a plan kept through an outage never turns conversation storage on", async () => {
    const human = await seedHuman();
    let down = false;
    const kept = runtime({ access: plan("Pro", false, ["conversationStorage"]) });
    const billing = (kept.env as unknown as { BILLING: { getTenantAccess: () => Promise<Access> } }).BILLING;
    const answer = billing.getTenantAccess;
    billing.getTenantAccess = async () => {
      if (down) throw new Error("billing is down");
      return answer();
    };
    await expect(requirePlanFeature(kept.env, human.accountId, "conversationStorage")).resolves.toBeUndefined();
    // Past the cache, billing fails: only the plan kept through the outage is left, which a write never trusts.
    down = true;
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + BILLING_ACCESS_CACHE_TTL_MS + 1_000 });
    await expect(requirePlanFeature(kept.env, human.accountId, "conversationStorage")).rejects.toMatchObject({ status: 503, code: "billing_unavailable" });
  });

  it("holds one person to ten messages an hour, whichever of their accounts they write from", async () => {
    const human = await seedHuman();
    const other = `acc_support_${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO mgmt_organization(id, name, created_by_user_id, created_at, updated_at) VALUES (?, 'Other', ?, ?, ?)").bind(other, human.userId, now, now),
      env.DB.prepare("INSERT INTO mgmt_organization_user(id, organization_id, user_id, role, status, joined_at) VALUES (?, ?, ?, 'owner', 'active', ?)").bind(
        `mem_${other}`,
        other,
        human.userId,
        now,
      ),
    ]);
    const { env: testEnv, tickets } = runtime();
    for (let sent = 0; sent < 10; sent += 1) {
      const response = await send(testEnv, { cookie: human.cookie, account: sent % 2 === 0 ? human.accountId : other }, { ...MESSAGE, message: `Message ${sent}` });
      expect(response.status, String(sent)).toBe(200);
    }
    const eleventh = await send(testEnv, { cookie: human.cookie, account: other }, { ...MESSAGE, message: "One more" });
    expect(eleventh.status).toBe(429);
    expect(await errorCode(eleventh)).toBe("rate_limited");
    expect(tickets).toHaveLength(10);
    expect(new Set(tickets.map((ticket) => ticket.account?.tenantId))).toEqual(new Set([human.accountId, other]));
  });

  it("asks agw for its own confirmation step: an agw without it is told to update", async () => {
    const response = await call(runtime().env, new Request(`${API}/v2/cli/tools`));
    const { tools } = (await response.json()) as { tools: { name: string; cli: { command: string; requires?: string[] } }[] };
    expect(tools.find((tool) => tool.name === "contact_support")?.cli).toEqual({ command: "support send", requires: ["support-confirmation"] });
  });

  it("refuses an empty message, a page off the console and malformed context", async () => {
    const human = await seedHuman();
    const { env: testEnv, tickets } = runtime();
    expect((await send(testEnv, human, { ...MESSAGE, message: "   " })).status).toBe(400);
    expect((await send(testEnv, human, { ...MESSAGE, page: "//evil.test" })).status).toBe(400);
    expect((await send(testEnv, human, { ...MESSAGE, context: { "bad name": "x" } })).status).toBe(400);
    expect(tickets).toHaveLength(0);
  });

  it("reports humanSupport among the plan's features on the billing page", async () => {
    const human = await seedHuman();
    const status = async (access: Access | "unreachable") => {
      clearCaches();
      const response = await call(
        runtime({ access }).env,
        new Request(`${CONSOLE}/v2/admin/billing/status`, { headers: { cookie: human.cookie, "x-console-request": "1" } }),
      );
      return response;
    };
    expect(((await (await status(plan("Pro", false))).json()) as { features: Record<string, boolean> }).features).toMatchObject({ humanSupport: true });
    expect(((await (await status(plan("Free", true, []))).json()) as { features: Record<string, boolean> }).features).toMatchObject({ humanSupport: false });
  });
});
