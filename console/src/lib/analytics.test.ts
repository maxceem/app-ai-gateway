import { afterEach, beforeEach, expect, test, vi } from "vitest";

/**
 * The SDK is never loaded for real here: these tests are about what the console
 * decides to send, and a working `posthog-js` would decide to make network
 * requests about it.
 */
const posthog = vi.hoisted(() => ({
  init: vi.fn(),
  capture: vi.fn(),
  identify: vi.fn(),
  group: vi.fn(),
  reset: vi.fn(),
  has_opted_out_capturing: vi.fn(() => false),
  opt_out_capturing: vi.fn(),
  opt_in_capturing: vi.fn(),
}));

vi.mock("posthog-js", () => ({ default: posthog }));

/**
 * A fresh copy of the module, configured or not.
 *
 * The configuration is read once, when the module is evaluated, so a test that
 * wants the other answer needs the module evaluated again.
 */
async function loadAnalytics({ configured = true } = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  if (configured) {
    vi.stubEnv("VITE_POSTHOG_KEY", "phc_test");
    vi.stubEnv("VITE_POSTHOG_HOST", "https://posthog.test");
  }
  localStorage.clear();
  sessionStorage.clear();
  return import("./analytics");
}

beforeEach(() => {
  for (const spy of Object.values(posthog)) spy.mockClear();
  posthog.has_opted_out_capturing.mockReturnValue(false);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

test("a deployment with no project configured never loads the SDK", async () => {
  const { analytics, analyticsEnabled, captureSignup, noteProxiedRequests } = await loadAnalytics({ configured: false });
  expect(analyticsEnabled).toBe(false);

  analytics.capture("signup_completed");
  analytics.identify("user_1", "owner", new Date().toISOString());
  captureSignup("user_1", new Date().toISOString());
  noteProxiedRequests("org_1", false);
  noteProxiedRequests("org_1", true);

  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(posthog.init).not.toHaveBeenCalled();
  expect(posthog.capture).not.toHaveBeenCalled();
  // Nothing is remembered either: the state only exists to dedupe events that
  // this deployment does not send.
  expect(localStorage.length).toBe(0);
});

test("half a configuration is no configuration", async () => {
  vi.resetModules();
  vi.unstubAllEnvs();
  // A key with nowhere to send it, and a destination with nothing to send.
  vi.stubEnv("VITE_POSTHOG_KEY", "phc_test");
  const keyOnly = await import("./analytics");
  expect(keyOnly.analyticsEnabled).toBe(false);

  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("VITE_POSTHOG_HOST", "https://posthog.test");
  const hostOnly = await import("./analytics");
  expect(hostOnly.analyticsEnabled).toBe(false);

  keyOnly.analytics.capture("ignored");
  hostOnly.analytics.capture("ignored");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(posthog.init).not.toHaveBeenCalled();
});

test("events queued before the SDK arrives are sent once it does", async () => {
  const { analytics } = await loadAnalytics();
  analytics.capture("first", { a: 1 });
  analytics.capture("second");
  expect(posthog.capture).not.toHaveBeenCalled();

  await vi.waitFor(() => expect(posthog.capture).toHaveBeenCalledTimes(2));
  expect(posthog.init).toHaveBeenCalledTimes(1);
  expect(posthog.capture).toHaveBeenNthCalledWith(1, "first", { a: 1 });

  // The configured project, and nothing baked in.
  expect(posthog.init.mock.calls[0]![0]).toBe("phc_test");
  const options = posthog.init.mock.calls[0]![1] as Record<string, unknown>;
  expect(options.api_host).toBe("https://posthog.test");
  // The two settings the cross-domain funnel and a shared opt-out rest on.
  expect(options.cross_subdomain_cookie).toBe(true);
  expect(options.opt_out_capturing_persistence_type).toBe("cookie");
  // And the ones that keep this to counting, not watching.
  expect(options.disable_session_recording).toBe(true);
  expect(options.autocapture).toBe(false);
});

test("application identifiers are masked out of paths and URLs", async () => {
  const { maskPath, scrubEvent } = await loadAnalytics();
  expect(maskPath("/apps")).toBe("/apps");
  expect(maskPath("/apps/0198f2c1a0d3/usage")).toBe("/apps/:appId/usage");
  expect(maskPath("/apps/0198f2c1a0d3/auth/identity")).toBe("/apps/:appId/auth/identity");
  expect(maskPath("/settings/account")).toBe("/settings/account");

  const properties: Record<string, unknown> = {
    $current_url: "https://console.appaigateway.com/apps/0198f2c1a0d3/usage?from=%2Fbilling&utm_source=reddit#tab",
    $pathname: "/apps/0198f2c1a0d3/usage",
    plan: "growth",
    $set_once: { $initial_current_url: "https://appaigateway.com/?utm_campaign=launch&token=secret" },
  };
  const event = scrubEvent({ properties });

  expect(event!.properties.$current_url).toBe("https://console.appaigateway.com/apps/:appId/usage?utm_source=reddit");
  expect(event!.properties.$pathname).toBe("/apps/:appId/usage");
  expect(event!.properties.plan).toBe("growth");
  expect((event!.properties.$set_once as Record<string, unknown>).$initial_current_url)
    .toBe("https://appaigateway.com/?utm_campaign=launch");
  expect(event!.properties.site).toBe("console");
  // Vitest runs unbuilt, so this is a development reading by construction.
  expect(event!.properties.environment).toBe("development");
});

test("a sign-up is reported once, for a new account, with the method it used", async () => {
  const { captureSignup, noteAuthMethod } = await loadAnalytics();
  noteAuthMethod("google");
  captureSignup("user_1", new Date().toISOString());
  captureSignup("user_1", new Date().toISOString());

  await vi.waitFor(() => expect(posthog.capture).toHaveBeenCalledTimes(1));
  expect(posthog.capture).toHaveBeenCalledWith("signup_completed", { method: "google" });
});

test("signing in to an established account is not a sign-up", async () => {
  const { captureSignup } = await loadAnalytics();
  const lastYear = new Date(Date.now() - 365 * 24 * 60 * 60_000).toISOString();
  captureSignup("user_1", lastYear);
  captureSignup("user_2", "not a date");

  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(posthog.capture).not.toHaveBeenCalled();
});

test("a provider and an app report what was set up, never the credential", async () => {
  const { captureProviderAdded, captureAppCreated } = await loadAnalytics();
  captureProviderAdded("anthropic", false);
  captureProviderAdded("openai", true);
  captureAppCreated("apple_app_attest");

  await vi.waitFor(() => expect(posthog.capture).toHaveBeenCalledTimes(3));
  expect(posthog.capture).toHaveBeenNthCalledWith(1, "provider_added", {
    provider: "anthropic",
    route: "direct",
  });
  expect(posthog.capture).toHaveBeenNthCalledWith(2, "provider_added", {
    provider: "openai",
    route: "gateway",
  });
  expect(posthog.capture).toHaveBeenNthCalledWith(3, "app_created", {
    authentication: "apple_app_attest",
  });
});

test("activation is reported when a watched organization serves its first request", async () => {
  const { noteProxiedRequests } = await loadAnalytics();
  // Seen while still being set up, which is how the console sees it.
  noteProxiedRequests("org_1", false);
  noteProxiedRequests("org_1", false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(posthog.capture).not.toHaveBeenCalled();

  noteProxiedRequests("org_1", true);
  await vi.waitFor(() => expect(posthog.capture).toHaveBeenCalledWith("first_successful_request", undefined));
  expect(posthog.group).toHaveBeenCalledWith("organization", "org_1", { activated: true });

  // Every later reading says the same thing, and says nothing new.
  posthog.capture.mockClear();
  noteProxiedRequests("org_1", true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(posthog.capture).not.toHaveBeenCalled();
});

test("an organization first seen already active reports no activation", async () => {
  const { noteProxiedRequests } = await loadAnalytics();
  noteProxiedRequests("org_2", true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(posthog.capture).not.toHaveBeenCalled();
});
