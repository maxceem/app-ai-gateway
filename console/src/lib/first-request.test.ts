import { describe, expect, it } from "vitest";
import {
  curlSnippet,
  endpointRequest,
  exampleNotes,
  firstRequest,
  swiftSignsInUsers,
  swiftSnippet,
  type ExamplePolicy,
  type ExampleProvider,
  type ExampleRouting,
  type RequestExample,
} from "@shared/first-request";
import { providerPolicyFor, reachableProviders } from "@shared/app-config";

/** An application that selects one instance, under whatever policy a case needs. */
const routing = (policy: Partial<ExamplePolicy> = {}): ExampleRouting => ({
  providers: {
    mode: "selected",
    selected: { custom: { allowed_paths: [], allowed_models: [], ...policy } },
  },
  model_rewrites: {},
});
const provider = (type: ExampleProvider["type"] = "openai"): ExampleProvider => ({
  slug: "custom",
  type,
  status: "active",
  providerGatewayId: null,
  pricing: null,
});
const prices = {
  // First on purpose: a catalog that opens on an embedding model must still
  // give a text example.
  openai: {
    "embedding-model": { kind: "embedding" as const },
    "text-model": { kind: "text" as const },
    "image-model": { kind: "image" as const },
    "transcribe-model": { kind: "transcription" as const },
  },
};

describe("first request examples", () => {
  it("uses the configured slug and catalog model for an unrestricted policy", () => {
    expect(firstRequest(routing(), [provider()], prices)).toMatchObject({
      target: { provider: "custom", path: "v1/responses" },
      body: { model: "text-model", input: "Say hello." },
      gaps: [],
    });
  });
  it("honors an allowed path's fixed model and adds Anthropic's version header", () => {
    expect(firstRequest(routing({ allowed_paths: [{ path: "v1/messages", fixed_model: "fixed-model" }] }), [provider("anthropic")], prices))
      .toMatchObject({ target: { path: "v1/messages" }, anthropic: true, body: { model: "fixed-model", max_tokens: 128 } });
  });
  it("uses Groq's native prefix and an explicitly allowed model", () => {
    expect(firstRequest(routing({ allowed_models: ["allowed-model"] }), [provider("groq")], prices))
      .toMatchObject({ target: { path: "openai/v1/chat/completions" }, body: { model: "allowed-model" } });
  });
  it("normalizes a gateway-routed provider onto the chat-completions surface", () => {
    expect(firstRequest(routing(), [{ ...provider("groq"), providerGatewayId: "gw-1" }], prices))
      .toMatchObject({ target: { path: "v1/chat/completions" } });
  });

  it("stands a provider and a model in when the account has neither", () => {
    const example = firstRequest(routing(), [{ ...provider(), status: "disabled" }], prices);
    expect(example).toMatchObject({
      target: { provider: "PROVIDER_SLUG", path: "v1/chat/completions" },
      body: { model: "MODEL" },
      gaps: ["provider", "model"],
    });
    expect(exampleNotes(example)).toHaveLength(2);
    expect(curlSnippet({ baseUrl: "https://gw.test", appId: "app-1", example })).toContain(
      "https://gw.test/v1/apps/app-1/proxy/PROVIDER_SLUG/v1/chat/completions",
    );
  });
  it("stands a model in for a provider type the catalog does not price", () => {
    expect(firstRequest(routing(), [provider("cerebras")], prices)).toMatchObject({
      target: { provider: "custom", path: "v1/chat/completions" },
      body: { model: "MODEL" },
      gaps: ["model"],
    });
  });
  it("keeps an audio-only app's own path and uploads a recording to it", () => {
    const example = firstRequest(routing({ allowed_paths: ["v1/audio/transcriptions", "v1/*"] }), [provider()], prices);
    expect(example).toMatchObject({ target: { path: "v1/audio/transcriptions" }, body: null, form: { file: "@recording.m4a", model: "transcribe-model" } });
    const curl = curlSnippet({ baseUrl: "https://gw.test", appId: "app-1", example });
    expect(curl).toContain("-F 'file=@recording.m4a'");
    expect(curl).not.toContain("Content-Type");
    expect(swiftSnippet({ baseUrl: "https://gw.test", appId: "app-1", example }))
      .toContain('contentType: "multipart/form-data; boundary=\\(boundary)"');
  });
  it("names a model of the kind each allowed path carries", () => {
    expect(firstRequest(routing({ allowed_paths: ["v1/embeddings"] }), [provider()], prices)).toMatchObject({
      target: { path: "v1/embeddings" },
      body: { model: "embedding-model", input: expect.any(String) },
      gaps: [],
    });
    // An allowlist with nothing the path carries stands a model in, rather
    // than sending a text model to the embeddings API.
    const example = firstRequest(
      routing({ allowed_paths: ["v1/embeddings"], allowed_models: ["text-model"] }),
      [provider()],
      prices,
    );
    expect(example).toMatchObject({ body: { model: "MODEL" }, gaps: ["model"] });
  });
  it("calls an app that allows only image models on the image API", () => {
    expect(firstRequest(routing({ allowed_models: ["image-model"] }), [provider()], prices)).toMatchObject({
      target: { path: "v1/images/generations" },
      body: { model: "image-model", prompt: "A lighthouse at dawn." },
    });
  });

  it("writes both snippets against one example", () => {
    const example = firstRequest(routing(), [provider()], prices);
    const curl = curlSnippet({ baseUrl: "https://gw.test/", appId: "app 1", example, notes: ["Note."] });
    expect(curl).toContain("# Note.");
    expect(curl).toContain("https://gw.test/v1/apps/app%201/proxy/custom/v1/responses");
    expect(curl).toContain('-H "Authorization: Bearer $APP_AI_GATEWAY_KEY"');
    const swift = swiftSnippet({ baseUrl: "https://gw.test", appId: "app-1", example });
    expect(swift).toContain("authMode: .appAttestInstall");
    expect(swift).toContain('providerPath: "v1/responses"');
    expect(swift).toContain('Data("{\\"model\\":\\"text-model\\",\\"input\\":\\"Say hello.\\"}".utf8)');
    expect(swift).toContain("let (data, _) = try await gateway.withAuthorizedRequest(");
    expect(swift).toContain(") { try await URLSession.shared.data(for: $0) }");
    expect(swift).not.toContain("gateway.authorizedRequest(");
  });
  it("adds Anthropic's version header inside the Swift send closure", () => {
    const example = firstRequest(routing({ allowed_paths: [{ path: "v1/messages", fixed_model: "fixed-model" }] }), [provider("anthropic")], prices);
    const swift = swiftSnippet({ baseUrl: "https://gw.test", appId: "app-1", example });
    expect(swift).toContain(
      ') { request in\n    var request = request\n    request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")\n    return try await URLSession.shared.data(for: request)\n}\n',
    );
  });
  it("writes the Swift client's auth mode from the app's own authentication", () => {
    const example = firstRequest(routing(), [provider()], prices);
    const issuer = {
      provider: "firebase" as const,
      jwks_url: "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
      issuer: ["https://securetoken.google.com/my-app"],
      audience: ["my-app"],
      user_id_claim: "sub",
      required_claims: [],
      max_token_lifetime_seconds: 86400,
    };
    const app_attest = { team_id: "ABCDE12345", bundle_id: "com.example.app", environments: ["production" as const], verify_on: "every_request" as const };
    const signedIn = {
      type: "apple_app_attest" as const,
      app_attest,
      end_user: { source: "issuer" as const, issuer },
    };
    expect(swiftSignsInUsers(signedIn)).toBe(true);
    expect(swiftSnippet({ baseUrl: "https://gw.test", appId: "app-1", example, authentication: signedIn }))
      .toContain("authMode: .appAttest(issuerTokenProvider:");
    const installs = { type: "apple_app_attest" as const, app_attest, end_user: { source: "app_install" as const } };
    expect(swiftSignsInUsers(installs)).toBe(false);
    expect(swiftSnippet({ baseUrl: "https://gw.test", appId: "app-1", example, authentication: installs }))
      .toContain("authMode: .appAttestInstall");
  });
  it("calls a custom endpoint at its own URL", () => {
    const example: RequestExample = { target: { endpoint: "chat" }, body: { input: "Say hello." }, anthropic: false, gaps: [] };
    expect(curlSnippet({ baseUrl: "https://gw.test", appId: "app-1", example })).toContain(
      "https://gw.test/v1/apps/app-1/endpoints/chat",
    );
    expect(swiftSnippet({ baseUrl: "https://gw.test", appId: "app-1", example })).toContain('endpointSlug: "chat"');
  });
});

