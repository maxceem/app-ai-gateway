/**
 * Offline checks of the smoke checks' mock provider (`smoke/mock/`): the
 * things the smoke checks lean on to judge the gateway, a test issuer's JWKS,
 * the mark of the provider key that came in, and the mark of a client
 * credential that reached the provider.
 */
import { describe, expect, it, vi } from "vitest";
import mock, { clientCredentialHeaders, clientCredentialPlaces, jwksFromPath, keyMarks } from "../smoke/mock/index.ts";
import { assertHolds, keyMark, readJson } from "../smoke/support.ts";

const PUBLIC_KEY = { kty: "EC", crv: "P-256", x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU", y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0", kid: "smoke-1", alg: "ES256" };

function encoded(value: unknown): string {
  return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

describe("the smoke mock", () => {
  it("answers the key a /jwks/ path names as a JWKS, public fields only, with no provider key", async () => {
    const response = await mock.fetch(new Request(`https://mock.test/jwks/${encoded({ ...PUBLIC_KEY, d: "secret-half" })}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ keys: [PUBLIC_KEY] });
    expect(jwksFromPath("/jwks/not-json")).toBeNull();
    expect(jwksFromPath(`/jwks/${encoded({ kid: "no-kty" })}`)).toBeNull();
  });

  it("marks the request headers that carried a client credential, or none", async () => {
    const clean = await mock.fetch(
      new Request("https://mock.test/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer sk-mock-smoke-key", "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "Hi" }] }),
      }),
    );
    expect(clean.status).toBe(200);
    expect(clean.headers.get("x-mock-client-credentials")).toBe("none");

    expect(
      clientCredentialHeaders(
        new Headers({
          authorization: "Bearer sk-mock-smoke-key",
          "x-app-key": "agw_app_0123456789",
          "x-forwarded-token": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.c2lnbmF0dXJl",
        }),
      ),
    ).toEqual(["x-app-key", "x-forwarded-token"]);
  });

  it("marks a client credential in the URL or the body too, on a failed answer as on a served one", async () => {
    const failed = await mock.fetch(
      new Request("https://mock.test/v1/chat/completions?token=agw_app_0123456789", {
        method: "POST",
        headers: { authorization: "Bearer sk-mock-smoke-key", "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o-mini", mock_status: 429, note: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.c2lnbmF0dXJl" }),
      }),
    );
    expect(failed.status).toBe(429);
    expect(failed.headers.get("x-mock-client-credentials")).toBe("url,body");
    // The body was read for the check and still reached the answer whole.
    expect(await failed.json()).toEqual({ error: { message: "Mock error", type: "mock_error", code: "mock_error" } });
    expect(clientCredentialPlaces(new Request("https://mock.test/v1/models"), null)).toEqual([]);
  });

  it("marks a client credential that was percent-encoded in the path or the query", () => {
    expect(clientCredentialPlaces(new Request("https://mock.test/v1/models?t=%61gw_app_0123456789"), null)).toEqual(["url"]);
    expect(clientCredentialPlaces(new Request("https://mock.test/v1/%61gw_app_0123456789/models"), null)).toEqual(["url"]);
    expect(clientCredentialPlaces(new Request("https://mock.test/v1/models?%61gw_app_0123456789=1"), null)).toEqual(["url"]);
    // A path part that does not decode is looked at as it came.
    expect(clientCredentialPlaces(new Request("https://mock.test/v1/%E0%A4%A/models"), null)).toEqual([]);
  });

  it("marks each provider key header with a fixed label for a fixture key, and `unexpected` for anything else", async () => {
    expect(keyMarks(new Headers({ authorization: "Bearer sk-mock-smoke-openai" }))).toBe("authorization:bearer fixture-openai");
    expect(keyMarks(new Headers({ authorization: "Token sk-mock-smoke-openai" }))).toBe("authorization:token fixture-openai");
    expect(keyMarks(new Headers({ "x-api-key": "sk-mock-smoke-anthropic" }))).toBe("x-api-key:fixture-anthropic");
    // A fixture key with a scheme where none belongs, an unknown key, or one only the prototype knows.
    expect(keyMarks(new Headers({ "x-goog-api-key": "Bearer sk-mock-smoke-gemini" }))).toBe("x-goog-api-key:unexpected");
    expect(keyMarks(new Headers({ authorization: "Bearer sk-live-0123456789" }))).toBe("authorization:unexpected");
    expect(keyMarks(new Headers({ authorization: "sk-mock-smoke-key" }))).toBe("authorization:unexpected");
    expect(keyMarks(new Headers({ "x-api-key": "constructor" }))).toBe("x-api-key:unexpected");
    expect(keyMarks(new Headers({ authorization: "Bearer a", "x-api-key": "b" }))).toBe("authorization:unexpected,x-api-key:unexpected");
    expect(keyMarks(new Headers())).toBe("missing");
    // What a smoke check compares with.
    expect(keyMark("authorization", "fixture-openai")).toBe("authorization:bearer fixture-openai");
    expect(keyMark("x-api-key", "fixture-anthropic")).toBe("x-api-key:fixture-anthropic");

    const answered = await mock.fetch(
      new Request("https://mock.test/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "sk-mock-smoke-anthropic", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 16, messages: [{ role: "user", content: "Hi" }] }),
      }),
    );
    expect(answered.status).toBe(200);
    expect(answered.headers.get("x-mock-key")).toBe("x-api-key:fixture-anthropic");
    expect(JSON.stringify([...answered.headers])).not.toContain("sk-mock-smoke-anthropic");
  });

  it("says flex reached it, and echoes no other service mode", async () => {
    const tier = async (value: unknown) =>
      (
        await mock.fetch(
          new Request("https://mock.test/v1/chat/completions", {
            method: "POST",
            headers: { authorization: "Bearer sk-mock-smoke-key", "content-type": "application/json" },
            body: JSON.stringify({ model: "gpt-4o-mini", service_tier: value, messages: [{ role: "user", content: "Hi" }] }),
          }),
        )
      ).headers.get("x-mock-service-tier");
    expect(await tier("flex")).toBe("flex");
    expect(await tier("priority")).toBeNull();
    expect(await tier("sk-live-0123456789")).toBeNull();
    expect(await tier("flex\nx-evil: 1")).toBeNull();
  });

  it("reports cached tokens inside the prompt for a flex request only", async () => {
    const usage = async (tier?: string) =>
      (
        (await (
          await mock.fetch(
            new Request("https://mock.test/v1/chat/completions", {
              method: "POST",
              headers: { authorization: "Bearer sk-mock-smoke-key", "content-type": "application/json" },
              body: JSON.stringify({ model: "gpt-4o-mini", ...(tier ? { service_tier: tier } : {}), messages: [{ role: "user", content: "Hi there" }] }),
            }),
          )
        ).json()) as { usage: { prompt_tokens: number; prompt_tokens_details?: { cached_tokens: number } } }
      ).usage;
    const flex = await usage("flex");
    expect(flex.prompt_tokens_details?.cached_tokens).toBeGreaterThan(0);
    expect(flex.prompt_tokens_details!.cached_tokens).toBeLessThan(flex.prompt_tokens);
    expect((await usage()).prompt_tokens_details).toBeUndefined();
  });
});

describe("the smoke mock's slow stream", () => {
  it("logs that the stream was cut off, with its tag and the chunks sent, when the reader hangs up", async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const response = await mock.fetch(
        new Request("https://mock.test/v1/chat/completions", {
          method: "POST",
          headers: { authorization: "Bearer sk-mock-smoke-key", "content-type": "application/json" },
          body: JSON.stringify({ model: "gpt-4o-mini", stream: true, mock_slow_stream: true, mock_tag: "abort-1", messages: [] }),
        }),
      );
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain('"content":"."');
      await reader.cancel();
      const lines = log.mock.calls.map(([line]) => JSON.parse(String(line)) as { event: string; tag: string; chunks: number });
      expect(lines.find((line) => line.event === "mock_stream_cancelled")).toMatchObject({ tag: "abort-1" });
      expect(lines.some((line) => line.event === "mock_stream_finished")).toBe(false);
    } finally {
      log.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("the smoke checks' config comparison", () => {
  it("holds an array of objects whatever their fields' order, and still sees a change", () => {
    const saved = { required_claims: [{ path: "plan", equals: "pro" }, { path: "roles", contains: ["pro"] }] };
    const reordered = { required_claims: [{ equals: "pro", path: "plan" }, { contains: ["pro"], path: "roles" }] };
    expect(() => assertHolds(reordered, saved, "the config is not what was saved")).not.toThrow();
    expect(() => assertHolds(saved, reordered, "the config is not what was saved")).not.toThrow();
    // The items' order still counts, and so does a value.
    expect(() => assertHolds({ required_claims: [...saved.required_claims].reverse() }, saved, "the config is not what was saved")).toThrow();
    expect(() => assertHolds({ required_claims: [{ path: "plan", equals: "free" }, saved.required_claims[1]] }, saved, "the config is not what was saved")).toThrow();
    expect(() => assertHolds({ required_claims: [{ path: "plan", equals: "pro", extra: 1 }, saved.required_claims[1]] }, saved, "the config is not what was saved")).toThrow();
  });

  it("reads a body that is not JSON as its status alone, never its text", async () => {
    const leaky = new Response("not json sk-live-0123456789abcdef", { status: 502 });
    await expect(readJson(leaky)).rejects.toThrow("answered 502 with a body that is not JSON");
    await expect(readJson(new Response("not json sk-live-0123456789abcdef", { status: 502 }))).rejects.not.toThrow(/sk-live/);
  });
});

describe("the mock's live session stand-in (step 9a, frame forwarding and T12)", () => {
  it("answers a WebSocket upgrade, sends session.created at once, echoes frames, and sends one large frame with its type last", async () => {
    const response = await mock.fetch(new Request("https://mock.test/v1/realtime?model=gpt-realtime", { headers: { upgrade: "websocket" } }));
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    const got: string[] = [];
    let waiting: { count: number; resolve: () => void } | null = null;
    // Waits on the messages themselves, not on a timer.
    const arrived = (count: number) =>
      got.length >= count ? Promise.resolve() : new Promise<void>((resolve) => (waiting = { count, resolve }));
    socket.addEventListener("message", (event) => {
      got.push(String(event.data));
      if (waiting !== null && got.length >= waiting.count) waiting.resolve();
    });
    socket.accept();
    socket.send("hello");
    socket.send(JSON.stringify({ type: "mock.big" }));
    await arrived(3);
    expect(JSON.parse(got[0]!)).toEqual({ type: "session.created" });
    expect(got[1]).toBe("hello");
    expect(got[2]!.length).toBeGreaterThan(512 * 1024);
    expect(got[2]!.endsWith('"type":"audio"}')).toBe(true);
    socket.close(1000, "done");
  });

  it("answers mock.answer like an OpenAI answer: response.created, audio, the usage event, then response.done (step 9a part 3)", async () => {
    const response = await mock.fetch(new Request("https://mock.test/v1/realtime?model=gpt-realtime", { headers: { upgrade: "websocket" } }));
    const socket = response.webSocket!;
    const got: string[] = [];
    let waiting: { count: number; resolve: () => void } | null = null;
    const arrived = (count: number) =>
      got.length >= count ? Promise.resolve() : new Promise<void>((resolve) => (waiting = { count, resolve }));
    socket.addEventListener("message", (event) => {
      got.push(String(event.data));
      if (waiting !== null && got.length >= waiting.count) waiting.resolve();
    });
    socket.accept();
    socket.send(JSON.stringify({ type: "mock.answer", event_id: "a1", usage: { input_tokens: 5, output_tokens: 9 }, seconds: 0.1 }));
    // session.created, response.created, two audio frames, the usage event, response.done.
    await arrived(6);
    expect(got.map((frame) => (JSON.parse(frame) as { type: string }).type)).toEqual([
      "session.created",
      "response.created",
      "response.output_audio.delta",
      "response.output_audio.delta",
      "mock.usage",
      "response.done",
    ]);
    expect(JSON.parse(got[4]!)).toEqual({ type: "mock.usage", event_id: "a1", usage: { input_tokens: 5, output_tokens: 9 } });
    socket.close(1000, "done");
  });
});

describe("the mock's streaming voice stand-ins (step 10a)", () => {
  /** The mock's WebSocket at `url`, accepted, with a way to wait for its messages. */
  async function open(url: string) {
    const response = await mock.fetch(new Request(url, { headers: { upgrade: "websocket", authorization: "Token mock-key" } }));
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    const got: string[] = [];
    let waiting: { count: number; resolve: () => void } | null = null;
    socket.addEventListener("message", (event) => {
      got.push(String(event.data));
      if (waiting !== null && got.length >= waiting.count) waiting.resolve();
    });
    socket.accept();
    const arrived = (count: number) => (got.length >= count ? Promise.resolve() : new Promise<void>((resolve) => (waiting = { count, resolve })));
    return { response, socket, got, arrived };
  }

  it("answers Deepgram's stream with a request id, a Results frame for each audio frame, and Metadata at CloseStream", async () => {
    const { response, socket, got, arrived } = await open("https://mock.test/v1/listen?model=nova-3");
    const requestId = response.headers.get("dg-request-id")!;
    expect(requestId).toMatch(/^mock_/u);
    socket.send(new Uint8Array(32_000).buffer);
    socket.send(new Uint8Array(16_000).buffer);
    socket.send(JSON.stringify({ type: "KeepAlive" }));
    socket.send(JSON.stringify({ type: "CloseStream" }));
    await arrived(3);
    expect(got.map((frame) => JSON.parse(frame) as Record<string, unknown>)).toEqual([
      expect.objectContaining({ type: "Results", start: 0, duration: 1, channel_index: [0, 1] }),
      expect.objectContaining({ type: "Results", start: 1, duration: 0.5 }),
      expect.objectContaining({ type: "Metadata", request_id: requestId, duration: 1.5, channels: 1 }),
    ]);
  });

  it("answers ElevenLabs' stream with audio for each text, nothing for the opening space, and the final frame at the closing empty text", async () => {
    const { socket, got, arrived } = await open("https://mock.test/v1/text-to-speech/voice-1/stream-input?model_id=eleven_flash_v2_5");
    socket.send(JSON.stringify({ text: " " }));
    socket.send(JSON.stringify({ text: "Hello there " }));
    socket.send(JSON.stringify({ text: "" }));
    await arrived(2);
    expect(got.map((frame) => JSON.parse(frame) as Record<string, unknown>)).toEqual([
      { audio: "AAAA", isFinal: null, normalizedAlignment: null },
      { audio: null, isFinal: true },
    ]);
  });
});

describe("the mock's ElevenLabs agents (step 11a)", () => {
  const get = async (path: string) => (await mock.fetch(new Request(`https://mock.test${path}`, { headers: { "xi-api-key": "mock-key" } }))).json() as Promise<Record<string, any>>;

  it("answers an agent's settings, a signed URL back to itself with a new conversation, and a call that needs its signature", async () => {
    expect((await get("/v1/convai/agents/agent_smoke")).platform_settings).toMatchObject({ auth: { enable_auth: true }, overrides: { conversation_config_override: { conversation: { max_duration_seconds: false } } } });
    expect((await get("/v1/convai/agents/agent_mock_auth_off")).platform_settings.auth.enable_auth).toBe(false);
    const { signed_url: signed } = (await get("/v1/convai/conversation/get-signed-url?agent_id=agent_smoke&include_conversation_id=true")) as { signed_url: string };
    const url = new URL(signed);
    expect(url.origin.replace("wss:", "https:")).toBe("https://mock.test");
    expect(url.searchParams.get("conversation_id")).toMatch(/^conv_mock_[0-9a-f]{32}$/u);
    const unsigned = await mock.fetch(new Request("https://mock.test/v1/convai/conversation?agent_id=agent_smoke", { headers: { upgrade: "websocket" } }));
    expect(unsigned.status).toBe(401);
    const call = await mock.fetch(new Request(url.toString().replace("wss:", "https:"), { headers: { upgrade: "websocket" } }));
    expect(call.status).toBe(101);
    const socket = call.webSocket!;
    const got: string[] = [];
    let done: () => void = () => undefined;
    socket.addEventListener("message", (event) => {
      got.push(String(event.data));
      if (got.length === 2) done();
    });
    socket.accept();
    socket.send(JSON.stringify({ user_audio_chunk: "AAAA" }));
    await new Promise<void>((resolve) => (got.length >= 2 ? resolve() : (done = resolve)));
    expect(JSON.parse(got[0]!)).toMatchObject({ type: "conversation_initiation_metadata", conversation_initiation_metadata_event: { conversation_id: url.searchParams.get("conversation_id") } });
    expect(JSON.parse(got[1]!)).toMatchObject({ type: "audio" });
    expect(await get(`/v1/convai/conversations/${url.searchParams.get("conversation_id")}`)).toMatchObject({ status: "done", metadata: { cost_fiat: 0.012 } });
  });
});

describe("the mock's unknown live provider (step 10b)", () => {
  it("says which key header it got, as a label, and its query, then echoes every frame as it was sent", async () => {
    const response = await mock.fetch(new Request("https://mock.test/v1/live-echo?voice=alloy", { headers: { upgrade: "websocket", "x-api-key": "sk-mock-smoke-key" } }));
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.binaryType = "arraybuffer";
    const got: (string | number[])[] = [];
    let waiting: (() => void) | null = null;
    socket.addEventListener("message", (event) => {
      got.push(typeof event.data === "string" ? event.data : [...new Uint8Array(event.data as ArrayBuffer)]);
      if (got.length >= 3) waiting?.();
    });
    socket.accept();
    socket.send('{"type":"anything"}');
    socket.send(new Uint8Array([7, 8]).buffer);
    if (got.length < 3) await new Promise<void>((resolve) => (waiting = resolve));
    expect(got).toEqual([JSON.stringify({ type: "mock.hello", key: "x-api-key:fixture-smoke", query: "?voice=alloy" }), '{"type":"anything"}', [7, 8]]);
    socket.close(1000, "done");
  });
});
