import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import type { PostHog } from "posthog-js";

/**
 * Optional product analytics, off unless a deployment asks for it.
 *
 * This repository is what people self-host, so the property this file exists to
 * guarantee is that a deployment reports nothing unless it was configured to.
 * That guarantee is an absence rather than a check: with no project configured
 * there is no destination, `analyticsEnabled` is false, and every entry point
 * below returns immediately. The SDK sits behind a dynamic `import()` reached
 * only through that flag, so an unconfigured build never fetches the chunk it
 * lives in either.
 *
 * Both variables are read at build time, as everything in a client bundle must
 * be. The key is a public ingestion key rather than a personal API key — that is
 * how PostHog is meant to be called from a browser — so what configuration buys
 * is not secrecy but that an unconfigured build carries no trace of somebody
 * else's project.
 *
 * What is sent, when it is on, is deliberately thin: an account identifier, an
 * organization identifier, a role, and a handful of setup milestones. No name,
 * no email address, and nothing whatsoever from the requests the gateway
 * proxies. The capture sites below are the whole of it.
 */
const PROJECT_KEY = import.meta.env.VITE_POSTHOG_KEY;
const API_HOST = import.meta.env.VITE_POSTHOG_HOST;

/** Campaign labels survive scrubbing. Every other query parameter does not. */
const CAMPAIGN_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];

const AUTH_METHOD_KEY = "app-ai-gateway:analytics-auth-method:v1";
const SIGNED_UP_KEY = "app-ai-gateway:analytics-signed-up:v1";
const AWAITING_REQUEST_KEY = "app-ai-gateway:analytics-awaiting-request:v1";

/** Organizations remembered as not yet activated. Small because it is per browser. */
const AWAITING_LIMIT = 20;

/**
 * How fresh an account has to be for this load to be the one that created it.
 *
 * Google sign-up returns through a redirect that carries no evidence of having
 * registered anyone, so age is what distinguishes a new account from a returning
 * operator. Generous enough to survive a slow consent screen, short enough that
 * signing in again tomorrow is never mistaken for signing up.
 */
const SIGNUP_WINDOW_MS = 10 * 60_000;

/** Both, or nothing: a key with nowhere to send it is not a configuration. */
export const analyticsEnabled = Boolean(PROJECT_KEY && API_HOST);

function readStore(store: Storage, key: string): string | null {
  // Private modes and storage-blocking extensions throw on access.
  try { return store.getItem(key); } catch { return null; }
}

function writeStore(store: Storage, key: string, value: string): void {
  try { store.setItem(key, value); } catch { /* The event is simply not deduplicated. */ }
}

function readList(key: string): string[] {
  const raw = readStore(localStorage, key);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : [];
  } catch { return []; }
}

/**
 * A console path as its route rather than as the URL that was visited.
 *
 * `/apps/<id>/usage` names one of the operator's applications, and an
 * identifier is not something analytics needs: masking it keeps every app's
 * usage tab a single row in the reporting instead of one row per application.
 */
export function maskPath(pathname: string): string {
  const segments = pathname.split("/");
  if (segments[1] === "apps" && segments[2]) segments[2] = ":appId";
  return segments.join("/");
}

function cleanUrl(value: string): string {
  try {
    const url = new URL(value);
    const allowed = new URLSearchParams();
    for (const key of CAMPAIGN_KEYS) {
      const entry = url.searchParams.get(key);
      if (entry) allowed.set(key, entry.slice(0, 200));
    }
    url.search = allowed.toString();
    url.hash = "";
    url.pathname = maskPath(url.pathname);
    return url.toString();
  } catch { return ""; }
}

/**
 * The last thing every event passes through.
 *
 * Console URLs carry identifiers in the path and one-shot markers in the query
 * — `?from=`, `?plan=`, `?checkout=` — and the SDK attaches the current,
 * initial and session-entry URL to events by itself. Rather than trusting each
 * capture site to pass something safe, everything leaving here is rewritten to
 * the masked route plus campaign labels.
 *
 * Exported for the tests, which is the only reason it is not a closure.
 */
