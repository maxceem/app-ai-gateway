import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { addModels } from "../scripts/models/catalog-edit.mjs";
import { createClassifier, recommendModels } from "../scripts/models/ai-review.mjs";
import { applyChoices, collectCandidates, modelKey, REVIEW_PATH, validateChoices } from "../scripts/models/choices.mjs";
import { notAddedKey } from "../scripts/models/new-models.mjs";
import { renderReport } from "../scripts/models/report.mjs";
import { decide, catalogEdits, needsHuman } from "../scripts/models/rules.mjs";
import { catalogRates, parseCommands } from "../scripts/models/review.mjs";
import { githubClient, loadReview, prepareReview, readReview, trustedPull } from "../scripts/review-models.mjs";

const fixture = (name) => readFileSync(new URL(`./fixtures/models/${name}`, import.meta.url), "utf8");
const text = '{\n  "openai": {\n    "old": { "input": 1.0, "output": 2.0 }\n  }\n}\n';
const today = "2026-10-01";
const noLists = { modelsDev: {}, litellm: {} };
const candidate = (model, price = { input: 1, output: 2 }) => ({ provider: "openai", model, canonical: model, ...(price ? { price } : { problem: "No supported public rates." }), info: {} });
const choice = (model, action = "add", origin = "ai", reason = "Useful current model.") => ({ provider: "openai", model, action, reason, origin, reviewer: origin === "ai" ? "gpt-6-luna" : "owner" });
const context = { today, catalog: { openai: ["old"] }, newModels: [{ provider: "openai", ids: ["new"] }] };
const response = (decisions, overrides = {}) => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ decisions }) } }], ...overrides }));
const apiSettings = { url: "https://example.com/v1/chat/completions", key: "private-test-credential-never-in-output" };

test("discovery: exact skip acknowledgements leave other models pending and still trigger a PR", () => {
  const decision = decide({ catalog: JSON.parse(text), official: { openai: { prices: new Map([["old", { input: 1, output: 2 }], ["new", null], ["skipped", null], ["skipped-next", null]]) } },
    acknowledged: [{ key: notAddedKey("openai", "skipped"), reason: "Older snapshot" }], lists: noLists, today });
  assert.deepEqual(decision.newModels, [{ provider: "openai", ids: ["new", "skipped-next"] }]);
  assert.deepEqual(decision.skippedModels, [{ provider: "openai", model: "skipped", reason: "Older snapshot" }]);
  assert.deepEqual(catalogEdits(decision), []);
  assert.equal(needsHuman(decision), false);
  const report = renderReport({ ...decision, modelChoices: [choice("new"), choice("skipped-next", "skip")] });
  const [trigger, additional] = report.split("## Additional information");
  assert.match(trigger, /Newly discovered models[\s\S]*`openai\/new` \| \*\*✅ Add\*\*/u);
  assert.match(trigger, /`openai\/skipped-next` \| \*\*⏭️ Skip\*\*/u);
  assert.match(trigger, /comment on this PR/u);
  assert.doesNotMatch(report, /<summary>New models|rolling.*issue/u);
  assert.match(additional, /Older snapshot/u);
});

test("candidates: new IDs are priced individually, unsupported formats do not hide supported models", () => {
  const page = fixture("openai.md");
  const candidates = collectCandidates({ newModels: [{ provider: "openai", ids: ["gpt-6-astra", "omni-moderation-latest"] }], official: { openai: { text: page } }, lists: noLists, today });
  assert.equal(candidates[0].price.input, 10);
  assert.equal(candidates[0].price.long_context_threshold, 272000);
  assert.equal(candidates[1].price, undefined);
  assert.match(candidates[1].problem, /Unsupported public pricing:.*Free/u);
  assert.deepEqual(catalogRates({ input: 1, output: 2, upcoming: [{ date: "2027-01-01", field: "input", value: 3 }] }), { input: 1, output: 2 });
});

test("commands: explicit actions, nested IDs, bounded batches, no executable syntax", () => {
  assert.deepEqual(parseCommands("/models add together/Qwen/Qwen3.8-Flash\n/models skip openai/gpt-4o Old model"), [
    { action: "add", provider: "together", model: "Qwen/Qwen3.8-Flash" }, { action: "skip", provider: "openai", model: "gpt-4o", reason: "Old model" },
  ]);
  for (const body of ["", "/models skip openai/a", "/models add openai/a reason", "/models add openai/$(id)", "/models add unknown/a", "/models add openai/a\n/models skip openai/a why", "/models add openai/a\nrun me"]) assert.throws(() => parseCommands(body));
  assert.throws(() => parseCommands(`/models add openai/${"a".repeat(9000)}`), /8,000/u);
});

