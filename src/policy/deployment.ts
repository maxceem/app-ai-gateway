import { ACCOUNT_RECOVERY_MS } from "./accounts";

export type DeploymentMode = "cloud" | "self_hosted";

export interface DeploymentEnvironment {
  BILLING?: unknown;
  ALLOW_ADDITIONAL_REGISTRATIONS?: string;
}

export interface RegistrationRule {
  allowWhenHumanExists: boolean;
  allowWhenNoHumanWithAccount: boolean;
}

export interface DeploymentPolicy {
  readonly mode: DeploymentMode;
  readonly additionalRegistrations: boolean;
}

/** Product mode is derived only from the service binding already used by the deployment. */
export function deploymentPolicy(env: DeploymentEnvironment): DeploymentPolicy {
  const cloud = Boolean(env.BILLING);
  return {
    mode: cloud ? "cloud" : "self_hosted",
    additionalRegistrations:
      env.ALLOW_ADDITIONAL_REGISTRATIONS?.trim().toLowerCase() === "true",
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
