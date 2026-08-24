import {
  createCfAuth,
  type CfAuth,
  type CfAuthError,
  isCfAuthError,
} from "@maxceem/cf-auth";
import { operatorAuthTables } from "../db/schema";
import { GatewayError, type ErrorCode } from "../core/errors";

export const OPERATOR_AUTH_BASE_PATH = "/v1/auth";
export const MANAGEMENT_KEY_PREFIX = "agw_mgmt_";
export const CONSOLE_REQUEST_HEADER = "x-console-request";

export function registrationOpen(env: Env): boolean {
  return env.ALLOW_PUBLIC_REGISTRATION?.trim().toLowerCase() !== "false";
}

export function googleAuthEnabled(env: Env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID?.trim() && env.GOOGLE_CLIENT_SECRET?.trim());
}

export function createOperatorAuth(env: Env, requestUrl: string): CfAuth {
  const origin = new URL(requestUrl).origin;
  return createCfAuth({
    appName: "App AI Gateway",
    d1: env.DB,
    tables: operatorAuthTables,
    secret: env.BETTER_AUTH_SECRET,
    baseUrl: origin,
    basePath: OPERATOR_AUTH_BASE_PATH,
    trustedOrigins: [origin],
    disableSignUp: !registrationOpen(env),
    emailAndPassword: { enabled: true },
    organizations: { autoProvisionDefaultOrganization: true },
    apiKeys: { enabled: true, tokenPrefix: MANAGEMENT_KEY_PREFIX },
    cookies: { prefix: "agw_operator" },
    ...(googleAuthEnabled(env)
      ? {
          google: {
            clientId: env.GOOGLE_CLIENT_ID!,
            clientSecret: env.GOOGLE_CLIENT_SECRET!,
            disableSignUp: !registrationOpen(env),
          },
        }
      : {}),
  });
}

export function asGatewayAuthError(error: CfAuthError): GatewayError {
  const mappedCodes: Record<string, ErrorCode> = {
    unauthorized: "auth_required",
    forbidden: "forbidden",
    session_required: "session_required",
    validation_error: "validation_error",
    conflict: "conflict",
    not_found: "not_found",
    not_a_member: "not_a_member",
    last_owner: "last_owner",
  };
  const code = mappedCodes[error.code] ?? "invalid_request";
  return new GatewayError(error.status, code, error.message);
}

export function rethrowCfAuthError(error: unknown): never {
  if (isCfAuthError(error)) throw asGatewayAuthError(error);
  throw error;
}
