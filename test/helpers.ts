import { env } from "cloudflare:workers";
import { issueGatewayToken } from "../src/core/jwt";
import { hashApiKey } from "../src/core/apikeys";
import {
  clearProviderCaches,
  encryptionContext,
  gatewayEncryptionContext,
} from "../src/core/provider-store";
import { PROVIDER_TYPES } from "../src/core/providers";
import { database } from "../src/db";
import {
  app,
  appApiKey,
  provider,
  providerGateway,
  type CfAigConfig,
  type ProviderPricing,
} from "../src/db/schema";
import type { ProviderType, StoredAppConfig } from "../src/core/types";
import { secretVault } from "../src/vault";

export const TEST_ORGANIZATION_ID = "operator-test-organization";
export const TEST_OPERATOR_USER_ID = "operator-test-owner";

/** One recognisable plaintext per provider so header assertions read clearly. */
export function testProviderSecret(type: ProviderType): string {
  return `test-${type}-secret`;
}

/**
 * Inserts a provider row with a real vault blob, so the hot path exercises the
 * same encrypt/decrypt round trip production uses.
 */
export async function seedProvider(input: {
  type: ProviderType;
  id?: string;
  slug?: string;
  organizationId?: string;
  secret?: string;
  name?: string;
  gateway?: "cf_aig";
  gatewayConfig?: CfAigConfig;
  providerGatewayId?: string;
  pricing?: ProviderPricing;
  status?: "active" | "revoked";
}): Promise<string> {
  const organizationId = input.organizationId ?? TEST_ORGANIZATION_ID;
  const id = input.id ?? `provider_${organizationId}_${input.type}`;
  const slug = input.slug ?? input.type;
  const secret = input.secret ?? testProviderSecret(input.type);
  let providerGatewayId = input.providerGatewayId ?? null;
  if (input.gateway === "cf_aig") {
    providerGatewayId = providerGatewayId ?? `gateway_${organizationId}_${slug}`;
    const config = input.gatewayConfig ?? { accountId: "test-account", gatewayId: "test-gateway" };
    await database(env.DB).insert(providerGateway).values({
      id: providerGatewayId,
      organizationId,
      type: "cf_aig",
      name: `Test gateway for ${slug}`,
      config,
      secretBlob: await secretVault(env).encryptSecret(
        secret,
        gatewayEncryptionContext(organizationId, providerGatewayId),
      ),
      secretHint: secret.slice(-4),
      createdBy: TEST_OPERATOR_USER_ID,
    }).onConflictDoNothing();
  }
  await database(env.DB).insert(provider).values({
    id,
    organizationId,
    type: input.type,
    slug,
    name: input.name ?? `Test ${input.type}`,
    secretBlob: providerGatewayId === null
      ? await secretVault(env).encryptSecret(secret, encryptionContext(organizationId, id))
      : null,
    secretHint: providerGatewayId === null ? secret.slice(-4) : null,
    providerGatewayId,
    pricing: input.pricing ?? null,
    status: input.status ?? "active",
    createdBy: TEST_OPERATOR_USER_ID,
  });
  clearProviderCaches();
  return id;
}

/** The default fixture: every provider configured, all routed natively. */
export async function seedAllProviders(organizationId = TEST_ORGANIZATION_ID): Promise<void> {
  for (const type of PROVIDER_TYPES) await seedProvider({ type, organizationId });
}

export interface SeedOptions {
  organizationId?: string;
  proxy?: Record<string, unknown>;
  auth?: Record<string, unknown>;
  limits?: { rpm: number; rpd: number; app_rpm?: number; app_rpd?: number };
  budgetUsd?: number | null;
  appBudgetUsd?: number | null;
  endpoints?: Record<string, unknown>;
}

export function routingConfig(proxy: Record<string, unknown>): Record<string, unknown> {
  if (proxy.providers !== undefined) return proxy;
  const { provider_mode: mode, model_rewrites, ...selected } = proxy;
  const providerMode = mode ?? (Object.keys(selected).length === 0 ? "all" : "selected");
  return {
    providers: providerMode === "all"
      ? { mode: "all" }
      : { mode: "selected", selected },
    model_rewrites: model_rewrites ?? {},
  };
}

export function serverConfig(input: {
  proxy?: Record<string, unknown>;
  limits?: { rpm?: number | null; rpd?: number | null; app_rpm?: number | null; app_rpd?: number | null };
  budgetUsd?: number | null;
  appBudgetUsd?: number | null;
  authentication?: Record<string, unknown>;
  endpoints?: Record<string, unknown>;
} = {}): Record<string, unknown> {
  return {
    ...(input.endpoints === undefined ? {} : { endpoints: input.endpoints }),
    authentication: input.authentication ?? {
      type: "api_key",
      end_user: { header: "x-end-user-id", required: false, fallback: "api_key" },
    },
    routing: routingConfig(input.proxy ?? {}),
    limits: {
      per_user: {
        requests: { per_minute: input.limits?.rpm ?? null, per_day: input.limits?.rpd ?? null },
        spending: { monthly_usd: input.budgetUsd ?? null },
      },
      per_app: {
        requests: { per_minute: input.limits?.app_rpm ?? null, per_day: input.limits?.app_rpd ?? null },
        spending: { monthly_usd: input.appBudgetUsd ?? null },
      },
    },
  };
}

