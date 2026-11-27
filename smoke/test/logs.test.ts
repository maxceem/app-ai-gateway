import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { countLogMessages, LogsUnreadable, logMessageQuery, parseMessageCounts, queryFailure } from "../src/logs.ts";

// The log check reads counts only, grouped by message, for one Worker.

test("the query counts the given messages of one Worker, grouped by message", () => {
  const query = logMessageQuery("app-ai-gateway", ["a", "b"], 1_000, 2_000) as {
    timeframe: unknown;
    parameters: { filters: unknown[]; groupBys: unknown[] };
  };
  assert.deepEqual(query.timeframe, { from: 1_000, to: 2_000 });
  assert.deepEqual(query.parameters.filters[0], {
    key: "$workers.scriptName", operation: "eq", type: "string", value: "app-ai-gateway",
  });
  assert.deepEqual(query.parameters.filters[1], {
    kind: "group",
    filterCombination: "or",
    filters: [
      { key: "$metadata.message", operation: "eq", type: "string", value: "a" },
      { key: "$metadata.message", operation: "eq", type: "string", value: "b" },
    ],
  });
  assert.deepEqual(query.parameters.groupBys, [{ type: "string", value: "$metadata.message" }]);
});

test("counts are read per message, and an answer without them is refused", () => {
  assert.deepEqual(
    parseMessageCounts({
      success: true,
      result: { calculations: [{ aggregates: [{ groupKey: "known_record_served", value: 3 }, { groupKey: "x", value: 0 }] }] },
    }),
    { known_record_served: 3 },
  );
  assert.deepEqual(parseMessageCounts({ success: true, result: { calculations: [{ aggregates: [] }] } }), {});
  assert.throws(() => parseMessageCounts({ success: false }), (error) => error instanceof LogsUnreadable && /gave no counts/u.test(error.message));
});

// A failed query must read as the monitor being unable to look, never as the
// gateway falling back, and must name why by kind or status only.

const logs = { accountId: "account", apiToken: "token", workerName: "app-ai-gateway" };
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function failureOf(fetch: () => Promise<Response>): Promise<LogsUnreadable> {
  globalThis.fetch = fetch;
  const error: unknown = await countLogMessages(logs, ["a"], 60_000).then(
    () => assert.fail("the query should have failed"),
    (failure: unknown) => failure,
  );
  assert.ok(error instanceof LogsUnreadable, String(error));
  assert.match(error.message, /^the monitor could not read the gateway's logs, which says nothing about the gateway: /u);
  return error;
}

test("an error status from Cloudflare is a failure to read the logs, named by its status", async () => {
  const error = await failureOf(async () => new Response("the query echoed back", { status: 504 }));
  assert.match(error.message, /answered 504$/u);
  assert.doesNotMatch(error.message, /echoed/u);
});

test("a query that is sent nowhere, times out or answers no JSON is a failure to read the logs", async () => {
  assert.match((await failureOf(async () => Promise.reject(new TypeError("fetch failed: https://api.cloudflare.com/...")))).message, /could not be sent \(TypeError\)$/u);
  assert.match((await failureOf(async () => Promise.reject(new DOMException("aborted", "TimeoutError")))).message, /did not answer within 20 seconds$/u);
  assert.match((await failureOf(async () => new Response("<html>", { status: 200 }))).message, /something other than JSON$/u);
  assert.match((await failureOf(async () => Response.json({ success: false }))).message, /gave no counts$/u);
  assert.equal(queryFailure("not an error"), "Cloudflare's log query could not be sent (unknown error)");
});

test("an answer with counts is read, and no failure is raised", async () => {
  globalThis.fetch = async () =>
    Response.json({ success: true, result: { calculations: [{ aggregates: [{ groupKey: "a", value: 2 }] }] } });
  assert.deepEqual(await countLogMessages(logs, ["a"], 60_000), { a: 2 });
});
