/**
 * The product's answers for an application that has not been configured yet.
 *
 * The schema in `src/contracts/schemas.ts` says what a configuration *may* be;
 * this module says what a new one *is* — the numbers a mobile app starts rate
 * limited at, the policy a freshly selected provider opens with, what "no
 * limit" looks like written out in full. They are product decisions rather than
 * grammar, they are the same decisions in the console and in the CLI, and they
 * were written out as literals in four places before this file existed.
 *
 * Everything it hands out is freshly built on every call. Nothing here is a
 * constant, because a default's callers edit what they are given.
 *
 * It lives under `src/shared` because both clients import it, so it may reach
 * into `src/contracts` and nowhere else. Everything it imports is a type, so
 * nothing of the grammar is pulled into a bundle by depending on it.
 */

import type {
  AppAttestEnvironment,
  AppConfigInput,
  AuthenticationConfigInput,
  LimitScopeConfig,
  LimitsConfig,
  ProviderPolicy,
} from "./app-config.ts";

/*
 * Every default here is a function returning a new object, nested objects and
 * arrays included, and none of them is also exported as a constant.
 *
 * A default's whole job is to be written into something that is then edited —
 * a draft the console mutates through, a body a caller adds fields to — and a
 * shared constant handed to two of those is one edit away from changing the
 * other. A call costs nothing next to the request it is part of.
 */

/** No limit of any kind, which is what an unwritten scope means. */
export function unlimitedScope(): LimitScopeConfig {
  return {
    requests: { per_minute: null, per_day: null },
    spending: { monthly_usd: null },
  };
}

/**
 * What a mobile application is born rate limited at.
 *
 * A mobile app ships its credential inside the client, where every install is a
 * stranger, so it starts limited rather than open. Both of its end-user sources
 * tell installs apart, so the limit always has someone to apply to.
 *
 * A server application gets no default at all — see {@link newAppConfig}.
 */
export function mobileDefaultLimits(): LimitsConfig {
  return {
    per_user: { requests: { per_minute: 10, per_day: 300 }, spending: { monthly_usd: null } },
    per_app: unlimitedScope(),
  };
}

/**
 * The policy a newly selected provider starts with: unrestricted.
 *
 * Empty, never `["*"]`. Neither field takes a wildcard — `allowed_paths`
 * compiles each entry to an anchored pattern whose only placeholder is
 * `{model}`, and `allowed_models` is matched with `includes`, so a literal
 * `"*"` matches nothing and an empty list is what means "allow everything".
 * A saved `"*"` is also refused outright, because the gateway prices every
 * model an application names and no catalog prices a model called `*`.
 */
export function emptyPolicy(): ProviderPolicy {
  return { allowed_paths: [], allowed_models: [] };
}

type AppAttestAuthentication = Extract<AuthenticationConfigInput, { type: "apple_app_attest" }>;
type ApiKeyAuthentication = Extract<AuthenticationConfigInput, { type: "api_key" }>;

/** How an App Attest application may identify its end users. */
export type AppAttestEndUserInput = AppAttestAuthentication["end_user"];
/** How an `api_key` application may identify its end users, when it has any. */
export type ApiKeyEndUserInput = NonNullable<ApiKeyAuthentication["end_user"]>;

/**
 * What a caller has decided about a new application, which is only ever its
 * type, the identifiers that type needs, and how its users are named.
 *
 * Discriminated rather than one bag of optional fields, so an App Attest pair
 * cannot be left out and a header source cannot be asked for on an application
 * that has no headers to read it from.
 */
export type NewAppInput =
  | {
      type: "apple_app_attest";
      /** The App Attest pair every attestation is verified against. */
      teamId: string;
      bundleId: string;
      /** Omitted to take the schema's own `["production"]`, which is the safe one. */
      environments?: readonly AppAttestEnvironment[];
      /** Omitted means the attested install is the user, which it always can be. */
      endUser?: AppAttestEndUserInput;
    }
  | {
      type: "api_key";
      /**
       * Omitted means the application has no end users at all — a position the
       * configuration states by leaving the block out, not a missing default.
       */
      endUser?: ApiKeyEndUserInput;
    };

/**
 * The configuration a new application is created with.
 *
 * Its two callers are the console's creation wizard
 * (`console/src/pages/new-app-dialog.tsx`) and the CLI's `agw app add`
 * (`cli/src/apps.ts`). They ask different questions — the wizard offers an
 * identity provider and a subscription check, the CLI takes flags — but what
 * they send is the same configuration, and this is the one place it is built.
 *
 * Nothing in the result is shared with another call: a caller is free to add
 * to it, edit it, or hold on to it.
 */
export function newAppConfig(input: NewAppInput): AppConfigInput {
  // Providers are open to begin with: an application that can reach nothing is
  // not a useful starting point, and the proxy policy is its own decision.
  const routing = { providers: { mode: "all" as const }, model_rewrites: {} };
  if (input.type === "api_key") {
    return {
      authentication: {
        type: "api_key",
        ...(input.endUser ? { end_user: input.endUser } : {}),
      },
      routing,
    };
  }
  return {
    authentication: {
      type: "apple_app_attest",
      app_attest: {
        team_id: input.teamId,
        bundle_id: input.bundleId,
        ...(input.environments ? { environments: [...input.environments] } : {}),
      },
      end_user: input.endUser ?? { source: "app_install" },
    },
    routing,
    limits: mobileDefaultLimits(),
  };
}
