/**
 * First requests for an app (`getAppSnippet`): built from its routes, its
 * presets and the operation descriptions, with a model serving admits, in
 * the body the proxy reads, and as curl that never holds a credential. The
 * generated requests are sent through the proxy, as an app would send them.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import worker from "../src/index.ts";
import { shellWord } from "../src/admin/app-snippet.ts";
import { clearCaches, LOAD_MANAGEMENT_TIMEOUT_MS, loadManagement, seedManagementKey } from "./helpers.ts";

beforeAll(loadManagement, LOAD_MANAGEMENT_TIMEOUT_MS);

let fetchSpy: MockInstance<typeof fetch>;

beforeEach(() => {
  clearCaches();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => vi.restoreAllMocks());

const ORIGIN = "https://gateway.test";
const PROVIDER_KEY = "sk-live-secret-abcd";

type Example = Record<string, any>;

/** One request to the Worker, its answer read before the work it left behind is awaited (a streamed answer needs reading). */
async function call(request: Request): Promise<{ status: number; text: string }> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  const text = await response.text();
  await waitOnExecutionContext(ctx);
  return { status: response.status, text };
}

async function request(key: string, method: string, path: string, body?: unknown) {
  const { status, text } = await call(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status, body: JSON.parse(text) as Record<string, any> };
}