test("candidates: hosted models retain confirmed authors, including the official table's organization", () => {
  const candidates = collectCandidates({ newModels: [{ provider: "together", ids: ["moonshotai/Kimi-K3", "zai-org/GLM-5.3"] }, { provider: "cerebras", ids: ["qwen-3.8-27b"] }],
    official: { together: { text: fixture("together.md") }, cerebras: { text: fixture("cerebras.json") } }, lists: noLists, today });
  assert.deepEqual(candidates.map(({ price }) => price.author), ["Moonshot AI", "Z.ai", "Alibaba"]);
});

test("catalog additions: preserve original entries, whole prices and integer thresholds", () => {
  const added = addModels(text, [{ provider: "openai", model: "new", price: { input: 2, output: 10 } }]);
  assert.match(added, /"new": \{ "input": 2\.0, "output": 10\.0 \}/u);
  assert.ok(added.includes('    "old": { "input": 1.0, "output": 2.0 }'));
  const long = addModels(added, [{ provider: "openai", model: "long", price: { input: 2, output: 10, long_context_threshold: 272000, long_input: 4, long_output: 15 } }]);
  assert.match(long, /"long_context_threshold": 272000,/u);
  assert.doesNotMatch(long, /272000\.0/u);
  assert.deepEqual(JSON.parse(long).openai.old, { input: 1, output: 2 });
  assert.throws(() => addModels(long, [{ provider: "openai", model: "old", price: { input: 9, output: 9 } }]), /already exists/u);
});

test("classifier: OpenAI-compatible bounded request; credentials only in headers; no tools", async () => {
  const calls = [];
  const classify = createClassifier({ ...apiSettings, fetcher: async (url, options) => {
    calls.push([url, options]); return response([{ id: "openai/new", action: "add", reason: "Useful current model." }]);
  } });
  assert.deepEqual(await classify([candidate("new")], context), [choice("new")]);
  const [url, options] = calls[0];
  const payload = JSON.parse(options.body);
  assert.equal(url, apiSettings.url);
  assert.equal(options.headers.authorization, `Bearer ${apiSettings.key}`);
  assert.equal(options.redirect, "error");
  assert.equal(payload.model, "gpt-6-luna");
  assert.equal(payload.reasoning_effort, "none");
  assert.equal(payload.max_completion_tokens, 4096);
  assert.equal(payload.store, false);
  assert.equal(payload.tools, undefined);
  assert.equal(payload.response_format.json_schema.strict, true);
  assert.deepEqual(payload.response_format.json_schema.schema.properties.decisions.items.properties.id.enum, ["openai/new"]);
  assert.ok(!options.body.includes(apiSettings.key));
});

test("classifier: rejects omissions, duplicates, invented models, prices and malformed reasons", async () => {
  for (const decisions of [[], [{ id: "openai/other", action: "add", reason: "x" }], [{ id: "openai/new", action: "pending", reason: "x" }],
    [{ id: "openai/new", action: "add", reason: "x", price: 0 }], [{ id: "openai/new", action: "add", reason: "" }], [{ id: "openai/new", action: "add", reason: "x".repeat(501) }]]) {
    await assert.rejects(createClassifier({ ...apiSettings, fetcher: async () => response(decisions) })([candidate("new")], context));
  }
  await assert.rejects(createClassifier({ ...apiSettings, fetcher: async () => response([{ id: "openai/new", action: "add", reason: "x" }, { id: "openai/new", action: "skip", reason: "y" }]) })([candidate("new"), candidate("other")], context), /duplicate/u);
  for (const bad of [{ ...choice("new"), model: null }, { ...choice("new"), input: 0 }, choice("$(id)")]) assert.throws(() => validateChoices([bad]));
});

test("classifier: refusal, truncation and error bodies never leak the key", async () => {
  const responses = [
    response([], { choices: [{ finish_reason: "length", message: { content: "{}" } }] }),
    response([], { choices: [{ finish_reason: "stop", message: { content: "{}", refusal: "No" } }] }),
    new Response(apiSettings.key, { status: 401 }), new Response(apiSettings.key), new Response("not JSON"),
  ];
  for (const result of responses) await assert.rejects(createClassifier({ ...apiSettings, fetcher: async () => result })([candidate("new")], context), (error) => !error.message.includes(apiSettings.key));
  await assert.rejects(createClassifier({ ...apiSettings, fetcher: async () => { throw new Error(apiSettings.key); } })([candidate("new")], context), /failed or timed out/u);
  assert.throws(() => createClassifier({ ...apiSettings, url: "http://example.com/v1/chat/completions" }), /HTTPS/u);
});

test("recommendations: unsupported metering skips deterministically without paying for AI", async () => {
  let calls = 0;
  const result = await recommendModels([candidate("unsupported", null)], { classify: async () => { calls++; }, context });
  assert.equal(calls, 0);
  assert.equal(result.choices[0].action, "skip");
  assert.equal(result.choices[0].origin, "rules");
  assert.match(result.choices[0].reason, /supported public rates/u);
});

