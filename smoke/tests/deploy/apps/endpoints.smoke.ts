import { expect, test } from "vitest";
import { ENDPOINT_SLUG } from "../../../src/fixtures.ts";
import { admin, call, smokeId } from "../../../src/gateway.ts";
import { env, expectForwardedCleanly, expectStatus, json, state } from "../../support.ts";

test("a custom endpoint answers with its configured provider and model", async () => {
  const id = smokeId();
  const response = await call(env, `/v1/apps/${state.apps.server.id}/endpoints/${ENDPOINT_SLUG}`, {
    key: state.apps.server.key,
    body: { input: id },
  });
  await expectStatus(response, 200, "Custom endpoint");
  const body = await json<{ output: { content: { text: string }[] }[] }>(response, "Custom endpoint");
  expect(body.output[0]?.content[0]?.text).toBe(`pong ${id}`);
  await expectForwardedCleanly(id, "v1/responses");
});

// A request the app's own settings refuse is answered as before and shows up
// as a refusal sample, so a developer can see what their app asked for. Samples
// are one a minute per caller and reason, so a run overlapping another counts
// any recent smoke sample rather than only its own.
const RECORDING_DEADLINE_MS = 60_000;
const MISSING_PREFIX = "smoke-missing-";

test("a custom endpoint the app does not have is refused and recorded as a refusal sample", { timeout: RECORDING_DEADLINE_MS + 15_000 }, async () => {
  const slug = `${MISSING_PREFIX}${Date.now().toString(36)}`;
  const response = await call(env, `/v1/apps/${state.apps.server.id}/endpoints/${slug}`, {
    key: state.apps.server.key,
    body: { input: smokeId() },
  });
  expect(response.status).toBe(404);
  expect((await json<{ error: { code: string } }>(response, "Missing endpoint")).error.code).toBe("endpoint_not_found");

  type Sample = { reason: string; scope: string | null; endpoint_slug: string | null; created_at: string };
  const since = Date.now() - 120_000;
  const path = `/v1/admin/apps/${state.apps.server.id}/rejection-events?reason=endpoint_not_found&limit=20`;
  const deadline = Date.now() + RECORDING_DEADLINE_MS;
  let sample: Sample | undefined;
  while (!sample && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    sample = (await admin<{ events: Sample[] }>(env, "GET", path)).events.find((event) =>
      event.endpoint_slug?.startsWith(MISSING_PREFIX) && Date.parse(event.created_at) >= since);
  }
  expect(sample, "no refusal sample recorded within 60s").toBeDefined();
  expect(sample).toMatchObject({ reason: "endpoint_not_found", scope: "app" });
});
