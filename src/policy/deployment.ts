import type { BillingRuntime } from "../billing/contract";
import { GatewayError } from "../core/errors";
import { log } from "../core/log";
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
  /**
   * The base URL application clients call: the separate API host a deployment
   * publishes with `PUBLIC_API_URL`, or else its console origin. The same
   * value as `identity().apiUrl`, without needing `DEPLOYMENT_ID` — an example
   * request is worth writing on a deployment no CLI has been pointed at yet.
   */
  apiUrl(): string;
  /**
   * The origin the console is served from: `CLI_CONSOLE_ORIGIN`, or else the
   * request's own. The same value as `identity().consoleOrigin`, without
   * needing `DEPLOYMENT_ID`, for a surface that has to know which host is the
   * console's but has no use for the deployment's name.
   */
  consoleOrigin(): string;
  /** How the MCP endpoint on the console host treats browsers. */
  readonly mcp: {
    /**
     * Browser origins besides the console's own that may call `/mcp`, from
     * `MCP_ALLOWED_ORIGINS`. Empty unless the deployment lists some.
     */
    readonly allowedOrigins: readonly string[];
  };
}

/** The subset the pure policy helpers below decide on. */
export type DeploymentPolicy = Pick<Deployment, "rules" | "additionalRegistrations">;

function resolveIdentity(env: Env, requestUrl: string | undefined): DeploymentIdentity {
  const id = env.DEPLOYMENT_ID;
  if (!id) {
    throw new GatewayError(503, "invalid_request", "Deployment identity is not configured");
  }
  return { id, ...resolveOrigins(env, requestUrl) };
}

/** Where the console is served and where application clients call, validated. */
function resolveOrigins(
  env: Env,
  requestUrl: string | undefined,
): Omit<DeploymentIdentity, "id"> {
  const configured = env.CLI_CONSOLE_ORIGIN ?? requestUrl;
  if (!configured) {
    throw new GatewayError(503, "invalid_request", "Configure a secure console origin");
  }
  const configuredOrigin = new URL(configured);
  if (!secureOrigin(configuredOrigin)) {
    throw new GatewayError(503, "invalid_request", "Configure a secure console origin");
  }
  const consoleOrigin = configuredOrigin.origin;
  return { consoleOrigin, apiUrl: env.PUBLIC_API_URL ?? consoleOrigin };
}

/** HTTPS, or plain HTTP on a loopback host for local development; never with credentials. */
function secureOrigin(url: URL): boolean {
  const loopback =
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    url.hostname === "127.0.0.1";
  return (url.protocol === "https:" || (url.protocol === "http:" && loopback))
    && !url.username
    && !url.password;
}

/** The last `MCP_ALLOWED_ORIGINS` value parsed, so an isolate parses and warns about one value once. */
let parsedMcpOrigins: { raw: string; origins: readonly string[] } | undefined;

/**
 * `MCP_ALLOWED_ORIGINS` as the exact origins a browser sends: comma-separated,
 * each an `https` origin (or `http` on a loopback host) with no wildcard, path,
 * query or credentials, normalised as a browser writes one — lower case, no
 * default port, no trailing slash. An entry that is not one is dropped with a
 * warning giving its position and why, rather than refusing every request over
 * a typo in one of them. The warning never repeats the entry itself: one that
 * does not parse may still carry credentials nobody can strip from it.
 */
function mcpAllowedOrigins(raw: string | undefined): readonly string[] {
  const value = raw?.trim() ?? "";
  if (value === "") return [];
  if (parsedMcpOrigins?.raw === value) return parsedMcpOrigins.origins;
  const origins: string[] = [];
  const entries = value.split(",").map((part) => part.trim()).filter(Boolean);
  for (const [index, entry] of entries.entries()) {
    let url: URL | undefined;
    try {
      url = new URL(entry);
    } catch {
      url = undefined;
    }
    // A browser sends one exact origin, so an entry is matched exactly too: a
    // wildcard host would match nothing, and is refused rather than kept as
    // a rule that looks broader than it is.
    const bare = url !== undefined
      && secureOrigin(url)
      && !url.hostname.includes("*")
      && url.pathname === "/"
      && !url.search
      && !url.hash;
    if (!url || !bare) {
      log("warn", "mcp_allowed_origin_ignored", {
        // 1-based, as a person counts the entries of the list they wrote.
        position: index + 1,
        reason: url === undefined
          ? "not a URL"
          : "not an exact https origin (http only on a loopback host) without a wildcard, path, query or credentials",
      });
      continue;
    }
    if (!origins.includes(url.origin)) origins.push(url.origin);
  }
  parsedMcpOrigins = { raw: value, origins };
  return origins;
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
  let origins: Omit<DeploymentIdentity, "id"> | undefined;
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
    apiUrl(): string {
      origins ??= resolveOrigins(env, requestUrl);
      return origins.apiUrl;
    },
    consoleOrigin(): string {
      origins ??= resolveOrigins(env, requestUrl);
      return origins.consoleOrigin;
    },
    mcp: { allowedOrigins: mcpAllowedOrigins(env.MCP_ALLOWED_ORIGINS) },
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
  /**
   * Whether the account is this token's own — derived from the token, so no
   * other caller can hold it — rather than the one account the deployment has.
   */
  accountPerToken: boolean;
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
    accountPerToken: bootstrap.accountId === "hashed",
  };
}
