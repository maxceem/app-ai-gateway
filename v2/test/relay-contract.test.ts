/**
 * The relay contract across versions (plan 5.1): a relay keeps running while
 * the gateway is deployed under it, so the gateway answers every relay
 * version still deployed. The calls below are the shapes each relay version
 * sends, recorded as plain values and replayed over the real entrypoint
 * (`RelayContract`), as the relay's service binding calls it.
 *
 * - Version 1 (step 9a part 1): `open`, then `close` with `finalSlice: 0` and
 *   no `relayVersion`. It never sends a checkpoint.
 * - Version 2 (step 9a part 2): `open`, `checkpoint` on the tick, and `close`
 *   with the final slice number and `relayVersion: 2`.
 *
 * Never change a recorded shape: add a new version's shapes beside them.
 */
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { issueTicket, type TicketRequest } from "../src/relay/tickets.ts";
import { parseTicket } from "../relay/src/ticket.js";
import { ACCOUNT_ID, ledger } from "./helpers.ts";
import { sealForTest, testShare } from "./split-keys.ts";

interface Contract {
  open(ticket: string): Promise<Record<string, unknown>>;
  checkpoint(ticket: string, input: unknown): Promise<Record<string, unknown>>;
  close(ticket: string, input: unknown): Promise<Record<string, unknown>>;
}
const contract = (exports as unknown as { RelayContract: Contract }).RelayContract;

async function ticket(): Promise<{ text: string; sid: string; start: number }> {
  const identity: [string, string, string, string, string, string] = [ACCOUNT_ID, "conn_live", "openai", "", "", ""];
  const share = await testShare(ACCOUNT_ID);
  const request: TicketRequest = {
    accountId: ACCOUNT_ID,
    appId: "app_contract",
    endUserId: null,
    installId: null,
    appleAccountId: null,
    appKeyId: null,
    providerType: "openai",
    connectionId: null,
    operation: "openai.realtime",
    model: "gpt-4o-mini",
    mode: "relayed",
    slot: "streaming",
    sessionTotal: false,
    url: "https://api.openai.com/v1/realtime",
    capMs: 30 * 60_000,
    credentials: {
      providerKey: { blob: await sealForTest("providerKey", identity, "sk-contract-key"), identity },
      cloudflareToken: null,
      ...(share === null ? {} : { credential: share.forVault() }),
    },
    keyPlacement: { header: "authorization", format: "Bearer {key}" },
  };
  const issued = await issueTicket(env, request, Date.now());
  const payload = parseTicket(issued.ticket)!.payload;
  return { text: issued.ticket, sid: payload.sid, start: payload.start };
}

const session = (sid: string) => ledger().prepare("SELECT state, final_slice, end_reason FROM session WHERE id = ?").bind(sid).first();

describe("relay contract versions", () => {
  it("answers a version 1 relay: open, then close with no slices", async () => {
    const t = await ticket();
    const opened = await contract.open(t.text);
    // Fields a version 1 relay reads are all still there.
    expect(opened).toMatchObject({ sessionId: t.sid, operation: "openai.realtime", mode: "relayed", slot: "streaming", checkpointIntervalMs: 60_000 });
    expect(typeof opened.deadline).toBe("number");
    expect(await contract.close(t.text, { finalSlice: 0, endReason: "client_closed", endedAt: t.start + 5_000, providerCallId: null })).toMatchObject({
      version: expect.any(Number),
    });
    expect(await session(t.sid)).toMatchObject({ state: "ended", final_slice: 0, end_reason: "client_closed" });
  });

  it("answers a version 2 relay: open, checkpoints, then close with the final slice", async () => {
    const t = await ticket();
    expect(await contract.open(t.text)).toMatchObject({ version: 2, adapter: "mock" });
    expect(await contract.checkpoint(t.text, { slice: null, connected: false, accounting: false, providerCallId: "call_1", relayVersion: 2 })).toEqual({
      version: 2,
      decision: "continue",
      reasons: [],
      written: true,
    });
    const slice = { seq: 1, measures: { input_tokens: 40, output_tokens: 8 }, sessionMs: 60_000, gapMs: 0, gaps: 0, from: t.start, to: t.start + 60_000 };
    expect(await contract.checkpoint(t.text, { slice, connected: true, accounting: false, providerCallId: "call_1", relayVersion: 2 })).toMatchObject({
      decision: "continue",
      written: true,
    });
    // After the end, the final slice comes as accounting only, then close names it.
    const last = { ...slice, seq: 2, measures: {}, sessionMs: 1_000, from: t.start + 60_000, to: t.start + 61_000 };
    expect(await contract.checkpoint(t.text, { slice: last, connected: true, accounting: true, providerCallId: "call_1", relayVersion: 2 })).toMatchObject({
      decision: "continue",
      written: true,
    });
    expect(await contract.close(t.text, { finalSlice: 2, endReason: "client_closed", endedAt: t.start + 61_000, providerCallId: "call_1", relayVersion: 2 })).toEqual({
      version: 2,
    });
    expect(await session(t.sid)).toMatchObject({ state: "ended", final_slice: 2, end_reason: "client_closed" });
  });
});
