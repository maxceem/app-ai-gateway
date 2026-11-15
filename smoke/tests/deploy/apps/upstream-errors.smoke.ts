import { expect, test } from "vitest";
import { admin, call, smokeId } from "../../../src/gateway.ts";
import { MODEL } from "../../../src/mock/formats.ts";
import { env, expectStatus, state } from "../../support.ts";

// The mock fails on purpose for these models; the app must see the provider's
// own status, not a gateway failure of its own.
const appId = state.apps.server.id;
const path = `/v1/apps/${appId}/proxy/smoke-openai/v1/chat/completions`;

for (const status of [429, 500]) {
  test(`a provider's ${status} reaches the app as ${status}`, async () => {
    const response = await call(env, path, {
      key: state.apps.server.key,
      body: { model: `smoke-${status}`, messages: [{ role: "user", content: smokeId() }] },
    });
    expect(response.status).toBe(status);
    expect(await response.text()).toContain(`Smoke failure ${status}`);
  });
}

interface UsageEvent {
  status: string;
  error?: string | null;
}

/** The usage event of the request sent with `trace`, once it is recorded, which happens in the background. */
async function recordedEvent(trace: string): Promise<UsageEvent | undefined> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const { events } = await admin<{ events: UsageEvent[] }>(
      env,
      "GET",
      `/v1/admin/apps/${appId}/events?trace=${encodeURIComponent(trace)}`,
    );
    if (events[0]) return events[0];
  }
  return undefined;
}

// What a usage event says about how the request went: `status` is `ok` or
// `provider_error`, and a failure also says why in `error`, starting with the
// provider's own HTTP status. Clients filter and group by `status`, so it stays
// as it is however the gateway stores it.
test("a usage event says whether the provider failed the request, and why", { timeout: 150_000 }, async () => {
  const failed = smokeId();
  const failure = await call(env, path, {
    key: state.apps.server.key,
    headers: { "x-client-trace-id": failed },
    body: { model: "smoke-429", messages: [{ role: "user", content: failed }] },
  });
  expect(failure.status).toBe(429);
  await failure.text();

  const served = smokeId();
  const success = await call(env, path, {
    key: state.apps.server.key,
    headers: { "x-client-trace-id": served },
    body: { model: MODEL, messages: [{ role: "user", content: served }] },
  });
  await expectStatus(success, 200, "Served Chat Completions");
  await success.text();

  const failedEvent = await recordedEvent(failed);
  expect(failedEvent, "no usage event recorded for the failed request within 60s").toBeDefined();
  expect(failedEvent!.status).toBe("provider_error");
  expect(failedEvent!.error).toMatch(/^429\b/u);

  const servedEvent = await recordedEvent(served);
  expect(servedEvent, "no usage event recorded for the served request within 60s").toBeDefined();
  expect(servedEvent!.status).toBe("ok");
  expect(servedEvent!.error ?? null).toBeNull();

  const today = new Date().toISOString().slice(0, 10);
  const { rows } = await admin<{ rows: { key: string | null; errors: number }[] }>(
    env,
    "GET",
    `/v1/admin/apps/${appId}/usage/breakdown?by=status&from=${today}&to=${today}`,
  );
  expect(rows.map((row) => row.key)).toEqual(expect.arrayContaining(["ok", "provider_error"]));
  expect(rows.every((row) => row.key === "ok" || row.key === "provider_error")).toBe(true);
  expect(rows.find((row) => row.key === "provider_error")!.errors).toBeGreaterThan(0);
});
