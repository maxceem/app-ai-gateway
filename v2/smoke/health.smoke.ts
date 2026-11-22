/**
 * Checks against a live v2 deployment. Run with the deployment's origin:
 *
 *   V2_BASE_URL=https://gateway.example.com pnpm --filter @app-ai-gateway/gateway-v2 smoke
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const base = process.env.V2_BASE_URL;
if (base === undefined || base === "") throw new Error("Set V2_BASE_URL to the deployment's origin.");

test("the health check answers", async () => {
  const response = await fetch(new URL("/v2/healthz", base));
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.deepEqual({ ok: body.ok, service: body.service, api: body.api, vault: body.vault }, { ok: true, service: "app-ai-gateway", api: "v2", vault: "ok" });
  // Added in step 7b-7, optional: whether the deployment can send verification email.
  if (body.email !== undefined) assert.ok(["off", "ok", "misconfigured"].includes(String(body.email)));
});

test("a path v2 does not declare is a JSON 404", async () => {
  const response = await fetch(new URL("/v2/nothing/served/here", base));
  assert.equal(response.status, 404);
  const body = (await response.json()) as { error?: { code?: string } };
  assert.equal(body.error?.code, "not_found");
});
