import { customDescription } from "../src/providers/custom.ts";
import { describe, expect, it } from "vitest";
import { BUILT_IN_PROVIDERS } from "../src/providers/index.ts";
import { compilePassthrough, ProviderDescriptionError, ProviderMatcher } from "../src/providers/matcher.ts";
import { defineOperation, defineProvider } from "../src/providers/operation.ts";
import { elevenlabs } from "../src/providers/elevenlabs.ts";
import { fal } from "../src/providers/fal.ts";
import { openai } from "../src/providers/openai.ts";

describe("built-in provider descriptions", () => {
  it.each(Object.keys(BUILT_IN_PROVIDERS))("%s compiles", (type) => {
    expect(() => new ProviderMatcher(BUILT_IN_PROVIDERS[type]!)).not.toThrow();
  });

  it("use each operation name once across all providers", () => {
    const names = Object.values(BUILT_IN_PROVIDERS).flatMap((provider) => provider.operations.map((op) => op.name));
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("ElevenLabs text-to-speech", () => {
  const matcher = new ProviderMatcher(elevenlabs);

  it("matches the voice in the path, the stream first", () => {
    const stream = matcher.match("POST", "v1/text-to-speech/voice123/stream");
    expect(stream).toMatchObject({
      kind: "operation",
      operation: { name: "elevenlabs.tts_stream" },
      parts: { voice_id: "voice123" },
      upstream: { host: "main", path: "/v1/text-to-speech/voice123/stream" },
    });
    expect(matcher.match("POST", "v1/text-to-speech/voice123")).toMatchObject({
      operation: { name: "elevenlabs.tts" },
    });
  });

  it("refuses a voice id that would span a slash, and other methods", () => {
    expect(matcher.match("POST", "v1/text-to-speech/a%2Fb")).toMatchObject({ reason: "bad_path" });
    expect(matcher.match("GET", "v1/text-to-speech/voice123")).toEqual({ kind: "refused", reason: "not_declared" });
  });
});

describe("fal", () => {
  const matcher = new ProviderMatcher(fal);

  it("runs a priced model with slashes in its id, on the main host", () => {
    expect(matcher.match("POST", "run/fal-ai/flux/dev")).toMatchObject({
      kind: "operation",
      operation: { name: "fal.run" },
      parts: { model: "fal-ai/flux/dev" },
      upstream: { host: "main", path: "/fal-ai/flux/dev" },
    });
  });

  it("submits a job to the queue host", () => {
    expect(matcher.match("POST", "queue/fal-ai/kling-video/v2.1/master/text-to-video")).toMatchObject({
      operation: { name: "fal.queue", lifecycle: "job" },
      upstream: { host: "queue", path: "/fal-ai/kling-video/v2.1/master/text-to-video" },
    });
  });

  it("routes any model in the priced-models part: whether it is priced is judged where the call is admitted (`resolveCall`)", () => {
    expect(matcher.match("POST", "run/fal-ai/flux/pro")).toMatchObject({ kind: "operation", operation: { name: "fal.run" }, parts: { model: "fal-ai/flux/pro" } });
    expect(matcher.match("POST", "run")).toEqual({ kind: "refused", reason: "not_declared" });
  });
});

describe("OpenAI", () => {
  const matcher = new ProviderMatcher(openai);

  it("matches a relayed realtime session", () => {
    expect(matcher.match("GET", "v1/realtime")).toMatchObject({
      operation: { name: "openai.realtime", lifecycle: "session", session: { mode: "relayed" } },
    });
  });

  it("refuses the admin API, whatever the case, before anything else", () => {
    const listed = compilePassthrough([{ method: "GET", path: "v1/organization/{thing}" }]);
    for (const path of ["v1/organization", "v1/organization/admin_api_keys", "V1/ORGANIZATION/projects"]) {
      expect(matcher.match("GET", path, { passthrough: listed })).toEqual({
        kind: "refused",
        reason: "refused_path",
        pattern: expect.stringMatching(/^v1\/organization/),
      });
    }
  });
});

describe("passthrough paths", () => {
  const matcher = new ProviderMatcher(openai);
  const passthrough = compilePassthrough([
    { method: "GET", path: "v1/files/{file_id}" },
    { method: "POST", path: "v1/moderations", priceNano: 1_000_000 },
  ]);

  it("passes a listed path through, as it was checked", () => {
    expect(matcher.match("GET", "v1//files/file-abc", { passthrough })).toEqual({
      kind: "passthrough",
      listed: { method: "GET", path: "v1/files/{file_id}" },
      parts: { file_id: "file-abc" },
      upstream: { host: "main", path: "/v1/files/file-abc" },
    });
  });

  it("never lets a part span a slash", () => {
    expect(matcher.match("GET", "v1/files/file-abc/content", { passthrough })).toEqual({
      kind: "refused",
      reason: "not_declared",
    });
  });

  it.each(["v1/files/../organization/x", "v1/files/%2e%2e", "v1/files/a%2Fb"])(
    "refuses %s before matching",
    (path) => {
      expect(matcher.match("GET", path, { passthrough })).toMatchObject({ kind: "refused", reason: "bad_path" });
    },
  );

  it("needs the method listed too", () => {
    expect(matcher.match("DELETE", "v1/files/file-abc", { passthrough })).toEqual({
      kind: "refused",
      reason: "not_declared",
    });
  });

  it("keeps a listed path as passthrough when an operation is declared for it later", () => {
    const listed = compilePassthrough([{ method: "POST", path: "v1/chat/completions" }]);
    expect(matcher.match("POST", "v1/chat/completions", { passthrough: listed })).toMatchObject({
      kind: "passthrough",
      listed: { path: "v1/chat/completions" },
    });
    expect(matcher.match("POST", "v1/chat/completions")).toMatchObject({ kind: "operation" });
  });

  it("refuses a listing with a multi-segment part, a wildcard or a bad price when saved", () => {
    expect(() => compilePassthrough([{ method: "GET", path: "v1/{rest...}" }])).toThrow();
    expect(() => compilePassthrough([{ method: "GET", path: "v1/*" }])).toThrow();
    expect(() => compilePassthrough([{ method: "GET", path: "v1/x", priceNano: 0.5 }])).toThrow();
    expect(() => compilePassthrough([{ method: "GET", path: "v1/x", priceNano: -1 }])).toThrow();
  });

  it("gives a custom provider on a built-in host that provider's refused paths", () => {
    const custom = customDescription({ baseUrl: "https://api.openai.com/", auth: { header: "authorization", format: "Bearer {key}" }, paths: [] });
    const customMatcher = new ProviderMatcher(custom);
    const listed = compilePassthrough([{ method: "GET", path: "v1/organization/{thing}" }]);
    expect(customMatcher.match("GET", "v1/organization/users", { passthrough: listed })).toMatchObject({
      reason: "refused_path",
    });
  });
});

describe("upstream templates", () => {
  const provider = defineProvider({
    type: "test",
    label: "Test",
    serviceModes: [],
    hosts: { main: "example.com" },
    auth: { header: "x", format: "{key}" },
    refused: [],
    operations: [
      defineOperation({
        name: "t.prefixed",
        match: { method: "GET", path: "v1/x{id}" },
        upstream: { path: "v1/{id}/data" },
        lifecycle: "call",
        transport: "http",
        model: { in: "fixed", model: "m" },
        meter: { kind: "request_count" },
      }),
    ],
  });
  const matcher = new ProviderMatcher(provider);

  it("never send a part that became a dot segment once its prefix was removed", () => {
    expect(matcher.match("GET", "v1/x42")).toMatchObject({ upstream: { path: "/v1/42/data" } });
    expect(matcher.match("GET", "v1/x..")).toEqual({ kind: "refused", reason: "bad_path", detail: "dot_segment" });
    expect(matcher.match("GET", "v1/x.")).toEqual({ kind: "refused", reason: "bad_path", detail: "dot_segment" });
  });

  it("still refuse such a value by a refused pattern, before a listed path can match it", () => {
    const refusing = new ProviderMatcher({ ...provider, refused: ["v1/x{id}"] });
    const passthrough = compilePassthrough([{ method: "GET", path: "v1/{segment}" }]);
    expect(refusing.match("GET", "v1/x..", { passthrough })).toMatchObject({ reason: "refused_path" });
  });
});

describe("broken descriptions are caught when compiled", () => {
  const provider = (operation: ReturnType<typeof defineOperation>, hosts = { main: "example.com" }) =>
    defineProvider({ type: "test", label: "Test", serviceModes: [], hosts, auth: { header: "x", format: "{key}" }, refused: [], operations: [operation] });
  const base = { lifecycle: "call", transport: "http", meter: { kind: "request_count" } } as const;

  it("an unknown upstream host", () => {
    const op = defineOperation({
      ...base,
      name: "t.host",
      match: { method: "GET", path: "v1/x" },
      upstream: { host: "queue" },
      model: { in: "fixed", model: "m" },
    });
    expect(() => new ProviderMatcher(provider(op))).toThrow(ProviderDescriptionError);
  });

  it("an operation declared twice", () => {
    const op = defineOperation({ ...base, name: "t.dup", match: { method: "GET", path: "v1/x" }, model: { in: "fixed", model: "m" } });
    const twice = defineProvider({ type: "test", label: "Test", serviceModes: [], hosts: { main: "example.com" }, auth: { header: "x", format: "{key}" }, refused: [], operations: [op, op] });
    expect(() => new ProviderMatcher(twice)).toThrow(/declared twice/);
  });
});
