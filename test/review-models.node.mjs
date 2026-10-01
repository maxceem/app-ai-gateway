import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { addModels } from "../scripts/models/catalog-edit.mjs";
import { discoveryUpdate, notAddedKey } from "../scripts/models/new-models.mjs";
import { renderReport } from "../scripts/models/report.mjs";
import { decide, catalogEdits, needsHuman } from "../scripts/models/rules.mjs";
import { applyDecisions, catalogRates, ISSUE_MARKER, parseCommands, pendingDecisions, renderDecision, renderIssue } from "../scripts/models/review.mjs";
import { prepareReview, publishReview, githubClient } from "../scripts/review-models.mjs";

const fixture = (name) => readFileSync(new URL(`./fixtures/models/${name}`, import.meta.url), "utf8");
const text = '{\n  "openai": {\n    "old": { "input": 1.0, "output": 2.0 }\n  }\n}\n';
const today = "2026-09-30";
const noLists = { modelsDev: {}, litellm: {} };
const commands = (body) => parseCommands(body);

test("discovery: exact skips leave other models pending and trigger a notification PR without catalog edits", () => {
  const decision = decide({
    catalog: JSON.parse(text),
    official: { openai: { prices: new Map([["old", { input: 1, output: 2 }], ["new", null], ["skipped", null], ["skipped-next", null]]) } },
    acknowledged: [{ key: notAddedKey("openai", "skipped"), reason: "Older snapshot" }],
    lists: noLists, today,
  });
  assert.deepEqual(decision.newModels, [{ provider: "openai", ids: ["new", "skipped-next"] }]);
  assert.deepEqual(decision.skippedModels, [{ provider: "openai", model: "skipped", reason: "Older snapshot" }]);
  assert.deepEqual(catalogEdits(decision), []);
  assert.equal(needsHuman(decision), false);
  const discoveries = discoveryUpdate(decision.newModels, []);
  assert.deepEqual(discoveries.notifications, decision.newModels);
  assert.notEqual(JSON.stringify(discoveries.notified), "[]", "a discovery-only PR must have a reviewable file change");
  const report = renderReport({ ...decision, notifications: discoveries.notifications });
  assert.match(report, /### Newly discovered models[\s\S]*\| `openai` \| `new` \|/u);
  assert.ok(report.indexOf("### Newly discovered models") < report.indexOf("## Additional information"));
  assert.ok(report.indexOf("### Newly discovered models") < report.indexOf("### Sources"));
  assert.doesNotMatch(report, /<summary>New models/u);
  assert.match(report, /Models deliberately not added[\s\S]*Older snapshot/u);
});

test("discovery: merged notifications do not open repeated PRs or resolve add/skip decisions", () => {
  const newModels = [{ provider: "openai", ids: ["known", "new"] }, { provider: "together", ids: ["Qwen/new"] }];
  const previous = [{ provider: "openai", ids: ["gone", "known"] }];
  const first = discoveryUpdate(newModels, previous);
  assert.deepEqual(first.notifications, [{ provider: "openai", ids: ["new"] }, { provider: "together", ids: ["Qwen/new"] }]);
  assert.deepEqual(first.notified, [{ provider: "openai", ids: ["gone", "known", "new"] }, { provider: "together", ids: ["Qwen/new"] }]);
  assert.deepEqual(discoveryUpdate(newModels, previous), first, "retries before merge produce the same rolling PR diff");
  const merged = discoveryUpdate(newModels, first.notified);
  assert.deepEqual(merged.notifications, []);
  assert.equal(merged.notified, first.notified, "no repeated file change after merge");
  assert.deepEqual(discoveryUpdate([], first.notified).notified, first.notified, "missing pages do not erase notification history");
  assert.throws(() => discoveryUpdate(newModels, {}), /notified.json/u);
  const report = renderReport({
    changes: [], retirements: [], retired: [], deprecationNotes: [], attention: [], acknowledged: [], upcoming: [], noSource: [], sources: [],
    newModels, notifications: merged.notifications,
  });
  const [trigger, additional] = report.split("## Additional information");
  assert.match(trigger, /No pull request is needed/u);
  assert.doesNotMatch(trigger, /### Newly discovered models/u);
  assert.match(additional, /Previously reported models awaiting a decision[\s\S]*Qwen\/new/u);
  const mixed = renderReport({
    changes: [], retirements: [], retired: [], deprecationNotes: [], attention: [], acknowledged: [], upcoming: [], noSource: [], sources: [],
    newModels, notifications: first.notifications,
  });
  const [newTrigger, alreadyReported] = mixed.split("## Additional information");
  assert.match(newTrigger, /\| `openai` \| `new` \|/u);
  assert.doesNotMatch(newTrigger, /\| `openai` \| `known` \|/u);
  assert.match(alreadyReported, /\| `openai` \| `known` \|/u);
  assert.doesNotMatch(alreadyReported, /\| `openai` \| `new` \|/u);
});

test("commands: explicit actions, nested model IDs, reasons, no shell or ambiguous batches", () => {
  assert.deepEqual(commands("/models add together/Qwen/Qwen3.8-Flash\n/models skip openai/gpt-4o Old model"), [
    { action: "add", provider: "together", model: "Qwen/Qwen3.8-Flash" },
    { action: "skip", provider: "openai", model: "gpt-4o", reason: "Old model" },
  ]);
  for (const body of ["", "/models skip openai/a", "/models add openai/a reason", "/models add openai/$(id)", "/models add unknown/a", "/models add openai/a\n/models skip openai/a why", "/models add openai/a\nrun me"]) {
    assert.throws(() => commands(body));
  }
  assert.throws(() => commands(`/models add openai/${"a".repeat(9000)}`), /8,000/u);
});

test("catalog additions: surgical formatting, whole prices and long-context integer thresholds", () => {
  const added = addModels(text, [{ provider: "openai", model: "new", price: { input: 2, output: 10 } }]);
  assert.match(added, /"new": \{ "input": 2\.0, "output": 10\.0 \}/u);
  assert.ok(added.includes('    "old": { "input": 1.0, "output": 2.0 }'));
  const long = addModels(added, [{ provider: "openai", model: "long", price: { input: 2, output: 10, long_context_threshold: 272000, long_input: 4, long_output: 15 } }]);
  assert.match(long, /"long_context_threshold": 272000,/u);
  assert.doesNotMatch(long, /272000\.0/u);
  assert.deepEqual(JSON.parse(long).openai.old, { input: 1, output: 2 });
  assert.throws(() => addModels(long, [{ provider: "openai", model: "old", price: { input: 9, output: 9 } }]), /already exists/u);
});

test("decisions: current official rates are parsed fresh; future rates are not stored", async () => {
  const result = await applyDecisions({ text, acknowledged: [], today,
    commands: commands("/models add openai/gpt-6-astra\n/models skip openai/gpt-4o Older model"),
    loadPage: async () => fixture("openai.md"),
  });
  const entry = JSON.parse(result.text).openai["gpt-6-astra"];
  assert.equal(entry.input, 10);
  assert.equal(entry.long_context_threshold, 272000);
  assert.deepEqual(result.acknowledged, [{ key: "openai/gpt-4o: not added", reason: "Older model" }]);
  assert.deepEqual(catalogRates({ input: 1, output: 2, upcoming: [{ date: "2027-01-01", field: "input", value: 3 }] }), { input: 1, output: 2 });
});

test("decisions: unsupported prices, absent IDs, pending conflicts and invalid rates are refused", async () => {
  for (const body of ["/models add openai/omni-moderation-latest", "/models add openai/made-up"]) {
    await assert.rejects(applyDecisions({ text, acknowledged: [], today, commands: commands(body), loadPage: async () => fixture("openai.md") }));
  }
  await assert.rejects(applyDecisions({ text, acknowledged: [], today, commands: commands("/models add openai/gpt-6-astra"), pending: new Map([["openai/gpt-6-astra", "PR"]]), loadPage: async () => fixture("openai.md") }), /awaiting merge/u);
  for (const price of [{ input: NaN, output: 2 }, { input: 1e-6, output: 2 }, { input: 1, output: 2, cached_input: 3 }, { input: 1, output: 2, long_context_threshold: 5 }]) assert.throws(() => catalogRates(price));
});

test("decisions: skip retries are idempotent and adding a previously skipped model removes its acknowledgement", async () => {
  const acknowledged = [{ key: "openai/gpt-6-astra: not added", reason: "Not needed" }, { key: "parser", reason: "Expected" }];
  const retry = await applyDecisions({ text, acknowledged, today, commands: commands("/models skip openai/gpt-6-astra Not needed"), loadPage: async () => fixture("openai.md") });
  assert.deepEqual(retry.acknowledged, acknowledged);
  const added = await applyDecisions({ text, acknowledged, today, commands: commands("/models add openai/gpt-6-astra"), loadPage: async () => fixture("openai.md") });
  assert.deepEqual(added.acknowledged, [{ key: "parser", reason: "Expected" }]);
  const again = await applyDecisions({ text: added.text, acknowledged: added.acknowledged, today, commands: commands("/models add openai/gpt-6-astra"), loadPage: async () => fixture("openai.md") });
  assert.equal(again.text, added.text);
});

const repository = "maxceem/app-ai-gateway";
const issue = { number: 123, state: "open", html_url: `https://github.com/${repository}/issues/123`, user: { login: "github-actions[bot]" }, body: ISSUE_MARKER };
const comment = { id: 456, body: "/models add openai/gpt-6-astra", user: { id: 1, login: "owner", type: "User" } };
const event = { action: "created", issue, comment };
const pr = (cmds = commands(comment.body)) => ({ state: "open", user: { login: "github-actions[bot]" }, base: { ref: "main" }, head: { ref: "automation/model-review-456", repo: { full_name: repository } }, body: renderDecision(cmds, issue.html_url), html_url: `https://github.com/${repository}/pull/999` });

test("pending decisions: only matching bot PRs are trusted; issue stays visible and reasons inert", () => {
  const pending = pendingDecisions([pr(), { ...pr(), user: { login: "outsider" } }, { ...pr(), head: { ...pr().head, repo: { full_name: "outsider/fork" } } }], repository);
  assert.equal(pending.size, 1);
  const body = renderIssue({ newModels: [{ provider: "openai", ids: ["gpt-6-astra", "other"] }], skippedModels: [{ provider: "openai", model: "old", reason: "<script>[evil](url)" }] }, pending);
  assert.match(body, /Awaiting a decision[\s\S]*Decision PR[\s\S]*`openai\/other` \| Add or skip/u);
  assert.doesNotMatch(body, /<details>|<script>|(?<!\\)\[evil\]/u);
});

function harness(overrides = {}) {
  const calls = [], writes = [], outputs = [];
  const api = async (path, options = {}) => {
    calls.push([path, options]);
    if (options.method === "POST") return {};
    if (path === "issues/123") return overrides.issue ?? issue;
    if (path === "issues/comments/456") return overrides.comment ?? comment;
    if (path.startsWith("collaborators/")) return { permission: overrides.permission ?? "admin" };
    if (path.startsWith("pulls?")) return overrides.pulls ?? [];
    throw new Error(`Unexpected ${path}`);
  };
  return { calls, writes, outputs, options: { api, repository, bodyPath: "body.md", today,
    read: async (path) => path.endsWith("models.json") ? text : "[]",
    write: async (...args) => writes.push(args), output: async (value) => outputs.push(value),
    loadPage: async () => fixture("openai.md"),
  } };
}

test("prepare: authorized comment stages two allowed files and one PR body with a fixed branch", async () => {
  const h = harness();
  await prepareReview(event, h.options);
  assert.equal(h.writes.length, 3);
  assert.ok(h.writes[0][0].endsWith("src/usage/models.json"));
  assert.ok(h.writes[1][0].endsWith("scripts/models/acknowledged.json"));
  assert.equal(h.writes[2][0], "body.md");
  assert.deepEqual(h.outputs, ["ready=true\nbranch=automation/model-review-456\n"]);
});

test("prepare: unrelated issues, PRs, bots and users without live write permission make no writes", async () => {
  for (const overrides of [{ issue: { ...issue, user: { login: "outsider" } } }, { issue: { ...issue, pull_request: {} } }, { permission: "read" }, { comment: { ...comment, user: { ...comment.user, type: "Bot" } } }, { comment: { ...comment, user: { ...comment.user, id: 2 } } }]) {
    const h = harness(overrides);
    await prepareReview(event, h.options);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.outputs, []);
    assert.ok(h.calls.every(([, options]) => options.method !== "POST"));
  }
});

test("prepare: invalid second decision leaves both files untouched and explains failure", async () => {
  const h = harness({ comment: { ...comment, body: "/models add openai/gpt-6-astra\n/models add openai/made-up" } });
  await assert.rejects(prepareReview(event, h.options));
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.outputs, []);
  assert.ok(h.calls.some(([path, options]) => path === "issues/123/comments" && options.body.body.includes("not applied")));
});

