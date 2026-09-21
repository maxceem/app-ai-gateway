/**
 * The configuration vocabulary, the helpers that read a parsed configuration,
 * and the one function that turns raw JSON into one.
 *
 * There is no parser here any more. `src/contracts/schemas.ts` is the grammar —
 * the same schema the public API documents — and what it produces is what the
 * gateway stores and what every reader works on. This module is the door to it:
 * one place that runs it and reports a rejection the same way for the Worker,
 * the console and the CLI.
 *
 * It imports the schema at runtime, so the console bundle carries zod. That is
 * deliberate: a second hand-written parser in the browser was the thing that
 * could disagree with the server, and one parser that ships everywhere cannot.
 */

import type { z } from "zod";
import { AppConfigSchema, type AppConfig, type LimitScopeConfig } from "../contracts/schemas.ts";

export {
  APP_ATTEST_ENVIRONMENTS,
  DEFAULT_END_USER_HEADER,
  ENDPOINT_SLUG,
  ENTITLEMENT_CHECKS,
  HTTP_FIELD_NAME,
  ISSUER_PROVIDERS,
  PROVIDER_SLUG_PATTERN,
  identifiesEndUsers,
  scopeHasLimits,
} from "../contracts/schemas.ts";

export type {
  ApiKeyAuthentication,
  ApiKeyEndUser,
  AppAttestEndUser,
  AppAttestEnvironment,
  AppConfig,
  AppConfigInput,
  AppleAppAttestAuthentication,
  AuthenticationConfig,
  AuthenticationConfigInput,
  ClaimRequirement,
  EndpointConfig,
  EndpointsConfig,
  EntitlementCheck,
  IssuerAuthentication,
  IssuerAuthenticationInput,
  IssuerProvider,
  LimitScopeConfig,
  LimitsConfig,
  ProviderPolicy,
  RoutingConfig,
} from "../contracts/schemas.ts";

import {
  APP_ID_IS_SERVER_ASSIGNED,
  scopeHasLimits,
  type AuthenticationConfig,
  type IssuerAuthentication,
  type ProviderPolicy,
  type RoutingConfig,
} from "../contracts/schemas.ts";

/** A configuration that does not parse, named so callers can answer for it. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * The one way a schema rejection is worded, wherever one is reported.
 *
 * The first issue only: a configuration is repaired one field at a time, and a
 * list of every consequence of a single missing key is noise in an error
 * message. The path comes first because it is what the reader has to find.
 */
export function configErrorFor(error: z.ZodError<unknown>): ConfigError {
  const issue = error.issues[0];
  if (issue === undefined) return new ConfigError("Invalid application configuration");
  // The one rejection a client is likely to hit while catching up with the
  // contract, and "unrecognized key" would not tell it what to do instead.
  if (issue.code === "unrecognized_keys" && issue.keys.includes("id")) {
    return new ConfigError(APP_ID_IS_SERVER_ASSIGNED);
  }
  return new ConfigError(`${issue.path.join(".") || "body"}: ${issue.message}`);
}

/**
 * Raw JSON as a configuration, or a {@link ConfigError} naming the first field
 * at fault. Stored rows, request bodies and console drafts all come through
 * here, which is what makes "what is stored" and "what is accepted" one answer.
 */
export function parseAppConfig(raw: unknown): AppConfig {
  const parsed = AppConfigSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw configErrorFor(parsed.error);
}

/** The issuer that identifies this application's end users, if one does. */
export function endUserIssuer(
  authentication: AuthenticationConfig,
): IssuerAuthentication | undefined {
  return authentication.end_user?.source === "issuer" ? authentication.end_user.issuer : undefined;
}

/** The header this application reads its end-user id from, if it reads one. */
export function endUserHeader(authentication: AuthenticationConfig): string | undefined {
  return authentication.type === "api_key" && authentication.end_user?.source === "header"
    ? authentication.end_user.header
    : undefined;
}

/**
 * The per-instance policies an application allows, keyed by provider slug.
 *
 * All-mode names none: it allows every instance the organization holds, under
 * the default policy, so there is nothing per-slug to look up. This is the one
 * reader of `routing.providers`' discriminant, which is what it replaced — a
 * `providerMode` field every caller had to remember to check first.
 */
export function selectedProviderPolicies(routing: RoutingConfig): Record<string, ProviderPolicy> {
  return routing.providers.mode === "selected" ? routing.providers.selected : {};
}

/** A scope's monthly budget in whole microdollars, which is what the limiter counts in. */
export function monthlyBudgetMicrousd(scope: LimitScopeConfig): number | null {
  return scope.spending.monthly_usd === null
    ? null
    : Math.round(scope.spending.monthly_usd * 1_000_000);
}

export const hasUserLevelLimits = (config: AppConfig): boolean =>
  scopeHasLimits(config.limits.per_user);

export const hasAppLevelLimits = (config: AppConfig): boolean =>
  scopeHasLimits(config.limits.per_app);
