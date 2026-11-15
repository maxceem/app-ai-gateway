import { expect, test } from "vitest";
import { admin, call, smokeId } from "../../../src/gateway.ts";
import { MODEL } from "../../../src/mock/formats.ts";
import { env, expectForwardedCleanly, expectStatus, json, state } from "../../support.ts";

// The OpenAI wire format, which every OpenAI-compatible provider type shares.
const proxy = (path: string) => `/v1/apps/${state.apps.server.id}/proxy/smoke-openai/${path}`;
const key = state.apps.server.key;

test("a server app gets a Chat Completions answer", async () => {
  const id = smokeId();
  const response = await call(env, proxy("v1/chat/completions"), {
    key,
    body: { model: MODEL, messages: [{ role: "user", content: id }] },
  });
  await expectStatus(response, 200, "Chat Completions");
  const body = await json<{ choices: { message: { content: string } }[] }>(response, "Chat Completions");
  expect(body.choices[0]?.message.content).toBe(`pong ${id}`);
  await expectForwardedCleanly(id, "v1/chat/completions");
});

test("a server app gets a streamed Chat Completions answer", async () => {
  const id = smokeId();
  const response = await call(env, proxy("v1/chat/completions"), {
    key,
    body: { model: MODEL, stream: true, messages: [{ role: "user", content: id }] },
  });
  await expectStatus(response, 200, "Streamed Chat Completions");
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const text = await response.text();
  expect(text).toContain(`pong ${id}`);
  expect(text).toContain("data: [DONE]");
  await expectForwardedCleanly(id, "v1/chat/completions");
});

test("a server app gets a Responses answer", async () => {
  const id = smokeId();
  const response = await call(env, proxy("v1/responses"), { key, body: { model: MODEL, input: id } });
  await expectStatus(response, 200, "Responses");
  const body = await json<{ output: { content: { text: string }[] }[] }>(response, "Responses");
  expect(body.output[0]?.content[0]?.text).toBe(`pong ${id}`);
  await expectForwardedCleanly(id, "v1/responses");
});

test("a server app gets a streamed Responses answer", async () => {
  const id = smokeId();
  const response = await call(env, proxy("v1/responses"), { key, body: { model: MODEL, input: id, stream: true } });
  await expectStatus(response, 200, "Streamed Responses");
  const text = await response.text();
  expect(text).toContain(`pong ${id}`);
  expect(text).toContain("response.completed");
  await expectForwardedCleanly(id, "v1/responses");
});

// The smoke model has a custom price with no service modes, so a flex request
// has no exact price. It must still be served, never refused, and its usage
// event must say the cost is an estimate.
test("a request in a service mode with no price is served and recorded as estimated", { timeout: 75_000 }, async () => {
  const id = smokeId();
  const response = await call(env, proxy("v1/chat/completions"), {
    key,
    headers: { "x-client-trace-id": id },
    body: { model: MODEL, service_tier: "flex", messages: [{ role: "user", content: id }] },
  });
  await expectStatus(response, 200, "Flex Chat Completions");
  await response.text();
  await expectForwardedCleanly(id, "v1/chat/completions");

  type Event = { service_mode?: string | null; cost_source: string | null };
  const path = `/v1/admin/apps/${state.apps.server.id}/events?trace=${encodeURIComponent(id)}`;
  const deadline = Date.now() + 60_000;
  let event: Event | undefined;
  while (!event && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    event = (await admin<{ events: Event[] }>(env, "GET", path)).events[0];
  }
  expect(event, "no usage event recorded within 60s").toBeDefined();
  expect(event).toMatchObject({ service_mode: "flex", cost_source: "estimated" });
});
