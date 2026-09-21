import type { BillingRuntime } from "../billing/contract";
import { GatewayError } from "../core/errors";
import { ACCOUNT_RECOVERY_MS } from "./accounts";

export type DeploymentMode = "cloud" | "self_hosted";

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
  readonly mode: DeploymentMode;
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
export type DeploymentPolicy = Pick<Deployment, "mode" | "additionalRegistrations">;

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
  let identity: DeploymentIdentity | undefined;
  return {
    mode: billing ? "cloud" : "self_hosted",
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
  if (policy.mode === "cloud") {
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
    (policy.mode === "cloud" || options.provisionRegistration)
  );
}

export interface BootstrapDecision {
  accountId: string;
  userId: string;
  createdAt: string;
  recoveryEndsAt: string | null;
  receiptExpiresAt: number;
  requiresEmptyDeployment: boolean;
  rateLimited: boolean;
}

/** All mode-sensitive bootstrap values are chosen together from one policy snapshot. */
export function bootstrapDecision(
  policy: DeploymentPolicy,
  input: { deploymentId: string; requestHash: string; nowMs: number },
): BootstrapDecision {
  const cloud = policy.mode === "cloud";
  const recoveryEndsAt = !cloud
    ? null
    : new Date(input.nowMs + ACCOUNT_RECOVERY_MS).toISOString();
  const accountId = cloud
    ? `account-${input.requestHash}`
    : `private-${input.deploymentId}`;
  return {
    accountId,
    userId: `service-${accountId}`,
    createdAt: new Date(input.nowMs).toISOString(),
    recoveryEndsAt,
    receiptExpiresAt:
      !cloud
        ? 8_640_000_000_000_000
        : input.nowMs + ACCOUNT_RECOVERY_MS,
    requiresEmptyDeployment: !cloud,
    rateLimited: cloud,
  };
}