describe("which provider instances an app can reach", () => {
  const instances = [
    { slug: "openai", status: "active" },
    { slug: "paused", status: "disabled" },
    { slug: "other", status: "active" },
  ];
  it("reaches every active instance in all-mode, under an unrestricted policy", () => {
    const all = { providers: { mode: "all" as const }, model_rewrites: {} };
    expect(reachableProviders(all, instances).map((i) => i.slug)).toEqual(["openai", "other"]);
    expect(providerPolicyFor(all, "anything")).toEqual({ allowed_paths: [], allowed_models: [] });
  });
  it("reaches only the named active instances in selected-mode, and never a prototype key", () => {
    const selected = {
      providers: {
        mode: "selected" as const,
        selected: {
          openai: { allowed_paths: ["v1/responses"], allowed_models: [] },
          paused: { allowed_paths: [], allowed_models: [] },
        },
      },
      model_rewrites: {},
    };
    expect(reachableProviders(selected, instances).map((i) => i.slug)).toEqual(["openai"]);
    expect(providerPolicyFor(selected, "other")).toBeUndefined();
    expect(providerPolicyFor(selected, "constructor")).toBeUndefined();
  });
});

describe("custom endpoint examples", () => {
  it("sends the body its style and kind take, with no model", () => {
    expect(endpointRequest("draw", { api_style: "image_generation" })).toMatchObject({
      target: { endpoint: "draw" },
      body: { prompt: "A lighthouse at dawn." },
      gaps: [],
    });
    expect(endpointRequest("voice", { api_style: "gemini_native", kind: "speech" }).body).toEqual({
      contents: [{ parts: [{ text: "Say hello." }] }],
      generationConfig: { responseModalities: ["AUDIO"] },
    });
    expect(endpointRequest("chat", { api_style: "anthropic_messages" })).toMatchObject({ anthropic: true, body: { max_tokens: 128 } });
    expect(endpointRequest("embed", { api_style: "gemini_embedding" }).body).toEqual({ content: { parts: [{ text: "Hello." }] } });
    expect(endpointRequest("listen", { api_style: "audio_transcription" })).toMatchObject({ body: null, form: { file: "@recording.m4a" }, gaps: [] });
  });
});