export function scrubEvent<T extends { properties: Record<string, unknown> }>(event: T | null): T | null {
  if (!event) return null;
  for (const properties of [event.properties, event.properties.$set, event.properties.$set_once]) {
    if (!properties || typeof properties !== "object") continue;
    const bag = properties as Record<string, unknown>;
    for (const key of Object.keys(bag)) {
      const value = bag[key];
      if (typeof value !== "string") continue;
      if (/^https?:\/\//i.test(value)) bag[key] = cleanUrl(value);
      else if (value.startsWith("/")) bag[key] = maskPath(value);
    }
  }
  event.properties.site = "console";
  // A development build is a developer pointing their own machine at whatever
  // project they configured; reporting excludes it by this property.
  event.properties.environment = import.meta.env.PROD ? "production" : "development";
  return event;
}

let client: PostHog | null = null;
let loading: Promise<void> | null = null;
let pending: ((posthog: PostHog) => void)[] = [];

/** Beyond this, the SDK is not coming and holding work for it serves nobody. */
const PENDING_LIMIT = 50;

function load(): void {
  // The literal form, not `analyticsEnabled`, so the bundler folds it before it
  // decides on chunks: an unconfigured build then emits no SDK chunk at all
  // rather than an orphan nothing fetches.
  if (!import.meta.env.VITE_POSTHOG_KEY || !import.meta.env.VITE_POSTHOG_HOST) return;
  loading ??= import("posthog-js")
    .then(({ default: posthog }) => {
      posthog.init(PROJECT_KEY, {
        api_host: API_HOST,
        defaults: "2026-05-30",
        autocapture: false,
        capture_pageview: false,
        capture_pageleave: true,
        capture_dead_clicks: false,
        capture_heatmaps: false,
        capture_exceptions: false,
        capture_performance: false,
        rageclick: false,
        disable_session_recording: true,
        disable_surveys: true,
        advanced_disable_feature_flags: true,
        person_profiles: "identified_only",
        // Both of these are stored on the registrable parent domain rather than
        // on this host. Where a marketing site on the same domain reports to the
        // same project, that is what makes a visit there and an account created
        // here one person rather than two. It is also where an opt-out set by
        // hand goes, so that it covers both.
        cross_subdomain_cookie: true,
        opt_out_capturing_persistence_type: "cookie",
        cookie_expiration: 180,
        respect_dnt: true,
        before_send: (event) => scrubEvent(event),
      });
      client = posthog;
      const queued = pending;
      pending = [];
      for (const task of queued) task(posthog);
    })
    .catch(() => {
      // Blocked by an extension, or offline. Analytics is never worth a broken
      // console, so the queue is dropped and every later call is a no-op.
      pending = [];
    });
}

function run(task: (posthog: PostHog) => void): void {
  if (!analyticsEnabled) return;
  if (client) {
    task(client);
    return;
  }
  if (pending.length < PENDING_LIMIT) pending.push(task);
  load();
}

export const analytics = {
  enabled: analyticsEnabled,

  capture(event: string, properties?: Record<string, unknown>): void {
    run((posthog) => posthog.capture(event, properties));
  },

  /**
   * Ties this browser's history to an account. The identifier is opaque: the
   * name and email address stay in the gateway's own database.
   */
  identify(userId: string, role: string, createdAt: string): void {
    run((posthog) => posthog.identify(userId, { role }, { signed_up_at: createdAt }));
  },

  /**
   * Organization-level reporting: activation and plan describe the account, not
   * the person holding the keyboard. Properties are omitted rather than sent
   * empty, so simply being signed in does not restate what is already stored.
   */
  group(organizationId: string, properties?: Record<string, unknown>): void {
    run((posthog) => posthog.group("organization", organizationId, properties));
  },

  /** Signing out ends the association, so a shared browser does not merge two operators. */
  reset(): void {
    run((posthog) => posthog.reset());
  },
};

/**
 * Remembers how the current authentication attempt was started.
 *
 * Written before the attempt because the Google leg leaves the page entirely;
 * `sessionStorage` is what survives that round trip while still expiring with
 * the tab.
 */
export function noteAuthMethod(method: "password" | "google"): void {
  if (!analyticsEnabled) return;
  writeStore(sessionStorage, AUTH_METHOD_KEY, method);
}

/**
 * `signup_completed`, at most once per account.
 *
 * The account's own age decides whether this load created it, so both sign-up
 * paths are answered by one rule and neither has to report anything itself. The
 * marker is what stops a reload — or a second tab — inside the window from
 * counting the same account twice.
 */
export function captureSignup(userId: string, createdAt: string): void {
  if (!analyticsEnabled) return;
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created) || Date.now() - created > SIGNUP_WINDOW_MS) return;
  if (readStore(localStorage, SIGNED_UP_KEY) === userId) return;
  writeStore(localStorage, SIGNED_UP_KEY, userId);
  analytics.capture("signup_completed", {
    method: readStore(sessionStorage, AUTH_METHOD_KEY) ?? "unknown",
  });
}

