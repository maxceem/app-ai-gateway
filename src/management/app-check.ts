import type { AppCheckResponse } from "../contracts/responses";
import { storedAppFromRow } from "../core/app-records";
import { GatewayError } from "../core/errors";
import type { app } from "../db/schema";
import {
  ConfigError,
  parseAppConfig,
  providerPolicyFor,
  reachableProviders,
} from "../shared/app-config";
import type { Actor } from "./actor";
import { validateApp } from "./apps";
import { listProviders } from "./providers";
import type { ManagementScope } from "./scope";

type AppRow = typeof app.$inferSelect;

/**
 * What a check cannot establish, said in every answer: it reads
 * configuration, and nothing about a real client or a real provider call.
 */
export const APP_CHECK_LIMITATIONS = [
  "No inference was sent.",
  "Physical device attestation, issuer login, subscription entitlement and upstream credentials were not exercised.",
] as const;

/**
 * Whether a stored application could serve a request, as far as its
 * configuration says.
 *
 * The configuration is judged as an update of it would be, so a provider it
 * named before that provider was deleted is still accepted, and a stored
 * configuration that would now be refused answers with that refusal. The
 * providers are every instance its routing names, a paused one included, so a
 * disabled provider is reported as disabled rather than left out; `ready` is an
 * active application with at least one of them active.
 *
 * The stored configuration's grammar is judged here first, by the one parser:
 * everywhere else a row that no longer parses is the deployment's own fault
 * and answers 500, but a check exists to say what is wrong with a
 * configuration, so here it answers 400 with the schema's own sentence.
 */
export async function checkApp(
  scope: ManagementScope,
  actor: Actor,
  row: AppRow,
): Promise<AppCheckResponse> {
  try {
    parseAppConfig(row.config);
  } catch (error) {
    if (error instanceof ConfigError) throw new GatewayError(400, "invalid_request", error.message);
    throw error;
  }
  const stored = storedAppFromRow(row);
  const validation = await validateApp(scope, actor, row, {
    name: stored.name,
    status: stored.status,
    config: stored.config,
  });
  const routing = stored.config.routing;
  const { providers } = await listProviders(scope, actor);
  const named = providers.filter((provider) => providerPolicyFor(routing, provider.slug) !== undefined);
  return {
    appId: stored.id,
    validation,
    status: stored.status,
    providers: named.map(({ id, slug, status }) => ({ id, slug, status })),
    ready: stored.status === "active" && reachableProviders(routing, named).length > 0,
    limitations: [...APP_CHECK_LIMITATIONS],
  };
}
