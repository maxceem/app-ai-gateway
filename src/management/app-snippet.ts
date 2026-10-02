import type { AppSnippetResponse } from "../contracts/responses";
import type { AppSnippetQuery } from "../contracts/schemas";
import { storedAppFromRow } from "../core/app-records";
import { GatewayError } from "../core/errors";
import type { app } from "../db/schema";
import { reachableProviders } from "../shared/app-config";
import {
  curlSnippet,
  exampleNotes,
  firstRequest,
  ISSUER_TOKEN_NOTE,
  swiftSignsInUsers,
  swiftSnippet,
  type RequestExample,
} from "../shared/first-request";
import type { Actor } from "./actor";
import { modelPrices } from "./prices";
import { listProviders } from "./providers";
import type { ManagementScope } from "./scope";

type AppRow = typeof app.$inferSelect;

/** What a Swift example says before its own notes: where the client comes from, and where it runs. */
const SWIFT_SETUP_NOTES = [
  "Swift package: https://github.com/maxceem/app-ai-gateway-swift (from: 1.0.0)",
  "Enable App Attest and test on a supported physical device.",
];

/**
 * The first request an application can send, written against what it has
 * today.
 *
 * A provider it can reach and a priced model where those exist, and a named
 * placeholder with a note where they do not, so a new application is never
 * left to compose its first call from the reference. The language follows the
 * application's authentication — an App Attest caller holds an assertion
 * rather than a key, and a server caller holds a key the Swift client has no
 * way to send — and the URL is the one application clients call, which is not
 * always the one this API was reached on.
 *
 * Nothing here ever writes a credential: a server application's example reads
 * its key from `APP_AI_GATEWAY_KEY`, and a caller that holds the key's file
 * adds how to fill that in itself.
 */
export async function appSnippet(
  scope: ManagementScope,
  actor: Actor,
  row: AppRow,
  query: AppSnippetQuery,
): Promise<AppSnippetResponse> {
  const stored = storedAppFromRow(row);
  const { authentication, routing, endpoints } = stored.config;
  const ios = authentication.type === "apple_app_attest";
  const language = query.language ?? (ios ? "swift" : "curl");
  if ((language === "swift") !== ios) {
    throw new GatewayError(
      400,
      "unsupported_snippet",
      ios
        ? "iOS applications authenticate with App Attest, which curl cannot perform. Ask for language=swift."
        : "Swift snippets are for iOS applications. Ask for language=curl.",
    );
  }
  const notes: string[] = [];
  let example: RequestExample;
  if (query.endpoint !== undefined) {
    const endpoint = Object.hasOwn(endpoints, query.endpoint) ? endpoints[query.endpoint] : undefined;
    if (!endpoint) {
      throw new GatewayError(404, "endpoint_not_found", "This app has no custom endpoint with that name");
    }
    // A custom endpoint holds the provider, the model and the parameters, so
    // the client sends only what its style documents.
    const responses = endpoint.api_style === "responses";
    example = {
      target: { endpoint: query.endpoint },
      body: responses ? { input: "Say hello." } : null,
      anthropic: false,
      gaps: responses ? [] : ["body"],
    };
  } else {
    const { providers } = await listProviders(scope, actor);
    // What this application may send to today, which is narrower than what
    // the account holds.
    const reachable = reachableProviders(routing, providers);
    const requested = query.provider;
    if (requested !== undefined && !reachable.some((provider) => provider.slug === requested)) {
      if (providers.some((provider) => provider.slug === requested)) {
        throw new GatewayError(
          400,
          "provider_unavailable",
          "That provider is disabled or outside this app's routing",
        );
      }
      throw new GatewayError(404, "provider_not_found", "No provider has that slug");
    }
    example = firstRequest(
      routing,
      requested === undefined ? reachable : reachable.filter((provider) => provider.slug === requested),
      modelPrices().prices,
    );
    if (requested === undefined && reachable.length > 1) {
      notes.push(`This app can reach ${reachable.length} providers. Ask for provider=<slug> for a different one.`);
    }
  }
  notes.push(...exampleNotes(example));
  const baseUrl = scope.deployment.apiUrl();
  if (!ios) {
    return {
      language: "shell",
      snippet: curlSnippet({ baseUrl, appId: stored.id, example, notes }),
      notes,
    };
  }
  if (swiftSignsInUsers(authentication)) notes.push(ISSUER_TOKEN_NOTE);
  return {
    language: "swift",
    snippet: swiftSnippet({
      baseUrl,
      appId: stored.id,
      example,
      authentication,
      notes: [...SWIFT_SETUP_NOTES, ...notes],
    }),
    notes,
  };
}
