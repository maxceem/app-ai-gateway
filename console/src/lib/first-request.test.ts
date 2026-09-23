import { describe, expect, it } from "vitest";
import {
  curlSnippet,
  exampleNotes,
  firstRequest,
  swiftSignsInUsers,
  swiftSnippet,
  type ExamplePolicy,
  type ExampleProvider,
  type ExampleRouting,
  type RequestExample,
} from "@shared/first-request";

/** An application that selects one instance, under whatever policy a case needs. */
const routing = (policy: Partial<ExamplePolicy> = {}): ExampleRouting => ({
  providers: {
    mode: "selected",
    selected: { custom: { allowed_paths: [], allowed_models: [], ...policy } },
  },
  model_rewrites: {},
});
const provider = (type = "openai"): ExampleProvider => ({ slug: "custom", type, status: "active" });
const prices = { openai: { "text-model": { input: 1, output: 2 } } };

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
  it("keeps an audio-only app's own path and stands the body in", () => {
    const example = firstRequest(routing({ allowed_paths: ["v1/audio/transcriptions", "v1/*"] }), [provider()], prices);
    expect(example).toMatchObject({ target: { path: "v1/audio/transcriptions" }, body: null, gaps: ["body"] });
    expect(curlSnippet({ baseUrl: "https://gw.test", appId: "app-1", example })).toContain("-d 'REQUEST_BODY'");
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
    const app_attest = { team_id: "ABCDE12345", bundle_id: "com.example.app", environments: ["production" as const] };
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
  it("calls a named endpoint at its own URL", () => {
    const example: RequestExample = { target: { endpoint: "chat" }, body: { input: "Say hello." }, anthropic: false, gaps: [] };
    expect(curlSnippet({ baseUrl: "https://gw.test", appId: "app-1", example })).toContain(
      "https://gw.test/v1/apps/app-1/endpoints/chat",
    );
    expect(swiftSnippet({ baseUrl: "https://gw.test", appId: "app-1", example })).toContain('endpointSlug: "chat"');
  });
});