test("publish: refreshes one existing issue; a partial scan cannot erase pending discoveries", async () => {
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push([path, options]);
    if (path.startsWith("issues?")) return [issue];
    if (path.startsWith("pulls?")) return [pr()];
    return issue;
  };
  const snapshot = { complete: true, newModels: [{ provider: "openai", ids: ["gpt-6-astra"] }], skippedModels: [] };
  await publishReview(snapshot, { api, repository });
  assert.equal(calls.filter(([, options]) => options.method === "PATCH").length, 1);
  assert.match(calls.at(-1)[1].body.body, /Decision PR/u);
  calls.length = 0;
  await publishReview({ ...snapshot, complete: false }, { api, repository });
  assert.deepEqual(calls, []);
});

test("publish: creates one review issue for discoveries, but none for an empty initial scan", async () => {
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push([path, options]);
    return options.method === "POST" ? issue : [];
  };
  await publishReview({ complete: true, newModels: [], skippedModels: [] }, { api, repository });
  assert.ok(calls.every(([, options]) => options.method !== "POST"));
  calls.length = 0;
  await publishReview({ complete: true, newModels: [{ provider: "openai", ids: ["new"] }], skippedModels: [] }, { api, repository });
  const created = calls.filter(([, options]) => options.method === "POST");
  assert.equal(created.length, 1);
  assert.equal(created[0][0], "issues");
  assert.ok(created[0][1].body.body.startsWith(ISSUE_MARKER));
});

test("GitHub client: credentials stay in headers and commands are JSON data", async () => {
  let captured;
  const api = githubClient(repository, "test-token", async (...args) => { captured = args; return new Response("{}", { status: 200 }); });
  await api("issues", { method: "POST", body: { body: "$(do-not-execute)" } });
  assert.equal(captured[1].headers.authorization, "Bearer test-token");
  assert.ok(!captured[0].includes("test-token"));
  assert.deepEqual(JSON.parse(captured[1].body), { body: "$(do-not-execute)" });
});
