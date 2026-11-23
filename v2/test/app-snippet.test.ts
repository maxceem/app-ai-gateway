/**
 * First requests for an app (`getAppSnippet`): built from its routes, its
 * presets and the operation descriptions, as curl for an app called with a
 * key, never holding a key.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import { shellWord } from "../src/admin/app-snippet.ts";
import { LOAD_MANAGEMENT_TIMEOUT_MS, loadManagement, seedManagementKey } from "./helpers.ts";

beforeAll(loadManagement, LOAD_MANAGEMENT_TIMEOUT_MS);

const ORIGIN = "https://gateway.test";
const PROVIDER_KEY = "sk-live-secret-abcd";

async function request(key: string, method: string, path: string, body?: unknown) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
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
  return { appId, ...(answer.body as { app_id: string; base_url: string; examples: Record<string, any>[]; notes: string[] }) };
}

describe("first requests for an app", () => {
  it("gives one curl per API style a route serves, with the app key read from the environment and the end user's header", async () => {
    const key = await seedManagementKey();
    const slug = await provider(key);
    const { appId, base_url, examples, notes } = await snippetFor(key, {
      authentication: { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } },
      routing: {
        providers: {
          [slug]: { operations: ["openai.chat", "openai.chat.bare", "openai.embeddings", "openai.transcription", "openai.speech", "openai.realtime"], models: ["gpt-4o-mini"] },
        },
      },
    });
    expect(base_url).toBe(ORIGIN);
    // openai.chat.bare speaks the style openai.chat already shows; openai.realtime has no style.
    expect(examples.map((example) => [example.operation, example.style])).toEqual([
      ["openai.chat", "openai-chat"],
      ["openai.embeddings", "openai-embeddings"],
      ["openai.transcription", "openai-transcription"],
      ["openai.speech", "openai-speech"],
    ]);
    const [chat, , transcription, speech] = examples;
    expect(chat).toMatchObject({
      provider: slug,
      method: "POST",
      url: `${ORIGIN}/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`,
      model: "gpt-4o-mini",
      body: { model: "gpt-4o-mini", messages: [{ role: "user", content: "Hello!" }] },
    });
    expect(chat!.curl).toBe(
      [
        `curl '${ORIGIN}/v2/apps/${appId}/proxy/${slug}/v1/chat/completions'`,
        `-H "Authorization: Bearer $APP_AI_GATEWAY_KEY"`,
        `-H 'x-end-user-id: user-123'`,
        `-H 'Content-Type: application/json'`,
        `-d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Hello!"}]}'`,
      ].join(" \\\n  "),
    );
    // A form: the file is read, the model never is.
    expect(transcription!.curl).toContain(`-F 'file=@audio.mp3' \\\n  --form-string 'model=gpt-4o-mini'`);
    expect(transcription!.body).toBeUndefined();
    expect(speech!.curl).toMatch(/--output speech\.mp3$/u);
    expect(notes).toContainEqual(expect.stringContaining("Set APP_AI_GATEWAY_KEY to one of this app's keys"));
    expect(notes).toContainEqual(expect.stringContaining(`${slug}: openai.realtime has no example here`));
    expect(JSON.stringify(examples)).not.toContain(PROVIDER_KEY);
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
    expect(generate!.url).toMatch(new RegExp(`/proxy/${slug}/v1beta/models/[^/]+:generateContent$`, "u"));
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

  it("gives an iOS app its requests without curl, pointing to the Swift SDK", async () => {
    const key = await seedManagementKey();
    const slug = await provider(key);
    const { examples, notes } = await snippetFor(key, {
      authentication: { type: "apple_app_attest", end_user: { source: "app_install" }, app_attest: { team_id: "ABCDE12345", bundle_id: "com.example.snippet" } },
      routing: { providers: { [slug]: { operations: ["openai.chat"], models: ["gpt-4o-mini"] } } },
    });
    expect(examples).toHaveLength(1);
    expect(examples[0]!.curl).toBeUndefined();
    expect(examples[0]!.body).toMatchObject({ model: "gpt-4o-mini" });
    expect(notes[0]).toMatch(/App Attest, which curl cannot do.*Swift SDK/u);
  });

  it("sends a gateway token where users sign in with an issuer, and says how to get one", async () => {
    const key = await seedManagementKey();
    const slug = await provider(key);
    const issuer = { jwks_url: "https://issuer.example.com/jwks", issuer: ["https://issuer.example.com"], audience: ["snippet"], user_id_claim: "sub", required_claims: [], max_token_lifetime_seconds: 3600 };
    const { appId, examples, notes } = await snippetFor(key, {
      authentication: { type: "api_key", end_user: { source: "issuer", issuer } },
      routing: { providers: { [slug]: { operations: ["openai.chat"], models: ["gpt-4o-mini"] } } },
    });
    expect(examples[0]!.curl).toContain(`-H "Authorization: Bearer $APP_AI_GATEWAY_TOKEN"`);
    expect(notes[0]).toContain(`curl '${ORIGIN}/v2/apps/${appId}/auth/token'`);
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

  it("answers a read-only key, and app_not_found for an app that is not the account's", async () => {
    const reader = await seedManagementKey({ grant: "read" });
    expect((await request(reader, "GET", "/v2/admin/apps/no-such-app/snippet")).body.error.code).toBe("app_not_found");
  });
});

describe("shell words", () => {
  it("quotes text so a shell reads it back as it is", () => {
    expect(shellWord("plain")).toBe("'plain'");
    expect(shellWord("it's $HOME `x`")).toBe(`'it'\\''s $HOME \`x\`'`);
  });
});