export function appleConfig(
  issuer: Record<string, unknown>,
  input: { proxy?: Record<string, unknown> } = {},
): Record<string, unknown> {
  return {
    authentication: {
      type: "apple_app_attest",
      issuer: {
        user_id_claim: "sub",
        required_claims: [],
        max_token_lifetime_seconds: 3600,
        ...issuer,
      },
      app_attest: {
        team_id: "AAAAAAAAAA",
        bundle_id: "com.example.test",
      },
    },
    routing: routingConfig(input.proxy ?? {}),
    limits: {
      per_user: { requests: { per_minute: 10, per_day: 300 }, spending: { monthly_usd: null } },
      per_app: { requests: { per_minute: null, per_day: null }, spending: { monthly_usd: null } },
    },
  };
}

function limitsConfig(options: SeedOptions): Record<string, unknown> {
  const limits = options.limits ?? { rpm: 100, rpd: 1000 };
  return {
    per_user: {
      requests: { per_minute: limits.rpm, per_day: limits.rpd },
      spending: { monthly_usd: options.budgetUsd === undefined ? 100 : options.budgetUsd },
    },
    per_app: {
      requests: { per_minute: limits.app_rpm ?? null, per_day: limits.app_rpd ?? null },
      spending: { monthly_usd: options.appBudgetUsd ?? null },
    },
  };
}

export function defaultProxyConfig(): Record<string, unknown> {
  return {
    openai: {
      allowed_paths: ["v1/responses", "v1/audio/transcriptions"],
      allowed_models: ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-4o-mini-transcribe"],
      max_output_tokens: 128,
    },
    anthropic: {
      allowed_paths: ["v1/messages"],
      allowed_models: ["claude-sonnet-5"],
      max_output_tokens: 128,
    },
    xai: {
      allowed_paths: ["v1/responses", { path: "v1/stt", fixed_model: "grok-transcribe" }],
      allowed_models: ["grok-4.5", "grok-transcribe"],
      max_output_tokens: 128,
    },
    gemini: {
      allowed_paths: [
        "v1beta/models/{model}:generateContent",
        "v1beta/models/{model}:streamGenerateContent",
        "v1beta/openai/chat/completions",
      ],
      allowed_models: ["gemini-3.5-flash"],
      max_output_tokens: 128,
    },
    model_rewrites: { "gpt-5.6-terra": "gpt-5.6", "gemini-3.5-flash": "gemini-3.6-flash" },
  };
}

export async function seedApp(appId: string, options: SeedOptions = {}): Promise<void> {
  const issuer = options.auth ?? {};
  await database(env.DB).insert(app).values({
    id: appId,
    organizationId: options.organizationId === undefined
      ? TEST_ORGANIZATION_ID
      : options.organizationId,
    name: `Test ${appId}`,
    config: {
      authentication: {
        type: "apple_app_attest",
        issuer: {
          jwks_url: issuer.jwks_url ?? "https://issuer.test/.well-known/jwks.json",
          user_id_claim: issuer.user_id_claim ?? "sub",
          ...(issuer.token_header === undefined ? {} : { token_header: issuer.token_header }),
          required_claims: issuer.required_claims ?? [],
          max_token_lifetime_seconds: issuer.max_token_lifetime_seconds ?? 3600,
        },
        app_attest: {
          team_id: "AAAAAAAAAA",
          bundle_id: `com.example.${appId}`,
        },
      },
      routing: routingConfig(options.proxy ?? defaultProxyConfig()),
      limits: limitsConfig(options),
      ...(options.endpoints === undefined ? {} : { endpoints: options.endpoints }),
    } as unknown as StoredAppConfig,
    status: "active",
  });
}

export async function seedServerApp(
  appId: string,
  options: SeedOptions & { key?: string; issuer?: Record<string, unknown> } = {},
): Promise<string> {
  const suffix = `${appId.replace(/[^0-9A-Za-z]/gu, "")}0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz`;
  const key = options.key ?? `agw_${suffix.padEnd(48, "A").slice(0, 48)}`;
  await database(env.DB).insert(app).values({
    id: appId,
    organizationId: options.organizationId === undefined
      ? TEST_ORGANIZATION_ID
      : options.organizationId,
    name: `Test ${appId}`,
    config: {
      authentication: {
        type: "api_key",
        ...(options.issuer === undefined ? {} : {
          issuer: {
            jwks_url: options.issuer.jwks_url ?? "https://issuer.test/.well-known/jwks.json",
            user_id_claim: options.issuer.user_id_claim ?? "sub",
            ...(options.issuer.token_header === undefined ? {} : { token_header: options.issuer.token_header }),
            required_claims: options.issuer.required_claims ?? [],
            max_token_lifetime_seconds: options.issuer.max_token_lifetime_seconds ?? 3600,
          },
        }),
        end_user: { header: "x-end-user-id", required: false, fallback: "api_key" },
      },
      routing: routingConfig(options.proxy ?? defaultProxyConfig()),
      limits: limitsConfig(options),
      ...(options.endpoints === undefined ? {} : { endpoints: options.endpoints }),
    } as unknown as StoredAppConfig,
    status: "active",
  });
  await database(env.DB).insert(appApiKey).values({
    id: `key_${appId}`,
    appId,
    name: "Test server key",
    keyHash: await hashApiKey(key),
    keyPrefix: key.slice(0, 12),
  });
  return key;
}

export async function gatewayToken(appId: string, userId = "user-1"): Promise<string> {
  const issued = await issueGatewayToken(env.JWT_SECRET, appId, userId, "attest", 3600);
  return issued.token;
}