test("recommendations: cache suggestions and preserve manual overrides on daily reruns", async () => {
  let calls = 0;
  const candidates = [candidate("new"), candidate("other")];
  const previous = [choice("new"), choice("other", "skip")];
  const override = choice("new", "skip", "manual", "Not useful for our apps.");
  const options = { context, classify: async () => { calls++; throw new Error("Must not call"); } };
  const result = await recommendModels(candidates, { ...options, previous, overrides: [override] });
  assert.deepEqual(result.choices, [override, previous[1]]);
  assert.deepEqual((await recommendModels(candidates, { ...options, previous: result.choices })).choices, result.choices);
  assert.equal(calls, 0);
  await assert.rejects(recommendModels([candidate("unsupported", null)], { ...options, overrides: [choice("unsupported", "add", "manual")] }), /supported public rates/u);
  await assert.rejects(recommendModels(candidates, { ...options, overrides: [choice("unknown", "skip", "manual")] }), /current discovery/u);
});

test("recommendations: one failed batch leaves every fresh suggestion pending, with cached choices retained", async () => {
  const candidates = Array.from({ length: 26 }, (_, index) => candidate(`m-${index}`));
  let calls = 0;
  const result = await recommendModels([candidate("saved"), ...candidates], { previous: [choice("saved")], context, classify: async (batch) => {
    calls++;
    if (calls === 2) throw new Error("HTTP 429");
    return batch.map(({ model }) => choice(model));
  } });
  assert.equal(calls, 2);
  assert.equal(result.choices[0].action, "add");
  assert.ok(result.choices.slice(1).every(({ action }) => action === "pending"));
  assert.equal(result.error, "HTTP 429");
});

test("recommendations: preview avoids inference; missing configuration stays pending and fails a normal run", async () => {
  const preview = await recommendModels([candidate("new")], { context, preview: true });
  assert.equal(preview.error, undefined);
  assert.equal(preview.choices[0].action, "pending");
  const normal = await recommendModels([candidate("new")], { context });
  assert.match(normal.error, /MODEL_REVIEW_API_URL/u);
  const retry = await recommendModels([candidate("new")], { context, previous: normal.choices, classify: async () => [choice("new")] });
  assert.equal(retry.choices[0].action, "add");
});

test("application: prices stay deterministic; additions and skip acknowledgements are reviewable", () => {
  const candidates = [candidate("new", { input: 4, output: 10 }), candidate("skip")];
  const choices = [choice("new"), choice("skip", "skip")];
  const acknowledged = [{ key: "parser", reason: "Expected" }];
  const applied = applyChoices({ text, acknowledged, candidates, choices });
  assert.deepEqual(JSON.parse(applied.text).openai.new, { input: 4, output: 10 }, "uses fresh official rates, not cached AI data");
  assert.deepEqual(JSON.parse(applied.text).openai.old, { input: 1, output: 2 });
  assert.deepEqual(applied.acknowledged, [...acknowledged, { key: "openai/skip: not added", reason: "Useful current model." }]);
  assert.throws(() => applyChoices({ text, acknowledged, candidates: [...candidates, candidate("invalid", null)], choices: [choice("new"), choice("invalid")] }), /supported public rates/u);
  assert.equal(text.includes('"new"'), false, "invalid batch leaves the input unchanged");
  assert.throws(() => applyChoices({ text, acknowledged, candidates: [candidate("old")], choices: [choice("old", "skip")] }), /shipped catalog/u);
  const next = decide({ catalog: JSON.parse(applied.text), acknowledged: applied.acknowledged, official: { openai: { prices: new Map([["old", { input: 1, output: 2 }], ["new", { input: 4, output: 10 }], ["skip", { input: 1, output: 2 }]]) } }, lists: noLists, today });
  assert.deepEqual(next.newModels, [], "merged additions and skips do not repeatedly create PRs");
});

const repository = "maxceem/app-ai-gateway";
const pr = { number: 26, state: "open", user: { login: "github-actions[bot]" }, base: { ref: "main" }, head: { ref: "automation/update-models", sha: "a".repeat(40), repo: { full_name: repository } } };
const comment = { id: 456, body: "/models skip openai/new Not needed", user: { id: 1, login: "owner", type: "User" } };
const event = { action: "created", issue: { number: 26, pull_request: {} }, comment };