/**
 * The two setup steps between signing up and serving a request, which are the
 * first two steps of the console's own first-run checklist.
 *
 * Reported every time rather than only the first: the console causes these, so
 * it knows about all of them, and an organization's second and third
 * application are worth knowing about too. Which one was the first is a
 * question for the reporting, and every funnel answers it by taking the
 * earliest occurrence.
 *
 * Both take the one detail worth having rather than the payload that carried
 * it. That is deliberate for {@link captureProviderAdded} in particular: the
 * body it is called beside holds a provider credential in plaintext, and a
 * signature that cannot accept one is a better guarantee than a rule about
 * remembering not to pass it.
 */
export function captureProviderAdded(provider: string, routedThroughGateway: boolean): void {
  analytics.capture("provider_added", {
    provider,
    route: routedThroughGateway ? "gateway" : "direct",
  });
}

export function captureAppCreated(authentication: string): void {
  analytics.capture("app_created", { authentication });
}

/**
 * `first_successful_request` — the moment an organization's gateway first
 * serves something, which is this product's definition of activation.
 *
 * The gateway itself is where that happens, and it is deliberately not where
 * this is reported from: a proxied request is the hot path, and the hosted
 * service is not worth slowing down for a marketing number. The console watches
 * instead. It can only report an organization it has previously seen in the
 * not-yet-activated state, which is why the waiting list is written first and
 * read second — an organization that activated before this browser ever looked
 * produces no event at all, rather than a false one dated today.
 *
 * In practice the console is where an application and a provider are set up, so
 * the unactivated state is seen almost every time.
 */
export function noteProxiedRequests(organizationId: string, hasProxiedRequests: boolean): void {
  if (!analyticsEnabled) return;
  const awaiting = readList(AWAITING_REQUEST_KEY);
  const watched = awaiting.includes(organizationId);

  if (!hasProxiedRequests) {
    if (watched) return;
    writeStore(localStorage, AWAITING_REQUEST_KEY, JSON.stringify([...awaiting, organizationId].slice(-AWAITING_LIMIT)));
    return;
  }

  if (!watched) return;
  writeStore(localStorage, AWAITING_REQUEST_KEY, JSON.stringify(awaiting.filter((entry) => entry !== organizationId)));
  analytics.capture("first_successful_request");
  analytics.group(organizationId, { activated: true });
}

/** One `$pageview` per console route, addressed by route rather than by URL. */
export function useAnalyticsPageviews(): void {
  const { pathname } = useLocation();
  useEffect(() => {
    analytics.capture("$pageview");
  }, [pathname]);
}
