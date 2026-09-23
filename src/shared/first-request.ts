/**
 * The first request an application can send, as data and as code.
 *
 * One source for the console's example card and the CLI's `app snippet`, so the
 * two cannot show different examples. It imports
 * only from `src/shared`, for the reason `./capabilities.ts` gives: the console
 * bundles it, so nothing from `src/core` may reach it.
 *
 * The example is always produced. An application created a minute ago has no
 * provider, no catalogued model, and sometimes a policy that allows no path
 * this module knows the request shape of — and a reader in that position is
 * exactly the one who needs to see what a call looks like. What cannot be
 * resolved becomes a named placeholder and a note saying why, so nothing here
 * ever invents a provider slug or a model ID that would fail on arrival while
 * looking like configuration.
 */

import {
  providerPolicyFor,
  reachableProviders,
  type AuthenticationConfig,
  type ProviderPolicy,
  type RoutingConfig,
} from "./app-config.ts";
import { API_STYLE_PATHS } from "./capabilities.ts";
import { isProviderType, providerDescriptor } from "./providers.ts";

export const PROVIDER_PLACEHOLDER = "PROVIDER_SLUG";
export const MODEL_PLACEHOLDER = "MODEL";
export const BODY_PLACEHOLDER = "REQUEST_BODY";

/** What in an example stands in for configuration that does not exist yet. */
export type ExampleGap = "provider" | "model" | "body";

export const EXAMPLE_GAP_NOTES: Record<ExampleGap, string> = {
  provider: `No provider is configured yet, so ${PROVIDER_PLACEHOLDER} stands in for one. Add a provider key, then use its slug.`,
  model: `No priced model was found for this provider, so ${MODEL_PLACEHOLDER} stands in for one. Use a model the provider serves.`,
  body: `This app allows no path whose request shape is known here, so ${BODY_PLACEHOLDER} stands in for the body the provider documents.`,
};

/** One entry of an app's proxy policy, as the configuration carries it. */
export type ExamplePolicy = ProviderPolicy;

/**
 * Which providers an app may reach, and under what policy: the application's
 * own routing block, not a projection of it. There is one shape for this and
 * this module reads it directly.
 */
export type ExampleRouting = RoutingConfig;

/** As much of a provider as an example needs: where it sits and what it prices. */
export interface ExampleProvider {
  slug: string;
  type: string;
  status: string;
  providerGatewayId?: string | null;
  pricing?: Record<string, unknown> | null;
}

/** The price catalog, by provider type and model. Only the presence of an output price is read. */
export type ExamplePrices = Record<string, Record<string, { output?: number }>>;

/** Where a request goes: a provider path through the proxy, or a named endpoint. */
export type ExampleTarget =
  | { provider: string; path: string }
  | { endpoint: string };

export interface RequestExample {
  target: ExampleTarget;
  /** Null when no shape is known for the path, which is what the `body` gap means. */
  body: Record<string, unknown> | null;
  /** Whether the request needs Anthropic's client API version header. */
  anthropic: boolean;
  gaps: ExampleGap[];
}

/**
 * The path a provider type's first call goes to.
 *
 * The provider descriptor carries the type's own answer — OpenAI and Anthropic
 * name their current surfaces, the OpenAI-compatible hosts name whichever
 * prefix they serve one under, and the default is the plain
 * `v1/chat/completions` most of them use. What is decided here is the two
 * things a descriptor cannot answer alone: a type whose native generation path
 * carries the model in the URL has no example without one, and a gateway in
 * front of an OpenAI-compatible host republishes it under the standard path, so
 * the host's own prefix is normalized away. A type whose example is its own
 * Responses or Messages API keeps it either way — every gateway here serves
 * those too.
 */
export function examplePath(
  type: string,
  { gatewayRouted = false, model }: { gatewayRouted?: boolean; model?: string } = {},
): string | undefined {
  const descriptor = isProviderType(type) ? providerDescriptor(type) : undefined;
  if (descriptor?.modelInPath) {
    return model ? API_STYLE_PATHS.gemini_native.replace("{model}", model) : undefined;
  }
  const own = descriptor?.examplePath ?? API_STYLE_PATHS.chat_completions;
  return gatewayRouted && own.endsWith("chat/completions")
    ? API_STYLE_PATHS.chat_completions
    : own;
}

