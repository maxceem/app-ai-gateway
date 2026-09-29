import type { BillingRuntime } from "../billing/contract";
import { GatewayError } from "../core/errors";
import { ACCOUNT_RECOVERY_MS } from "./accounts";

export type DeploymentMode = "cloud" | "self_hosted";

/** Everything a hosted deployment does differently from a self-hosted one. */
export interface DeploymentRules {
  /**
   * Accounts carry deadlines: a cloud bootstrap writes a recovery deadline,
   * an unclaimed account's free access runs out, and the nightly sweep collects
   * what expired. A self-host's accounts carry none, so nothing checks one.
   */
  readonly accountDeadlines: boolean;
  /** `open` lets anyone register; `restricted` asks `ALLOW_ADDITIONAL_REGISTRATIONS` and the claim flow. */
  readonly registration: "open" | "restricted";
  /** Whether a new registration gets an account of its own always, or only when its flow asks for one. */
  readonly provisionDefaultOrganization: "always" | "when_requested";
  readonly bootstrap: {
    /** `hashed`: one account per CLI token; `deployment`: the one account the deployment has. */
    readonly accountId: "hashed" | "deployment";
    /** Only an empty deployment may be bootstrapped: whoever initializes it first owns it. */
    readonly requiresEmptyDeployment: boolean;
    readonly rateLimited: boolean;
  };
}

/** The one page that says what the hosted deployment does differently. */
const DEPLOYMENT_RULES: Record<DeploymentMode, DeploymentRules> = {
  cloud: {
    accountDeadlines: true,
    registration: "open",
    provisionDefaultOrganization: "always",
    bootstrap: { accountId: "hashed", requiresEmptyDeployment: false, rateLimited: true },
  },
  self_hosted: {
    accountDeadlines: false,
    registration: "restricted",
    provisionDefaultOrganization: "when_requested",
    bootstrap: { accountId: "deployment", requiresEmptyDeployment: true, rateLimited: false },
  },
};

export interface RegistrationRule {
  allowWhenHumanExists: boolean;
  allowWhenNoHumanWithAccount: boolean;
}

/** Who this deployment says it is, to a client that has to address it by name. */
export interface DeploymentIdentity {
  id: string;
  consoleOrigin: string;
  apiUrl: string;
}

/**
 * What kind of deployment is serving this request, decided once.
 *
 * Product mode, the billing service and the registration rule were all derived
 * from `env` wherever they were wanted — eleven places, each spelling out that
 * a `BILLING` binding is what makes a deployment hosted. This is that
 * derivation, done once per request by `requestScope` and read from the context
 * everywhere else; anything without a context takes one of these as an
 * argument rather than reaching for `env` again.
 */
export interface Deployment {
  /** The table key, and the value the CLI is told; decisions read `rules`. */
  readonly mode: DeploymentMode;
  readonly rules: DeploymentRules;
  /** The billing service, or null on a self-hosted deployment. The only source of "is billing present". */
  readonly billing: BillingRuntime | null;
  readonly additionalRegistrations: boolean;
  /**
   * Public identity and console origin, validated and memoized.
   *
   * Lazy because only the CLI surface needs it: a proxied request on a
   * deployment that never configured `DEPLOYMENT_ID` has no use for one and
   * must keep working, so the 503s below are raised where the value is read
   * rather than where the deployment is resolved.
   */
  identity(): DeploymentIdentity;
}

/** The subset the pure policy helpers below decide on. */
export type DeploymentPolicy = Pick<Deployment, "rules" | "additionalRegistrations">;

