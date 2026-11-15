import { authenticatedAccess } from "../execution/authenticated-access";
import { admitGeneration, callerLimiter } from "../execution/admission";
import { requireProvider, type ResolvedProvider } from "../providers/provider-store";
import { DIRECT_ROUTE, routeAdapter, type ResolvedRoute } from "../providers/route-adapters";
import { cachedAppUserBlocked } from "../client-auth/user-status";
import { resolveDeployment } from "../policy/deployment";
import { monthlyBudgetMicrousd } from "../shared/app-config";
import { monthlySpendMicrousd, type SpendKey } from "../usage/app-usage-accounting";
import {
  buildUsageEvent,
  markUsageApiKeyUsed,
  persistUsageEventAcknowledged,
  type AttemptAttribution,
} from "../usage/usage-record";
import { GatewayError } from "../core/errors";
import { log } from "../core/log";
import type { AppRecord } from "../core/types";
import { requireRealtimeAllowance } from "./allowance";
import { realtimeCaller } from "./caller";
import { realtimePolicy } from "./policy";
import { requireRealtimeAdmission } from "./releases";
import { prepareRealtime } from "./serve";
import { upstreamRequest } from "./upstream";
import { realtimeTicket, settledEvent } from "./usage";
import {
  REALTIME_BACKEND_CONTRACT,
  type BackendResult,
  type Bootstrap,
  type PreviousGrant,
  type RealtimeBackendCalls,
  type SessionGrant,
} from "./relay/contract";

/**
 * The gateway's answers to a realtime session: authentication, policy,
 * application limits, the account allowance, and usage records, which are the
 * same helpers HTTP requests use.
 *
 * One implementation serves both ways a session runs. The binding entrypoint
 * `RealtimeBackend` forwards each call here for a realtime Worker, and the
 * gateway's own `RealtimeSession` calls it in-process. Either way a refusal
 * comes back as data and an outage as a bare error, so both behave alike.
 */

/**
 * Contract versions this gateway answers. A retained realtime Worker keeps the
 * version it was released with, so add a new one here beside the old, and
 * drop the old only once no retained release declares it.
 */
const SUPPORTED_CONTRACTS: readonly number[] = [REALTIME_BACKEND_CONTRACT];

/** The handshake URL a session was opened on, which revalidation authenticates again. */
function sessionUrl(b: Bootstrap): string {
  const appId = encodeURIComponent(b.appId);
  const providerSlug = encodeURIComponent(b.providerSlug);
  return `https://realtime.internal/v1/apps/${appId}/realtime/${providerSlug}`;
}

/** A refusal as data; anything else as a bare error that keeps only its retry flags. */
async function result<T>(version: number, operation: () => Promise<T>): Promise<BackendResult<T>> {
  try {
    if (!SUPPORTED_CONTRACTS.includes(version)) {
      throw new GatewayError(503, "provider_unavailable", "Incompatible realtime backend");
    }
    return { ok: true, value: await operation() };
  } catch (error) {
    if (!(error instanceof GatewayError)) {
      const sanitized = new Error("Realtime backend unavailable");
      if (error instanceof Error) {
        for (const flag of ["retryable", "overloaded"] as const) {
          if (flag in error && Reflect.get(error, flag) === true) Reflect.set(sanitized, flag, true);
        }
      }
      throw sanitized;
    }
    return {
      ok: false,
      error: {
        status: error.status,
        code: error.code,
        message: error.message,
        headers: Object.fromEntries(new Headers(error.headers)),
        ...(error.data ? { data: error.data } : {}),
      },
    };
  }
}

async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** What the grant's `checks` hold: digests, so the grant never repeats a secret it need not. */
interface GrantChecks {
  authentication: string;
  credential: string;
  /** The gateway build that wrote them. */
  build: string;
}

/** The identity fields that say who a session is. */
const IDENTITY_FIELDS = ["appId", "userId", "credentialType", "apiKeyId", "authMethod", "installId"] as const;

/** The provider's route with this isolate's own adapter, for a usage record. */
function localRoute(route: ResolvedRoute): ResolvedRoute {
  return route.kind === "direct" ? DIRECT_ROUTE : { ...route, adapter: routeAdapter(route.kind) };
}