/** The request body a path takes, or null where this module knows of none. */
function bodyFor(path: string, model: string): Record<string, unknown> | null {
  const messages = [{ role: "user", content: "Say hello." }];
  if (path.endsWith("responses")) return { model, input: "Say hello." };
  if (path.endsWith("chat/completions")) return { model, messages };
  if (path.endsWith("messages")) return { model, max_tokens: 128, messages };
  if (path.endsWith(":generateContent"))
    return { contents: [{ parts: [{ text: "Say hello." }] }] };
  return null;
}

/** The models an app may name on a provider, best first. */
function modelsFor(
  provider: ExampleProvider,
  policy: ExamplePolicy | undefined,
  prices: ExamplePrices,
): string[] {
  if (policy?.allowed_models?.length) return policy.allowed_models;
  return [
    ...Object.keys(provider.pricing ?? {}),
    ...Object.entries(prices[provider.type] ?? {})
      .filter(([, price]) => price.output !== undefined)
      .map(([model]) => model),
  ];
}

/**
 * The example this app would send today, using its own policy and catalog.
 *
 * Candidates are tried in configuration order and the first one whose path has
 * a known request shape wins, so a restricted app gets an example inside its
 * own allowlist rather than one the gateway would refuse. Wildcards are skipped
 * for the same reason: a pattern is not a path a client can call.
 */
export function firstRequest(
  routing: ExampleRouting | null | undefined,
  providers: ExampleProvider[],
  prices: ExamplePrices,
): RequestExample {
  let fallback: RequestExample | undefined;
  // With no routing known yet, every active instance is a candidate.
  const candidates = routing
    ? reachableProviders(routing, providers)
    : providers.filter((provider) => provider.status === "active");
  for (const provider of candidates) {
    // The app's own policy for the instance, where it names one; an all-mode
    // app has none of its own and takes the catalog's models and paths.
    const policy = routing?.providers.mode === "selected"
      ? providerPolicyFor(routing, provider.slug)
      : undefined;
    const models = modelsFor(provider, policy, prices);
    const model = models[0] ?? MODEL_PLACEHOLDER;
    const gaps: ExampleGap[] = models.length ? [] : ["model"];
    const fallbackPath = examplePath(provider.type, {
      gatewayRouted: Boolean(provider.providerGatewayId),
      model,
    });
    const paths = policy?.allowed_paths?.length
      ? policy.allowed_paths
      : fallbackPath
        ? [fallbackPath]
        : [];
    for (const entry of paths) {
      const path = typeof entry === "string" ? entry : entry.path;
      if (path.includes("*")) continue;
      const fixed = typeof entry !== "string" ? entry.fixed_model : undefined;
      const body = bodyFor(path, fixed ?? model);
      const example: RequestExample = {
        target: { provider: provider.slug, path },
        body,
        anthropic: path.endsWith("messages"),
        // A fixed model is the app's own, so a catalog that has none of its
        // own to offer is not a gap on a path that never carries one.
        gaps: body && fixed ? [] : gaps,
      };
      if (body) return example;
      fallback ??= { ...example, gaps: [...example.gaps, "body"] };
    }
  }
  return (
    fallback ?? {
      target: { provider: PROVIDER_PLACEHOLDER, path: "v1/chat/completions" },
      body: bodyFor("v1/chat/completions", MODEL_PLACEHOLDER),
      anthropic: false,
      gaps: ["provider", "model"],
    }
  );
}

/** The notes an example's gaps call for, in the order a reader meets them. */
export function exampleNotes(example: RequestExample): string[] {
  return example.gaps.map((gap) => EXAMPLE_GAP_NOTES[gap]);
}

/** The URL a target is called at, under one gateway and one application. */
export function exampleUrl(baseUrl: string, appId: string, target: ExampleTarget): string {
  const origin = baseUrl.replace(/\/+$/, "");
  const app = `${origin}/v1/apps/${encodeURIComponent(appId)}`;
  return "endpoint" in target
    ? `${app}/endpoints/${encodeURIComponent(target.endpoint)}`
    : `${app}/proxy/${encodeURIComponent(target.provider)}/${target.path}`;
}