function resolveIdentity(env: Env, requestUrl: string | undefined): DeploymentIdentity {
  const id = env.DEPLOYMENT_ID;
  if (!id) {
    throw new GatewayError(503, "invalid_request", "Deployment identity is not configured");
  }
  const configured = env.CLI_CONSOLE_ORIGIN ?? requestUrl;
  if (!configured) {
    throw new GatewayError(503, "invalid_request", "Configure a secure console origin");
  }
  const configuredOrigin = new URL(configured);
  const loopback =
    configuredOrigin.hostname === "localhost" ||
    configuredOrigin.hostname.endsWith(".localhost") ||
    configuredOrigin.hostname === "127.0.0.1";
  if (
    (configuredOrigin.protocol !== "https:" &&
      !(configuredOrigin.protocol === "http:" && loopback)) ||
    configuredOrigin.username ||
    configuredOrigin.password
  ) {
    throw new GatewayError(503, "invalid_request", "Configure a secure console origin");
  }
  const consoleOrigin = configuredOrigin.origin;
  return { id, consoleOrigin, apiUrl: env.PUBLIC_API_URL ?? consoleOrigin };
}

/**
 * The one derivation of deployment shape from the environment.
 *
 * Called by `requestScope` for a request and directly by the scheduled
 * maintenance pass, which has no request to scope.
 */
export function resolveDeployment(env: Env, requestUrl?: string): Deployment {
  const billing = env.BILLING ?? null;
  const mode: DeploymentMode = billing ? "cloud" : "self_hosted";
  let identity: DeploymentIdentity | undefined;
  return {
    mode,
    rules: DEPLOYMENT_RULES[mode],
    billing,
    additionalRegistrations:
      env.ALLOW_ADDITIONAL_REGISTRATIONS?.trim().toLowerCase() === "true",
    identity(): DeploymentIdentity {
      identity ??= resolveIdentity(env, requestUrl);
      return identity;
    },
  };
}

/** One rule value drives both the advisory registration read and the atomic insert guard. */
export function registrationRule(
  policy: DeploymentPolicy,
  claimRegistration: boolean,
): RegistrationRule {
  if (policy.rules.registration === "open") {
    return {
      allowWhenHumanExists: true,
      allowWhenNoHumanWithAccount: true,
    };
  }
  return {
    allowWhenHumanExists: policy.additionalRegistrations,
    allowWhenNoHumanWithAccount: claimRegistration,
  };
}

export function registrationAllowed(
  rule: RegistrationRule,
  state: { humanExists: boolean; accountExists: boolean },
): boolean {
  return state.humanExists
    ? rule.allowWhenHumanExists
    : !state.accountExists || rule.allowWhenNoHumanWithAccount;
}

export function registrationUnrestricted(rule: RegistrationRule): boolean {
  return rule.allowWhenHumanExists && rule.allowWhenNoHumanWithAccount;
}

export function shouldProvisionDefaultOrganization(
  policy: DeploymentPolicy,
  options: {
    claimRegistration: boolean;
    suppressDefaultOrganization: boolean;
    provisionRegistration: boolean;
  },
): boolean {
  return (
    !options.claimRegistration &&
    !options.suppressDefaultOrganization &&
    (policy.rules.provisionDefaultOrganization === "always" || options.provisionRegistration)
  );
}

export interface BootstrapDecision {
  accountId: string;
  userId: string;
  createdAt: string;
  recoveryEndsAt: string | null;
  requiresEmptyDeployment: boolean;
  rateLimited: boolean;
}

/** All deployment-sensitive bootstrap values are chosen together from one policy snapshot. */
export function bootstrapDecision(
  policy: DeploymentPolicy,
  input: { deploymentId: string; requestHash: string; nowMs: number },
): BootstrapDecision {
  const { accountDeadlines, bootstrap } = policy.rules;
  const recoveryEndsAt = accountDeadlines
    ? new Date(input.nowMs + ACCOUNT_RECOVERY_MS).toISOString()
    : null;
  const accountId = bootstrap.accountId === "hashed"
    ? `account-${input.requestHash}`
    : `private-${input.deploymentId}`;
  return {
    accountId,
    userId: `service-${accountId}`,
    createdAt: new Date(input.nowMs).toISOString(),
    recoveryEndsAt,
    requiresEmptyDeployment: bootstrap.requiresEmptyDeployment,
    rateLimited: bootstrap.rateLimited,
  };
}