async function provider(key: string, fields: Record<string, unknown> = {}): Promise<string> {
  const created = await request(key, "POST", "/v2/admin/providers", {
    type: "openai",
    name: "OpenAI",
    slug: `openai-${crypto.randomUUID().slice(0, 6)}`,
    secret: PROVIDER_KEY,
    ...fields,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.provider.slug as string;
}

async function snippetFor(key: string, config: unknown) {
  const app = await request(key, "POST", "/v2/admin/apps", { name: "Snippet", config });
  expect(app.status, JSON.stringify(app.body)).toBe(201);
  const appId = app.body.app.id as string;
  const answer = await request(key, "GET", `/v2/admin/apps/${appId}/snippet`);
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return {
    appId,
    appKey: app.body.api_key?.key as string | undefined,
    ...(answer.body as { app_id: string; base_url: string; examples: Example[]; notes: string[] }),
  };
}

/** An example sent as an app sends it: its URL, headers, and body, form or raw file, with the app key. */
async function send(example: Example, appKey: string) {
  const headers = new Headers({ ...example.headers, authorization: `Bearer ${appKey}` });
  let body: BodyInit | undefined;
  if (example.body !== undefined) body = JSON.stringify(example.body);
  else if (example.file?.field !== undefined) {
    const form = new FormData();
    for (const [name, value] of Object.entries(example.form ?? {})) form.append(name, value as string);
    form.append(example.file.field, new Blob([new Uint8Array(256).fill(1)], { type: "audio/mpeg" }), example.file.name);
    // As bytes with the form's own content type, as a client sends it.
    const encoded = new Request("https://local.invalid", { method: "POST", body: form });
    headers.set("content-type", encoded.headers.get("content-type")!);
    body = new Uint8Array(await encoded.arrayBuffer());
  } else if (example.file !== undefined) body = new Blob([new Uint8Array(256).fill(1)]);
  return call(new Request(example.url, { method: example.method, headers, ...(body === undefined ? {} : { body }) }));
}

/** The form the provider was sent, by the proxy's last upstream call. */
async function sentForm(): Promise<FormData> {
  const [, init] = fetchSpy.mock.calls.at(-1)!;
  const headers = new Headers(init?.headers);
  return new Request("https://local.invalid", { method: "POST", body: init?.body as BodyInit, headers: { "content-type": headers.get("content-type")! } }).formData();
}

describe("first requests for an app", () => {
  it("gives one curl per API style a route serves, each with a model serving admits for that kind of request", async () => {
    const key = await seedManagementKey();
    const slug = await provider(key);
    const { appId, base_url, examples, notes } = await snippetFor(key, {
      authentication: { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } },
      routing: {
        providers: {
          [slug]: {
            operations: ["openai.chat", "openai.chat.bare", "openai.embeddings", "openai.transcription", "openai.speech", "openai.realtime"],
            models: ["gpt-4o-mini", "text-embedding-3-small", "whisper-1", "gpt-4o-mini-tts"],
          },
        },
      },
    });
    expect(base_url).toBe(ORIGIN);
    // openai.chat.bare speaks the style openai.chat already shows; openai.realtime is not served yet.
    expect(examples.map((example) => [example.operation, example.model])).toEqual([
      ["openai.chat", "gpt-4o-mini"],
      ["openai.embeddings", "text-embedding-3-small"],
      ["openai.transcription", "whisper-1"],
      ["openai.speech", "gpt-4o-mini-tts"],
    ]);
    const [chat, , transcription, speech] = examples;
    expect(chat).toMatchObject({
      provider: slug,
      style: "openai-chat",
      method: "POST",
      url: `${ORIGIN}/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`,
      headers: { "x-end-user-id": "user-123", "Content-Type": "application/json" },
      body: { model: "gpt-4o-mini", messages: [{ role: "user", content: "Hello!" }] },
    });
    expect(chat!.curl).toBe(
      [
        `printf 'header = "Authorization: Bearer %s"\\n' "$APP_AI_GATEWAY_KEY" | curl --config - '${ORIGIN}/v2/apps/${appId}/proxy/${slug}/v1/chat/completions'`,
        `-H 'x-end-user-id: user-123'`,
        `-H 'Content-Type: application/json'`,
        `-d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Hello!"}]}'`,
      ].join(" \\\n  "),
    );
    expect(chat!.text).toBe(chat!.curl);
    // A form, by the proxy's rule: the model as a text field, the file apart.
    expect(transcription).toMatchObject({ form: { model: "whisper-1" }, file: { field: "file", name: "audio.mp3" } });
    expect(transcription!.curl).toContain(`--form-string 'model=whisper-1' \\\n  -F 'file=@audio.mp3'`);
    expect(speech!.curl).toMatch(/--output 'speech\.mp3'$/u);
    expect(notes).toContainEqual(expect.stringContaining("Set APP_AI_GATEWAY_KEY to one of this app's keys"));
    expect(notes).toContainEqual(expect.stringContaining(`${slug}: openai.realtime has no example here`));
    expect(JSON.stringify(examples)).not.toContain(PROVIDER_KEY);
  });

  it("leaves out a request no model the route allows can be billed for, and says why", async () => {
    const key = await seedManagementKey();
    const slug = await provider(key);
    const { examples, notes } = await snippetFor(key, {
      authentication: { type: "api_key", end_user: { source: "none" } },
      routing: { providers: { [slug]: { operations: ["openai.chat", "openai.transcription"], models: ["gpt-4o-mini"] } } },
    });
    expect(examples.map((example) => example.operation)).toEqual(["openai.chat"]);
    expect(notes).toContainEqual(`${slug}: openai.transcription has no example: no model this route allows can be billed there.`);
  });

  it("sends its generated requests through the proxy, JSON and upload alike, and they are served", async () => {
    const key = await seedManagementKey();
    const slug = await provider(key);
    const { examples, appKey } = await snippetFor(key, {
      authentication: { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } },
      routing: { providers: { [slug]: { operations: ["openai.chat", "openai.transcription"], models: ["gpt-4o-mini", "whisper-1"] } } },
    });
    const [chat, transcription] = examples;

    fetchSpy.mockResolvedValueOnce(Response.json({ id: "c1", choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }));
    const chatResponse = await send(chat!, appKey!);
    expect(chatResponse.status, chatResponse.text).toBe(200);
    expect(JSON.parse(await new Response(fetchSpy.mock.calls.at(-1)![1]!.body as BodyInit).text())).toMatchObject({ model: "gpt-4o-mini" });

    fetchSpy.mockResolvedValueOnce(Response.json({ text: "Hello.", usage: { type: "duration", seconds: 3 } }));
    const uploaded = await send(transcription!, appKey!);
    expect(uploaded.status, uploaded.text).toBe(200);
    expect((await sentForm()).get("model")).toBe("whisper-1");
  });

  it("names an ElevenLabs transcription's model in model_id, where the proxy reads it, and the upload is served", async () => {
    const key = await seedManagementKey();
    const slug = await provider(key, { type: "elevenlabs", name: "ElevenLabs", slug: `elevenlabs-${crypto.randomUUID().slice(0, 6)}` });
    const { examples, appKey } = await snippetFor(key, {
      authentication: { type: "api_key", end_user: { source: "none" } },
      routing: { providers: { [slug]: { operations: ["elevenlabs.stt"] } } },
    });
    const [stt] = examples;
    expect(stt).toMatchObject({ operation: "elevenlabs.stt", form: { model_id: stt!.model }, file: { field: "file" } });
    expect(stt!.style).toBeUndefined();
    expect(stt!.curl).toContain(`--form-string 'model_id=${stt!.model}'`);
    fetchSpy.mockResolvedValueOnce(
      Response.json({ text: "Hello.", audio_duration_secs: 4.7 }, { headers: { "character-cost": "5", "fiat-cost-before-overages": "0.0005", "fiat-currency": "usd" } }),
    );
    const uploaded = await send(stt!, appKey!);
    expect(uploaded.status, uploaded.text).toBe(200);
    expect((await sentForm()).get("model_id")).toBe(stt!.model);
  });

  it("puts a model in the path where the operation reads it there, picked from our price list when the route allows any", async () => {
    const key = await seedManagementKey();
    const slug = await provider(key, { type: "gemini", name: "Gemini", slug: `gemini-${crypto.randomUUID().slice(0, 6)}` });
    const { examples } = await snippetFor(key, {
      authentication: { type: "api_key", end_user: { source: "none" } },
      routing: { providers: { [slug]: { operations: ["gemini.generate.v1beta"] } } },
    });
    const [generate] = examples;
    expect(generate!.model).toEqual(expect.any(String));
    expect(generate!.url).toBe(`${ORIGIN}/v2/apps/${generate!.url.split("/")[5]}/proxy/${slug}/v1beta/models/${generate!.model}:generateContent`);
    expect(generate!.body).toEqual({ contents: [{ role: "user", parts: [{ text: "Hello!" }] }] });
  });

  it("gives a preset's request without a model, at the preset's own address", async () => {
    const key = await seedManagementKey();
    const slug = await provider(key);
    const { appId, examples } = await snippetFor(key, {
      authentication: { type: "api_key", end_user: { source: "none" } },
      routing: { providers: { [slug]: { operations: ["openai.chat"], models: ["gpt-4o-mini"] } } },
      presets: { support: { provider: slug, operation: "openai.chat", model: "gpt-4o-mini" } },
    });
    expect(examples.at(-1)).toMatchObject({
      preset: "support",
      operation: "openai.chat",
      url: `${ORIGIN}/v2/apps/${appId}/presets/support`,
      model: null,
      body: { messages: [{ role: "user", content: "Hello!" }] },
    });
  });

  it("describes an iOS app's whole request without curl, pointing to the Swift SDK", async () => {
    const key = await seedManagementKey();
    const slug = await provider(key);
    const { appId, examples, notes } = await snippetFor(key, {
      authentication: { type: "apple_app_attest", end_user: { source: "app_install" }, app_attest: { team_id: "ABCDE12345", bundle_id: "com.example.snippet" } },
      routing: { providers: { [slug]: { operations: ["openai.chat", "openai.transcription"], models: ["gpt-4o-mini", "whisper-1"] } } },
    });
    const [chat, transcription] = examples;
    expect(chat!.curl).toBeUndefined();
    expect(chat!.text).toBe(
      [
        `POST ${ORIGIN}/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`,
        "Content-Type: application/json",
        "(The Swift SDK adds the gateway token and the App Attest proof.)",
        "",
        JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "Hello!" }] }, null, 2),
      ].join("\n"),
    );
    expect(transcription!.text).toContain("Content-Type: multipart/form-data");
    expect(transcription!.text).toMatch(/\nmodel: whisper-1\nfile: the file audio\.mp3$/u);
    expect(notes[0]).toMatch(/App Attest, which curl cannot do.*Swift SDK/u);
  });

  it("sends a gateway token where users sign in with an issuer, and exchanges for one without a credential in any argument", async () => {
    const key = await seedManagementKey();
    const slug = await provider(key);
    const issuer = { jwks_url: "https://issuer.example.com/jwks", issuer: ["https://issuer.example.com"], audience: ["snippet"], user_id_claim: "sub", required_claims: [], max_token_lifetime_seconds: 3600 };
    const { appId, examples, notes } = await snippetFor(key, {
      authentication: { type: "api_key", end_user: { source: "issuer", issuer } },
      routing: { providers: { [slug]: { operations: ["openai.chat"], models: ["gpt-4o-mini"] } } },
    });
    expect(examples[0]!.curl).toMatch(/^printf 'header = "Authorization: Bearer %s"\\n' "\$APP_AI_GATEWAY_TOKEN" \| curl --config - /u);
    expect(notes[0]).toContain(
      `printf 'data = {"api_key":"%s","issuer_token":"%s"}\\n' "$APP_AI_GATEWAY_KEY" "$ISSUER_TOKEN" | curl --config - '${ORIGIN}/v2/apps/${appId}/auth/token'`,
    );
  });

  it("follows a custom provider's listed path, with a model it prices", async () => {
    const key = await seedManagementKey();
    const slug = await provider(key, {
      type: "custom",
      name: "My LLM",
      slug: `my-llm-${crypto.randomUUID().slice(0, 6)}`,
      baseUrl: "https://llm.example.com/v1/",
      auth: { header: "x-api-key", format: "Key {key}" },
      passthrough: [{ method: "POST", path: "chat/completions", style: "openai-chat" }],
      pricing: { "local-llm": { input: 1, output: 2 } },
    });
    const { appId, examples } = await snippetFor(key, {
      authentication: { type: "api_key", end_user: { source: "none" } },
      routing: { providers: { [slug]: { operations: ["custom.openai-chat"] } } },
    });
    expect(examples).toEqual([
      expect.objectContaining({ operation: "custom.openai-chat", url: `${ORIGIN}/v2/apps/${appId}/proxy/${slug}/chat/completions`, model: "local-llm" }),
    ]);
  });

  it("answers app_not_found for another account's real app, and for one that does not exist", async () => {
    const owner = await seedManagementKey({ accountId: `acct-owner-${crypto.randomUUID().slice(0, 8)}` });
    const created = await request(owner, "POST", "/v2/admin/apps", { name: "Theirs", config: { authentication: { type: "api_key", end_user: { source: "none" } } } });
    expect(created.status).toBe(201);
    const appId = created.body.app.id as string;
    expect((await request(owner, "GET", `/v2/admin/apps/${appId}/snippet`)).status).toBe(200);

    const stranger = await seedManagementKey({ accountId: `acct-other-${crypto.randomUUID().slice(0, 8)}`, grant: "read" });
    const refused = await request(stranger, "GET", `/v2/admin/apps/${appId}/snippet`);
    expect(refused.status).toBe(404);
    expect(refused.body.error.code).toBe("app_not_found");
    expect(JSON.stringify(refused.body)).not.toContain("Theirs");
    expect((await request(stranger, "GET", "/v2/admin/apps/no-such-app/snippet")).body.error.code).toBe("app_not_found");
  });
});

describe("shell words", () => {
  it("quotes text so a shell reads it back as it is", () => {
    expect(shellWord("plain")).toBe("'plain'");
    expect(shellWord("it's $HOME `x`")).toBe(`'it'\\''s $HOME \`x\`'`);
  });
});