function harness(overrides = {}) {
  const calls = [], writes = [], outputs = [];
  const api = async (path, options = {}) => {
    calls.push([path, options]);
    if (options.method === "POST") return {};
    if (path === "pulls/26") return overrides.pr ?? pr;
    if (path === "issues/comments/456") return overrides.comment ?? comment;
    if (path.startsWith("collaborators/")) return { permission: overrides.permission ?? "admin" };
    if (path.startsWith("contents/")) return { encoding: "base64", content: Buffer.from(JSON.stringify(overrides.choices ?? [choice("new")])).toString("base64") };
    if (path.startsWith("pulls?")) return overrides.pulls ?? [pr];
    throw new Error(`Unexpected ${path}`);
  };
  return { calls, writes, outputs, options: { api, repository, reviewPath: "review.json", overridesPath: "overrides.json", write: async (...args) => writes.push(args), output: async (value) => outputs.push(value) } };
}

test("PR overrides: authorized comment stages data for the same PR, never checks out PR code", async () => {
  const h = harness();
  await prepareReview(event, h.options);
  assert.deepEqual(h.writes.map(([path]) => path), ["review.json", "overrides.json"]);
  assert.deepEqual(JSON.parse(h.writes[1][1]), [choice("new", "skip", "manual", "Not needed")]);
  assert.deepEqual(h.outputs, ["ready=true\n"]);
  assert.ok(h.calls.some(([path]) => path === `contents/${REVIEW_PATH}?ref=${pr.head.sha}`));
  assert.ok(h.calls.every(([path]) => !path.includes(".github") && !path.includes("scripts/update-models")));
});

test("PR overrides: unrelated issues, forks, branches, bots and stale permissions write nothing", async () => {
  for (const overrides of [{ pr: { ...pr, user: { login: "outsider" } } }, { pr: { ...pr, state: "closed" } }, { pr: { ...pr, head: { ...pr.head, ref: "other" } } }, { pr: { ...pr, head: { ...pr.head, repo: { full_name: "outsider/fork" } } } }, { permission: "read" }, { comment: { ...comment, user: { ...comment.user, type: "Bot" } } }, { comment: { ...comment, user: { ...comment.user, id: 2 } } }]) {
    const h = harness(overrides);
    await prepareReview(event, h.options);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.outputs, []);
    assert.ok(h.calls.every(([, options]) => options.method !== "POST"));
  }
  const h = harness();
  await prepareReview({ ...event, issue: { number: 26 } }, h.options);
  assert.deepEqual(h.calls, []);
  assert.equal(trustedPull(pr, repository), true);
});

test("PR overrides: invalid second choice leaves all data untouched and explains the error", async () => {
  const h = harness({ comment: { ...comment, body: "/models add openai/new\n/models add openai/unknown" } });
  await assert.rejects(prepareReview(event, h.options), /no proposal/u);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.outputs, []);
  assert.ok(h.calls.some(([path, options]) => path === "issues/26/comments" && options.body.body.includes("not applied")));
});

test("PR state: loads only the bot's fixed review JSON at its immutable head SHA", async () => {
  const h = harness({ pulls: [{ ...pr, head: { ...pr.head, ref: "different" } }, pr] });
  assert.deepEqual(await loadReview(h.options), [choice("new")]);
  const bad = harness({ choices: [{ ...choice("new"), command: "execute this" }] });
  await assert.rejects(readReview(pr, bad.options), /Invalid/u);
  assert.deepEqual(await readReview(pr, { repository, api: async () => { throw Object.assign(new Error("Not found"), { status: 404 }); } }), []);
  assert.deepEqual(await loadReview(harness({ pulls: [] }).options), []);
});

test("report: proposal reasons are visible and inert; informative changes stay separate", () => {
  const report = renderReport({ changes: [], retirements: [], retired: [], deprecationNotes: [], attention: [], acknowledged: [], upcoming: [{ provider: "openai", model: "old", field: "input", value: 3, date: "2027-01-01" }], noSource: [], sources: [], newModels: [{ provider: "openai", ids: ["new"] }], modelChoices: [choice("new", "skip", "ai", "<script>[evil](url) | text")] });
  assert.doesNotMatch(report, /<script>|(?<!\\)\[evil\]/u);
  const [trigger, additional] = report.split("## Additional information");
  assert.match(trigger, /\*\*⏭️ Skip\*\*[\s\S]*gpt-6-luna/u);
  assert.doesNotMatch(trigger, /2027-01-01/u);
  assert.match(additional, /2027-01-01/u);
});

test("GitHub client: credentials stay in headers and comments are JSON, not commands", async () => {
  const calls = [];
  const api = githubClient(repository, apiSettings.key, async (url, options) => { calls.push([url, options]); return new Response("{}"); });
  await api("issues/26/comments", { method: "POST", body: { body: "$(do not execute)" } });
  assert.equal(calls[0][1].headers.authorization, `Bearer ${apiSettings.key}`);
  assert.equal(calls[0][1].body, '{"body":"$(do not execute)"}');
  assert.ok(!calls[0][0].includes(apiSettings.key));
});
