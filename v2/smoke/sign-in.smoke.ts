/**
 * People's sign-in against a live v2 deployment (step 2b): the OAuth
 * discovery documents on `/v2`, a CLI sign-in without a browser up to the
 * point where it waits for a person, and a management key still working.
 *
 *   V2_BASE_URL=https://api.example.com \
 *   V2_CONSOLE_URL=https://console.example.com \
 *   V2_MANAGEMENT_KEY=agw_mgmt_… \
 *   pnpm --filter @app-ai-gateway/gateway-v2 smoke
 *
 * The OAuth checks need V2_CONSOLE_URL (the deployment's CONSOLE_ORIGIN), and
 * the key check needs V2_MANAGEMENT_KEY; each is skipped without it. Nothing
 * is left behind: a device code nobody approves lapses after ten minutes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const base = process.env.V2_BASE_URL ?? "";
const consoleUrl = process.env.V2_CONSOLE_URL ?? "";
const managementKey = process.env.V2_MANAGEMENT_KEY ?? "";
const noConsole = consoleUrl === "" ? "V2_CONSOLE_URL is needed" : false;

const issuer = () => `${new URL(consoleUrl).origin}/v2`;

test("the OAuth server is published on /v2 of the console's host", { skip: noConsole }, async () => {
  const response = await fetch(new URL("/.well-known/oauth-authorization-server/v2", consoleUrl));
  assert.equal(response.status, 200);
  const metadata = (await response.json()) as Record<string, unknown>;
  assert.equal(metadata.issuer, issuer());
  assert.equal(metadata.token_endpoint, `${issuer()}/oauth/token`);
  assert.equal(metadata.device_authorization_endpoint, `${issuer()}/oauth/device_authorization`);
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);

  const resource = await fetch(new URL("/.well-known/oauth-protected-resource/v2", consoleUrl));
  assert.equal(resource.status, 200);
  assert.equal(((await resource.json()) as Record<string, unknown>).resource, issuer());
});

test("a CLI sign-in without a browser waits for a person", { skip: noConsole }, async () => {
  const started = await fetch(`${issuer()}/oauth/device_authorization`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: "agw-cli" }),
  });
  assert.equal(started.status, 200);
  assert.equal(started.headers.get("cache-control"), "no-store");
  const device = (await started.json()) as Record<string, any>;
  assert.match(device.user_code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/u);
  assert.equal(device.verification_uri, `${new URL(consoleUrl).origin}/v2/device`);

  // A CLI waits the interval before its first poll.
  await new Promise((resolve) => setTimeout(resolve, device.interval * 1_000 + 200));
  const poll = await fetch(`${issuer()}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: device.device_code,
      client_id: "agw-cli",
    }),
  });
  assert.equal(poll.status, 400);
  assert.equal(((await poll.json()) as Record<string, unknown>).error, "authorization_pending");
});

test("the console's capabilities say the CLI can sign in", { skip: noConsole }, async () => {
  const response = await fetch(new URL("/v2/console/capabilities", consoleUrl));
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as Record<string, unknown>).oauth, true);
});

test("a management key still reaches the management API", { skip: managementKey === "" || base === "" ? "V2_MANAGEMENT_KEY and V2_BASE_URL are needed" : false }, async () => {
  const response = await fetch(new URL("/v2/admin/session", base), { headers: { authorization: `Bearer ${managementKey}` } });
  assert.equal(response.status, 200);
  const { session } = (await response.json()) as { session: Record<string, unknown> };
  assert.equal(session.credentialType, "apiKey");
});

test("the management API refuses a caller with no credential, with a Bearer challenge", { skip: base === "" ? "V2_BASE_URL is needed" : false }, async () => {
  const response = await fetch(new URL("/v2/admin/apps", base));
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate") ?? "", /^Bearer realm="management"/u);
});
