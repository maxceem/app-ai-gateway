/**
 * The configuration vocabulary, the helpers that read a parsed configuration,
 * and the one function that turns raw JSON into one.
 *
 * There is no parser here. `src/contracts/schemas.ts` is the grammar — the
 * same schema the public API documents — and what it produces is what the
 * gateway stores and what every reader works on. This module is the door to it:
 * one place that runs it and reports a rejection the same way for the Worker,
 * the console and the CLI.
 *
 * It imports the schema at runtime, so the console bundle carries zod. That is
 * deliberate: a second parser in the browser could disagree with the server,
 * and one parser that ships everywhere cannot.
 */

import {
  AppConfigSchema,
  AppleAppIdentitySchema,
  AppWriteSchema,
  type AppConfig,
  type AppWrite,
  type LimitScopeConfig,
} from "../contracts/schemas.ts";
import { schemaIssueMessage } from "./schema-issues.ts";

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
  EndUserSource,
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
  scopeHasLimits,
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
 * Raw JSON as a configuration, or a {@link ConfigError} naming the first field
 * at fault. Stored rows, request bodies and console drafts all come through
 * here, which is what makes "what is stored" and "what is accepted" one answer.
 */
export function parseAppConfig(raw: unknown): AppConfig {
  const parsed = AppConfigSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw new ConfigError(schemaIssueMessage(parsed.error));
}

/**
 * Why an Apple team and bundle id would be refused, or null when they would
 * not. The stored configuration's own rules, so a form that is not yet a whole
 * configuration can still be told exactly what the save would say.
 */
export function appleIdentityProblem(identity: { team_id: string; bundle_id: string }): string | null {
  const parsed = AppleAppIdentitySchema.safeParse(identity);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? "Invalid Apple app identity");
}

/**
 * An application write — name, configuration and status — as the API accepts
 * it, or a {@link ConfigError} naming the first field at fault. For a client
 * that wants to know before it sends whether the gateway would take the write.
 */
export function parseAppWrite(raw: unknown): AppWrite {
  const parsed = AppWriteSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw new ConfigError(schemaIssueMessage(parsed.error));
}

/** One reason a configuration would be refused, and the field it is about. */
export interface ConfigIssue {
  path: readonly PropertyKey[];
  message: string;
}

/**
 * Every reason the schema would refuse a configuration, each with its path.
 *
 * For a form that is filled in a section at a time: it asks about the fields
 * under one path and ignores the sections the person has not reached yet,
 * rather than holding one step hostage to another's empty field.
 */
export function appConfigIssues(raw: unknown): ConfigIssue[] {
  const parsed = AppConfigSchema.safeParse(raw);
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message }));
}

/** Whether `path` is `prefix` or lies under it. */
export function issueUnder(issue: ConfigIssue, prefix: readonly PropertyKey[]): boolean {
  return prefix.every((segment, index) => issue.path[index] === segment);
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

/**
 * The policy an application applies to one provider instance, or undefined
 * when it may not reach that instance at all. All-mode reaches every instance
 * under the default policy — an unrestricted one — and selected-mode only the
 * slugs it names.
 */
export function providerPolicyFor(routing: RoutingConfig, slug: string): ProviderPolicy | undefined {
  if (routing.providers.mode === "all") return { allowed_paths: [], allowed_models: [] };
  return Object.hasOwn(routing.providers.selected, slug) ? routing.providers.selected[slug] : undefined;
}

/**
 * The instances an application can send to right now: the ones its routing
 * allows, and of those the ones that are active, since a disabled instance
 * serves nothing. The one answer the console's example, the CLI's
 * `app check` and `app snippet` all give.
 */
export function reachableProviders<Instance extends { slug: string; status: string }>(
  routing: RoutingConfig,
  instances: readonly Instance[],
): Instance[] {
  return instances.filter(
    (instance) => instance.status === "active" && providerPolicyFor(routing, instance.slug) !== undefined,
  );
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
