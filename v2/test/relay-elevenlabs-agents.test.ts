/**
 * ElevenLabs agents through the relay (step 11a). The relay connects through the single-use signed URL
 * `open` asked for, only when it is on the address the session's key is sealed for, and sends no key there;
 * the conversation it names is the session's provider call id, for the lookup after the call. The client's
 * frames are locked: only the first message's greeting may be overridden. The call is billed by the relay's
 * clock from the start, an estimate. A client that drops ends the session at once, since a reconnect is a new
 * conversation (plan 5.1). The session core runs against stand-ins, with the test's own clock.
 */
import { describe, expect, it } from "vitest";
import { adapterFor, agentLock } from "../relay/src/adapters.js";
import { Session } from "../relay/src/index.js";
import { SessionFrames } from "../relay/src/frames.js";
import { connectProvider, signedSession } from "../relay/src/provider.js";
import { SessionCore } from "../relay/src/start.js";
import { MemoryStore, never, ticketFor } from "./relay-stand-ins.ts";

const AGENT = "agent_7201m7pdev6jevj929vxq7afhp6c";
const CONVERSATION = "conv_0201m7pdgwcmen0bwje84b2yh3my";
const TARGET = `https://api.elevenlabs.io/v1/convai/conversation?agent_id=${AGENT}`;
const SIGNED = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${AGENT}&conversation_signature=sig_test&conversation_id=${CONVERSATION}`;
const adapter = adapterFor("elevenlabs_agent");

describe("an agent's client frames: only the first message's greeting may be overridden (step 11a)", () => {
  const audio = JSON.stringify({ user_audio_chunk: "AAAAAAAA+/==" });

  it("sends an audio chunk as it is, unparsed, and every other frame written again as it was read", () => {
    expect(agentLock(audio)).toBe(audio);
    const first = {
      type: "conversation_initiation_client_data",
      conversation_config_override: { agent: { first_message: "I am back." } },
      dynamic_variables: { name: "Ann" },
    };
    expect(JSON.parse(agentLock(JSON.stringify(first)) as string)).toEqual(first);
    // The SDK's other messages go on (T17a): pong, the earlier turns, a typed message.
    for (const frame of [{ type: "pong", event_id: 2 }, { type: "contextual_update", text: "Earlier: …" }, { type: "user_message", text: "Hi" }, { type: "conversation_initiation_client_data" }]) {
      expect(JSON.parse(agentLock(JSON.stringify(frame)) as string)).toEqual(frame);
    }
    // Who started the call, and the agent's own placeholders, go too.
    const named = { type: "conversation_initiation_client_data", dynamic_variables: { name: "Ann" }, user_id: "user-1", source_info: { source: "swift_sdk", version: "2.0.0" } };
    expect(JSON.parse(agentLock(JSON.stringify(named)) as string)).toEqual(named);
    // A repeated key goes as ElevenLabs reads it: once, the last.
    expect(agentLock('{"type":"pong","event_id":1,"event_id":2}')).toBe('{"type":"pong","event_id":2}');
  });

  it("refuses a duration override, any override but the greeting, and the custom LLM body, in any frame", () => {
    const init = (override: unknown) => JSON.stringify({ type: "conversation_initiation_client_data", conversation_config_override: override });
    expect(agentLock(init({ conversation: { max_duration_seconds: 7200 } }))).toEqual({ refused: "override_not_allowed" });
    expect(agentLock(init({ agent: { first_message: "Hi", prompt: { llm: "gpt-6" } } }))).toEqual({ refused: "override_not_allowed" });
    expect(agentLock(init({ agent: { language: "fr" } }))).toEqual({ refused: "override_not_allowed" });
    expect(agentLock(init({ tts: { voice_id: "other" } }))).toEqual({ refused: "override_not_allowed" });
    expect(agentLock(init({ agent: { first_message: 42 } }))).toEqual({ refused: "override_not_allowed" });
    expect(agentLock(init("all"))).toEqual({ refused: "override_not_allowed" });
    expect(agentLock(JSON.stringify({ type: "conversation_initiation_client_data", custom_llm_extra_body: { temperature: 2 } }))).toEqual({ refused: "override_not_allowed" });
    // The overrides outside conversation_config_override, another branch, and any field not on the list (Sol, #275 round 1).
    for (const field of [{ starting_workflow_node_id: "node_2" }, { procedure_ids: ["proc_1"] }, { start_procedure_ids: ["proc_1"] }, { branch_id: "agtbrch_2" }, { environment: "staging" }, { new_field: true }]) {
      expect(agentLock(JSON.stringify({ type: "conversation_initiation_client_data", ...field })), JSON.stringify(field)).toEqual({ refused: "override_not_allowed" });
    }
    // Nor hidden in another message.
    expect(agentLock(JSON.stringify({ type: "user_activity", starting_workflow_node_id: "node_2" }))).toEqual({ refused: "override_not_allowed" });
    expect(agentLock(JSON.stringify({ type: "contextual_update", text: "x", procedure_ids: ["p"] }))).toEqual({ refused: "override_not_allowed" });
    // An escaped name is read as ElevenLabs reads it.
    expect(agentLock('{"type":"conversation_initiation_client_data","conversation_config_overrid\\u0065":{"conversation":{"max_duration_seconds":7200}}}')).toEqual({
      refused: "override_not_allowed",
    });
    // An override hidden behind an audio chunk is read whole too.
    expect(agentLock(JSON.stringify({ user_audio_chunk: "AAAA", conversation_config_override: { conversation: { max_duration_seconds: 9 } } }))).toEqual({ refused: "override_not_allowed" });
    // Nothing goes unread: text that isn't a JSON object, or binary.
    expect(agentLock("not json")).toEqual({ refused: "invalid_frame" });
    expect(agentLock("[1]")).toEqual({ refused: "invalid_frame" });
    expect(agentLock(new Uint8Array([1, 2]).buffer)).toEqual({ refused: "binary_not_supported" });
  });

  it("the session object sends the locked frames and ends the session with 1008 on one the lock refuses, sending it nowhere", () => {
    const ended: unknown[] = [];
    const object = Object.create(Session.prototype) as Session;
    (object as unknown as { core: unknown }).core = { idle: false, ending: null, call: {}, sessionId: "ses_1", log: () => undefined };
    (object as unknown as { endFor: unknown }).endFor = (_live: unknown, reason: string, code: number, closeReason: string) => ended.push([reason, code, closeReason]);
    const sent: unknown[] = [];
    const live = { client: { send: () => undefined }, deadline: Infinity, call: { send: (data: unknown) => sent.push(data), meter: null }, adapter, frames: new SessionFrames({ relayMessages: false }), turnOpen: false, turns: 0, clientState: {} };
    object.toProvider(live as never, JSON.stringify({ type: "conversation_initiation_client_data", conversation_config_override: { agent: { first_message: "Back." } } }));
    object.toProvider(live as never, audio);
    expect(sent).toHaveLength(2);
    object.toProvider(live as never, JSON.stringify({ type: "conversation_initiation_client_data", conversation_config_override: { conversation: { max_duration_seconds: 7200 } } }));
    expect(sent).toHaveLength(2);
    expect(ended).toEqual([["error", 1008, "override_not_allowed"]]);
  });

  it("reads no frame of ElevenLabs' for usage, keeps no turn, and takes its ping for a keepalive only", () => {
    expect(adapter.detached).toBe("end");
    expect(adapter.clock).toBeUndefined();
    const metadata = JSON.stringify({ conversation_initiation_metadata_event: { conversation_id: CONVERSATION, agent_output_audio_format: "pcm_16000" }, type: "conversation_initiation_metadata" });
    expect(adapter.read(metadata)).toBeNull();
    expect(adapter.turn(metadata)).toBeNull();
    expect(adapter.keepalive?.(JSON.stringify({ ping_event: { event_id: 2, ping_ms: null }, type: "ping" }))).toBe(true);
    expect(adapter.keepalive?.(JSON.stringify({ audio_event: { audio_base_64: "AAAA", event_id: 3 }, type: "audio" }))).toBe(false);
  });
});

describe("connecting through the signed URL (step 11a)", () => {
  it("connects only on the sealed address, keeps its signature, and names the conversation", () => {
    expect(signedSession(TARGET, SIGNED)).toEqual({ target: SIGNED.replace(/^wss:/u, "https:"), callId: CONVERSATION });
    // Another host, another path, a user part, or no URL at all: never.
    expect(signedSession(TARGET, SIGNED.replace("api.elevenlabs.io", "evil.test"))).toBeNull();
    expect(signedSession(TARGET, SIGNED.replace("/v1/convai/conversation", "/v1/other"))).toBeNull();
    expect(signedSession(TARGET, SIGNED.replace("wss://", "wss://user:pw@"))).toBeNull();
    expect(signedSession(TARGET, "not a url")).toBeNull();
    // A conversation id that isn't a plain id is not kept: the lookup is then skipped.
    expect(signedSession(TARGET, SIGNED.replace(CONVERSATION, "a%20b"))?.callId).toBeNull();
    expect(signedSession(TARGET, SIGNED.replace(`&conversation_id=${CONVERSATION}`, ""))?.callId).toBeNull();
  });

  it("sends no key to the signed URL", async () => {
    const seen: Headers[] = [];
    const send = async (_url: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return { status: 101, webSocket: { accept: () => undefined, binaryType: "blob" }, headers: new Headers(), body: null } as unknown as Response;
    };
    await connectProvider({ target: signedSession(TARGET, SIGNED)!.target }, send as typeof fetch, () => never());
    expect([...seen[0]!.keys()]).toEqual(["upgrade"]);
  });
});

type Slice = { seq: number; measures: Record<string, number>; sessionMs: number; gapMs: number; gaps: number };

/** A session core on the agent adapter, with stand-ins and the test's clock. */
function setup(openFails: string | null = null) {
  let now = 1_000_000;
  const store = new MemoryStore();
  const checkpoints: { slice: Slice | null; providerCallId: string | null }[] = [];
  const closes: { endReason: string; finalSlice: number; providerCallId: string | null }[] = [];
  const connected: unknown[] = [];
  const parts = () => ({
    store,
    now: () => now,
    log: () => undefined,
    wait: () => never<void>(),
    vault: { sessionKey: async () => ({ key: { value: "k", header: "xi-api-key", format: "{key}" }, target: TARGET }) as never },
    main: {
      open: async () => {
        if (openFails !== null) throw new Error(openFails);
        return { deadline: now + 30 * 60_000, mode: "relayed", operation: "elevenlabs.agent", checkpointIntervalMs: 60_000, version: 2, adapter: "elevenlabs_agent", model: AGENT, signedUrl: SIGNED } as never;
      },
      checkpoint: async (_ticket: string, input: { slice: Slice | null; providerCallId: string | null }) => {
        checkpoints.push(structuredClone({ slice: input.slice, providerCallId: input.providerCallId }));
        return { decision: "continue", reasons: [], written: true } as never;
      },
      close: async (_ticket: string, input: { endReason: string; finalSlice: number; providerCallId: string | null }) => {
        closes.push({ endReason: input.endReason, finalSlice: input.finalSlice, providerCallId: input.providerCallId });
        return { version: 2 };
      },
    },
    // As the session object connects: through the signed URL, whose conversation is the call's id.
    provider: {
      connect: async (key: { target: string }, settings: { signedUrl?: string }) => {
        const signed = signedSession(key.target, settings.signedUrl!)!;
        connected.push(signed.target);
        return { callId: signed.callId, close: () => undefined };
      },
    },
  });
  const { text, ticket } = ticketFor(now, { providerType: "elevenlabs", operation: "elevenlabs.agent", model: AGENT, slot: "conversational" });
  return {
    store,
    closes,
    connected,
    slices: () => checkpoints.map((one) => one.slice).filter((slice): slice is Slice => slice !== null),
    checkpoints,
    text,
    ticket,
    client: { close: () => undefined },
    instance: () => new SessionCore(parts()),
    tick: (ms: number) => void (now += ms),
  };
}

describe("an agent call's estimate and its end (step 11a)", () => {
  it("bills the clock from the start, at the base rate's measure, and names the conversation on every checkpoint and the close", async () => {
    const s = setup();
    const core = s.instance();
    const started = await core.start(s.text, s.ticket, s.client);
    expect(started).toMatchObject({ ok: true, adapter: "elevenlabs_agent" });
    expect(s.connected).toEqual([SIGNED.replace(/^wss:/u, "https:")]);
    expect(s.store.data.get("callId")).toBe(CONVERSATION);
    s.tick(61_000);
    await core.alarm();
    expect(s.slices()).toEqual([expect.objectContaining({ seq: 1, measures: {}, sessionMs: 61_000, gapMs: 0 })]);
    expect(s.checkpoints.every((one) => one.providerCallId === CONVERSATION)).toBe(true);
    s.tick(9_000);
    await core.clientGone(s.client);
    expect(s.slices().at(-1)).toMatchObject({ seq: 2, sessionMs: 9_000 });
    expect(s.closes).toEqual([{ endReason: "client_closed", finalSlice: 2, providerCallId: CONVERSATION }]);
  });

  it("a restarted instance ends the call, the time since the last write a gap, and the conversation id kept for the lookup (crash table row 13)", async () => {
    const s = setup();
    await s.instance().start(s.text, s.ticket, s.client);
    s.tick(20_000);
    await s.instance().alarm();
    expect(s.closes).toEqual([{ endReason: "error", finalSlice: 1, providerCallId: CONVERSATION }]);
    expect(s.slices()).toEqual([expect.objectContaining({ seq: 1, gapMs: 20_000, gaps: 1 })]);
  });

  it("passes on open's provider_unavailable (ElevenLabs refused the signed URL), stores nothing and connects nowhere", async () => {
    const s = setup("provider_unavailable");
    expect(await s.instance().start(s.text, s.ticket, s.client)).toEqual({ ok: false, code: "provider_unavailable" });
    expect(s.connected).toEqual([]);
    expect(s.store.data.size).toBe(0);
  });

  it("ends the session at once when our SDK's link drops: a reconnect is a new conversation (plan 5.1)", () => {
    const gone: unknown[] = [];
    let detached = 0;
    const object = Object.create(Session.prototype) as Session;
    (object as unknown as { core: unknown }).core = { detach: () => (detached += 1, true), clientGone: async (owner: unknown) => void gone.push(owner) };
    const owner = { close: () => undefined };
    const live = { relayMessages: true, adapter, client: {}, frames: { detached: false } };
    (object as unknown as { live: unknown }).live = live;
    // A dropped link (1006), which a provider that keeps the conversation would hold for a reconnect.
    object.clientClosed(live as never, owner, 1006);
    expect(detached).toBe(0);
    expect(gone).toEqual([owner]);
    expect(live.client).not.toBeNull();
  });
});
