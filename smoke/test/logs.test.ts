import assert from "node:assert/strict";
import { test } from "node:test";
import { logMessageQuery, parseMessageCounts } from "../src/logs.ts";

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
  assert.throws(() => parseMessageCounts({ success: false }), /gave no counts/u);
});
