/**
 * The relay Worker's entry (plan step 9a; crash table row 1): a ticket's
 * signature is checked with the main Worker's public key before any session
 * object is created, and the ticket names its object.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { HEALTH_PATH, SESSION_PATH } from "../relay/src/constants.js";
import relay from "../relay/src/index.js";
import { issueTicket } from "../src/relay/tickets.ts";
import { sealForTest } from "./split-keys.ts";
import { TEST_TICKET_PUBLIC_KEY } from "./relay-keys.ts";
import { ACCOUNT_ID } from "./helpers.ts";

/** A session namespace that records whether anything reached it, and which object. */
function sessions() {
  const used: string[] = [];
  const namespace = {
    idFromName: (name: string) => {
      used.push(`idFromName:${name}`);
      return name;
    },
    get: () => {
      used.push("get");
      return { fetch: async () => new Response("from the session", { status: 200 }) };
    },
  };
  return { used, namespace: namespace as unknown as DurableObjectNamespace };
}

const relayEnv = (namespace: DurableObjectNamespace, key: string | null = TEST_TICKET_PUBLIC_KEY) =>
  ({ SESSION: namespace, MAIN: {}, VAULT: {}, ...(key === null ? {} : { RELAY_TICKET_PUBLIC_KEY: key }) }) as unknown as Parameters<typeof relay.fetch>[1];

const connect = (ticket: string | null, upgrade = true) =>
  new Request(`https://relay.example${SESSION_PATH}`, {
    headers: { ...(upgrade ? { upgrade: "websocket" } : {}), ...(ticket === null ? {} : { authorization: `Bearer ${ticket}` }) },
  });

async function signed(mode: "relayed" | "observed" = "relayed"): Promise<{ ticket: string; sessionId: string }> {
  const identity: [string, string, string, string, string, string] = [ACCOUNT_ID, "conn_entry", "openai", "", "", ""];
  const blob = await sealForTest("providerKey", identity, "sk-entry");
  return await issueTicket(env, {
    accountId: ACCOUNT_ID,
    appId: "app_entry",
    endUserId: null,
    installId: null,
    appleAccountId: null,
    appKeyId: null,
    providerType: "openai",
    connectionId: "conn_entry",
    operation: "openai.realtime",
    model: "gpt-realtime",
    mode,
    slot: "conversational",
    sessionTotal: false,
    url: "https://api.openai.com/v1/realtime",
    capMs: 60_000,
    credentials: { providerKey: { blob, identity }, cloudflareToken: null },
    keyPlacement: { header: "authorization", format: "Bearer {key}" },
  });
}

describe("the relay's entry", () => {
  it("answers its health check, and a 404 for any other path", async () => {
    const response = await relay.fetch(new Request(`https://relay.example${HEALTH_PATH}`), relayEnv(sessions().namespace));
    expect(await response.json()).toEqual({ ok: true, service: "app-ai-gateway-relay" });
    expect((await relay.fetch(new Request("https://relay.example/v2/relay/echo"), relayEnv(sessions().namespace))).status).toBe(404);
  });

  it("row 1: a missing, made-up, cut or forged ticket creates no session object", async () => {
    const { ticket } = await signed();
    const [payload, signature = ""] = ticket.split(".");
    const flipped = `${payload}.${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
    for (const bad of [null, "not-a-ticket", ticket.slice(0, 60), flipped]) {
      const { used, namespace } = sessions();
      const response = await relay.fetch(connect(bad), relayEnv(namespace));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: { code: "ticket_refused" } });
      expect(used).toEqual([]);
    }
  });

  it("asks for a WebSocket, and never takes the ticket from the URL", async () => {
    const { ticket } = await signed();
    const plain = sessions();
    expect((await relay.fetch(connect(ticket, false), relayEnv(plain.namespace))).status).toBe(426);
    const inUrl = sessions();
    const response = await relay.fetch(new Request(`https://relay.example${SESSION_PATH}?ticket=${ticket}`, { headers: { upgrade: "websocket" } }), relayEnv(inUrl.namespace));
    expect(response.status).toBe(401);
    expect(plain.used).toEqual([]);
    expect(inUrl.used).toEqual([]);
  });

  it("hands a signed ticket to the session object it names", async () => {
    const { ticket, sessionId } = await signed();
    const { used, namespace } = sessions();
    const response = await relay.fetch(connect(ticket), relayEnv(namespace));
    expect(await response.text()).toBe("from the session");
    expect(used).toEqual([`idFromName:${sessionId}`, "get"]);
  });

  it("refuses an observed session until observed mode is built (part 3), and a relay without its key", async () => {
    const observed = sessions();
    expect((await relay.fetch(connect((await signed("observed")).ticket), relayEnv(observed.namespace))).status).toBe(501);
    expect(observed.used).toEqual([]);
    const unset = sessions();
    expect((await relay.fetch(connect((await signed()).ticket), relayEnv(unset.namespace, null))).status).toBe(503);
    expect(unset.used).toEqual([]);
  });
});