export function gatewayBackend(env: Env, waitUntil: (promise: Promise<unknown>) => void): RealtimeBackendCalls {
  const limiter = (b: Bootstrap, scope: "user" | "app") =>
    env.USER_LIMITER.getByName(scope === "app" ? b.appId : realtimeCaller(b.identity));

  /** The session's app and provider, authenticated again. */
  async function access(b: Bootstrap, headers: Headers): Promise<{ app: AppRecord; provider: ResolvedProvider }> {
    // The handshake's proof, if the app asks for one, was verified and its
    // counter spent when the session opened; what can change since is the
    // token, the key behind it and the app, and those are checked again.
    const found = await authenticatedAccess({
      env,
      deployment: resolveDeployment(env, b.origin),
      appId: b.appId,
      request: new Request(sessionUrl(b), { headers }),
      body: async () => new Uint8Array(),
      providerSlug: b.providerSlug,
      proofVerified: true,
    });
    // Named fields, so a field a later release adds to identities doesn't
    // make every open session's bootstrap look like someone else.
    const unchanged = found.app.organizationId === b.organizationId
      && IDENTITY_FIELDS.every(field => found.identity[field] === b.identity[field]);
    if (!unchanged) throw new GatewayError(401, "auth_required", "Realtime identity changed");
    if (b.identity.userId !== null && await cachedAppUserBlocked(env.DB, b.appId, b.identity.userId)) {
      throw new GatewayError(403, "auth_required", "User is blocked");
    }
    return { app: found.app, provider: await requireProvider(env, b.organizationId, b.providerSlug) };
  }

  /**
   * What the session may do now. A change it cannot follow while open ends
   * it: different authentication rules, a rotated provider key, another
   * provider or model, or a lower output limit.
   */
  async function grantFor(
    b: Bootstrap,
    app: AppRecord,
    provider: ResolvedProvider,
    previous: PreviousGrant | null,
  ): Promise<SessionGrant> {
    const checks: GrantChecks = {
      authentication: await digest(JSON.stringify(app.config.authentication)),
      credential: await digest(provider.secret),
      build: env.GATEWAY_BUILD_ID ?? "local",
    };
    const before = previous?.checks as Partial<GrantChecks> | undefined;
    // Compared only within one gateway build: a later build may read the same
    // stored rules into a different shape, with a new default, and a deploy
    // must not close every open session for it. The credential and identity
    // checks above still hold across builds.
    if (before && before.build === checks.build && before.authentication !== checks.authentication) {
      throw new GatewayError(401, "auth_required", "Realtime authentication policy changed; reconnect");
    }
    if (before && before.credential !== checks.credential) {
      throw new GatewayError(403, "provider_not_configured", "Realtime provider credential changed; reconnect");
    }
    if (provider.id !== b.providerId) {
      throw new GatewayError(403, "provider_not_configured", "Realtime provider identity changed");
    }
    const policy = realtimePolicy(app, provider, b.requestedModel);
    if (policy.model !== b.model || policy.protocol !== b.protocol) {
      throw new GatewayError(403, "model_not_allowed", "Realtime model policy changed");
    }
    if (previous && policy.outputCap < previous.outputCap) {
      throw new GatewayError(403, "max_output_tokens_exceeded", "Realtime output policy changed; reconnect");
    }
    const upstream = upstreamRequest(policy.protocol, policy.model, provider.secret, provider.route, {
      appId: b.appId,
      userId: b.identity.userId,
    });
    return {
      upstream: { url: upstream.url, headers: Object.fromEntries(upstream.headers) },
      protocol: policy.protocol,
      model: policy.model,
      outputCap: policy.outputCap,
      maxSessionSeconds: app.config.realtime.max_session_seconds,
      maxSessionsPerIdentity: app.config.realtime.max_concurrent_sessions_per_identity,
      maxSessions: app.config.realtime.max_concurrent_sessions,
      waitForProvider: provider.route.kind !== "direct",
      checks: { ...checks },
    };
  }

  return {
    prepare: (version, releaseId, request, appId, provider, origin) => result(version, async () => {
      await requireRealtimeAdmission(env.DB, releaseId);
      return prepareRealtime(env, request, appId, provider, origin, "realtime_connect", waitUntil);
    }),

    grant: (version, b, headers, previous) => result(version, async () => {
      const { app, provider } = await access(b, headers);
      return grantFor(b, app, provider, previous);
    }),

    capacity: (version, b, scope, operation, cap) => result(version, async () => {
      const stub = limiter(b, scope);
      if (operation === "release") {
        await stub.releaseSession(b.sessionId);
        return { allowed: true, expiresAt: 0 };
      }
      return operation === "renew" ? stub.renewSession(b.sessionId) : stub.acquireSession(b.sessionId, cap!);
    }),

    admit: (version, b, headers, previous, generationId, at, acknowledgement) => result(version, async () => {
      const { app, provider } = await access(b, headers);
      const grant = await grantFor(b, app, provider, previous);
      const policy = realtimePolicy(app, provider, b.requestedModel);
      const attribution: AttemptAttribution = {
        provider: provider.type,
        providerId: provider.id,
        providerSlug: provider.slug,
        providerRoute: localRoute(provider.route),
        pricing: provider.pricing,
        model: policy.model,
        apiStyle: "other",
        route: `${provider.slug}/${policy.path}`,
        passthrough: false,
      };
      // The usage record's metadata, written now and completed when the
      // response settles: recovery can then record it without the provider.
      const ticket = realtimeTicket({
        price: policy.price,
        event: buildUsageEvent({
          organizationId: app.organizationId,
          identity: b.identity,
          attribution,
          appVersion: b.appVersion,
          status: "ok",
          latencyMs: 0,
          contentType: "application/json",
          observed: null,
          eventId: generationId,
          createdAt: new Date(at).toISOString(),
          realtime: {
            sessionId: b.sessionId,
            generationId,
            protocol: b.protocol,
            providerResponseId: null,
            completionStatus: "interrupted",
          },
        }),
      });
      await admitGeneration({
        env,
        deployment: resolveDeployment(env, b.origin),
        billingCache: new Map(),
        app,
        identity: b.identity,
        assertionCounter: null,
        attribution,
        endpointSlug: null,
        appVersion: b.appVersion,
        admissionId: generationId,
        now: at,
        freshSpend: true,
        // The session stores the claim and the ticket before the claim is spent.
        beforeClaim: claim => acknowledgement.acknowledge(claim as unknown as Record<string, unknown> | null, ticket),
        mayContinue: () => true,
        waitUntil,
      });
      return grant;
    }),

    receipt: (version, b, generationId) => result(version, async () =>
      env.ORG_QUOTA.getByName(b.organizationId).receipt(generationId)),

    settle: (version, b, settlement) => result(version, async () => {
      const event = settledEvent(b, settlement);
      if (event.row.costSource === "unresolved") {
        // Recorded at no cost and the conversation goes on, as an HTTP request
        // would; this line is the operator's signal, as it is for HTTP.
        log("error", "usage_unresolved_cost", {
          eventId: event.eventId,
          appId: b.appId,
          userId: b.identity.userId,
          provider: event.row.providerType,
          model: event.row.model,
          sessionId: b.sessionId,
          reason: settlement.usage === null
            ? settlement.aborted ? "client_aborted" : "no_usage_reported"
            : "unreadable_usage",
        });
      }
      if (await persistUsageEventAcknowledged(env, event) === "stored") waitUntil(markUsageApiKeyUsed(env, event));
    }),

    maintain: (version, b, headers, previous, active) => result(version, async () => {
      const { app, provider } = await access(b, headers);
      const grant = await grantFor(b, app, provider, previous);
      await requireRealtimeAllowance(env, resolveDeployment(env, b.origin), b.organizationId, waitUntil, !active);
      if (active) return grant;
      // The same budgets admission refuses a generation by, each measured over
      // the month its scope is: the app's, and the caller's install or user.
      const month = new Date().toISOString().slice(0, 7);
      const budgets: { scope: string; budget: number | null; spend: SpendKey }[] = [
        {
          scope: "app",
          budget: monthlyBudgetMicrousd(app.config.limits.per_app),
          spend: { appId: b.appId, scope: "app", key: null },
        },
      ];
      const caller = callerLimiter(app, b.identity, null);
      if (caller) {
        budgets.push({
          scope: caller.spend.scope,
          budget: monthlyBudgetMicrousd(app.config.limits.per_user),
          spend: caller.spend,
        });
      }
      for (const { scope, budget, spend } of budgets) {
        if (budget !== null && await monthlySpendMicrousd(env.DB, spend, month) >= budget) {
          throw new GatewayError(
            429,
            "app_budget_exhausted",
            `The application's monthly ${scope} spending budget is exhausted`,
            undefined,
            { data: { scope } },
          );
        }
      }
      return grant;
    }),
  };
}