/** One shell word, safe to paste: single-quoted, with any quote of its own closed and reopened. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

interface SnippetOptions {
  baseUrl: string;
  appId: string;
  example: RequestExample;
  /** Lines to explain the example before it, as that language's comments. */
  notes?: string[];
}

function commented(notes: string[] | undefined, marker: string): string {
  return (notes ?? []).map((note) => `${marker} ${note}\n`).join("");
}

/**
 * The same request as a shell command, for a server application.
 *
 * `keyExpression` is what follows `Bearer `, in double quotes so that a shell
 * variable naming the key expands. It is never the key itself: no caller has
 * one to pass, and the CLI, which has just written one to disk, passes the
 * expression that reads it back.
 */
export function curlSnippet(
  options: SnippetOptions & { keyExpression?: string },
): string {
  const { baseUrl, appId, example, notes, keyExpression = "$APP_AI_GATEWAY_KEY" } = options;
  const body = example.body ? JSON.stringify(example.body) : BODY_PLACEHOLDER;
  return (
    commented(notes, "#") +
    `curl --fail-with-body ${shellQuote(exampleUrl(baseUrl, appId, example.target))} \\\n` +
    `  -H "Authorization: Bearer ${keyExpression}" \\\n` +
    `  -H 'Content-Type: application/json' \\\n` +
    (example.anthropic ? "  -H 'anthropic-version: 2023-06-01' \\\n" : "") +
    `  -d ${shellQuote(body)}\n`
  );
}

/** The note an issuer-signed-in iOS app's example carries, where its token provider is a stand-in. */
export const ISSUER_TOKEN_NOTE =
  "Replace yourIdentitySDK.currentIDToken(forceRefresh: forceRefresh) with your configured issuer integration.";

/**
 * Whether an iOS application's users sign in with an issuer, which is what
 * decides how the Swift client authenticates: an App Attest install alone, or
 * App Attest plus the user's own signed token.
 */
export function swiftSignsInUsers(authentication: AuthenticationConfig | undefined): boolean {
  return authentication?.type === "apple_app_attest" && authentication.end_user.source === "issuer";
}

/** The Swift client's `authMode` argument for an application, from its own configuration. */
function swiftAuthMode(authentication: AuthenticationConfig | undefined): string {
  return swiftSignsInUsers(authentication)
    ? ".appAttest(issuerTokenProvider: { forceRefresh in\n        // Return a fresh signed token from your configured identity SDK.\n        try await yourIdentitySDK.currentIDToken(forceRefresh: forceRefresh)\n    })"
    : ".appAttestInstall";
}

/**
 * The same request through the Swift package, for an iOS application.
 *
 * The client's `authMode` follows from the application's authentication, so
 * every caller writes the same one: an app whose users come from an issuer gets
 * a token provider, one that identifies installs gets the install mode. A
 * caller that cannot read the configuration passes none and gets the latter.
 */
export function swiftSnippet(
  options: SnippetOptions & { authentication?: AuthenticationConfig },
): string {
  const { baseUrl, appId, example, notes, authentication } = options;
  const authMode = swiftAuthMode(authentication);
  const target =
    "endpoint" in example.target
      ? `endpointSlug: ${JSON.stringify(example.target.endpoint)}`
      : `provider: ${JSON.stringify(example.target.provider)},\n    providerPath: ${JSON.stringify(example.target.path)}`;
  const body = example.body
    ? `request.httpBody = Data(${JSON.stringify(JSON.stringify(example.body))}.utf8)`
    : `// Supply the provider-native JSON body.\nrequest.httpBody = Data(${JSON.stringify(BODY_PLACEHOLDER)}.utf8)`;
  return (
    commented(notes, "//") +
    `import Foundation
import AppAIGateway

let gateway = AppAIGatewayClient(
    appID: ${JSON.stringify(appId)},
    baseURL: URL(string: ${JSON.stringify(baseUrl.replace(/\/+$/, ""))})!,
    authMode: ${authMode}
)

var request = try await gateway.authorizedRequest(
    ${target}
)
request.setValue("application/json", forHTTPHeaderField: "Content-Type")
${example.anthropic ? 'request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")\n' : ""}${body}
let (data, _) = try await URLSession.shared.data(for: request)
print(String(decoding: data, as: UTF8.self))
`
  );
}
