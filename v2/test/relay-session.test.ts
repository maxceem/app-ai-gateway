/**
 * A valid ticket through the relay's real session object, in the Workers
 * test runtime (`vitest.config.ts` hosts the relay Worker with the vault's
 * `RelayKeys`, a stand-in for the gateway's contract, and a provider
 * stand-in): the object starts the session and hands the client its
 * reconnect secret. Its id comes from the ticket (`idFromName`), and nothing
 * in the object depends on reading its own name back.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { SESSION_PATH } from "../relay/src/constants.js";
import { issueTicket } from "../src/relay/tickets.ts";
import { sealForTest } from "./split-keys.ts";
import { ACCOUNT_ID } from "./helpers.ts";

const relay = () => (env as unknown as { RELAY_TEST: Fetcher }).RELAY_TEST;

describe("the relay's session object (Fable F3)", () => {
  it("starts a session for a valid ticket and sends the client its reconnect secret", async () => {
    const identity: [string, string, string, string, string, string] = [ACCOUNT_ID, "conn_session", "openai", "", "", ""];
    const blob = await sealForTest("providerKey", identity, "sk-session-object");
    const { ticket } = await issueTicket(env, {
      accountId: ACCOUNT_ID,
      appId: "app_session",
      endUserId: null,
      installId: null,
      appleAccountId: null,
      appKeyId: null,
      providerType: "openai",
      connectionId: "conn_session",
      operation: "openai.realtime",
      model: "gpt-realtime",
      mode: "relayed",
      slot: "conversational",
      sessionTotal: false,
      url: "https://api.openai.com/v1/realtime",
      capMs: 60_000,
      credentials: { providerKey: { blob, identity }, cloudflareToken: null },
      keyPlacement: { header: "authorization", format: "Bearer {key}" },
    });
    const response = await relay().fetch(`https://relay.test${SESSION_PATH}`, { headers: { upgrade: "websocket", authorization: `Bearer ${ticket}` } });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    const first = new Promise<string>((resolve, reject) => {
      socket.addEventListener("message", (event) => resolve(String(event.data)));
      socket.addEventListener("close", (event) => reject(new Error(`closed ${event.code} ${event.reason}`)));
    });
    socket.accept();
    const message = JSON.parse(await first) as { type: string; reconnect_secret: string };
    expect(message.type).toBe("agw.session.started");
    expect(message.reconnect_secret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    socket.close(1000, "done");
  });
});
