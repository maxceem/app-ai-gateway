/**
 * ElevenLabs' refused paths, checked against every operation of its API
 * (`test/fixtures/elevenlabs-operations.json`, written by
 * `scripts/elevenlabs-operations.ts` from ElevenLabs' OpenAPI document).
 *
 * The refused set is closed (`src/providers/elevenlabs.ts`). `refusedBySet`
 * states it again, from the spec's own tags where they fit and from named
 * paths otherwise, so the two must agree on every operation, both ways: one
 * in the set that a listing reaches, and one outside it that is refused,
 * both fail. Live-session token paths (plan D4) are refused the same way,
 * unless the listing opts in; then they, and only they, are reached. Each
 * parameter with an enum is tried with every value. A refused or token rule
 * that matches no real request of any operation fails too.
 */
import { describe, expect, it } from "vitest";
import operations from "./fixtures/elevenlabs-operations.json" with { type: "json" };
import { elevenlabs } from "../src/providers/elevenlabs.ts";
import { compilePassthrough, ProviderMatcher } from "../src/providers/matcher.ts";
import type { HttpMethod, ProviderDescription } from "../src/providers/operation.ts";
import { parseTemplate } from "../src/providers/path.ts";

type Operation = readonly [method: string, path: string, tags: readonly string[], enums?: Readonly<Record<string, readonly string[]>>];
const OPERATIONS = operations as unknown as readonly Operation[];

/** Tags whose every operation is in the set: the account's admin, its history and its keys. */
const REFUSED_TAGS = new Set(["workspace", "api-key", "speech-history"]);

const PARAM = "\\{[^}/]+\\}";

/** Whether an operation is in the closed set, worked out from the spec, not from the refused list. */
function refusedBySet(method: string, path: string, tags: readonly string[], sent: string): boolean {
  if (tags.some((tag) => REFUSED_TAGS.has(tag))) return true;
  if (liveTokenBySet(method, path, tags, sent)) return false;
  // A single-use token for a batch transcription is not for a live session.
  if (tags.includes("Single Use Token")) return true;
  const is = (pattern: string) => new RegExp(`^${pattern}$`, "u").test(path);
  const under = (prefix: string) => is(`${prefix}(/.*)?`);
  // The account and its admin (the team of a workspace too), and billing actions.
  if (["/v1/user", "/v1/workspace", "/v1/workspaces", "/v1/service-accounts", "/v1/usage", "/v1/reception/team"].some(under)) return true;
  if (under("/v1/reception/reseller/workspaces") || under("/v1/reception/reseller/billing")) return true;
  if (method === "POST" && is(`/v1/productions/orders/${PARAM}/submit`)) return true;
  // Account-wide history.
  if (under("/v1/history") || under("/v1/audio-isolation/history")) return true;
  // Stored credentials, and deleting an environment, which removes its values from every variable.
  if (under("/v1/convai/secrets")) return true;
  if (method !== "GET" && under("/v1/convai/environment-variables")) return true;
  if (method === "DELETE" && is(`/v1/convai/environments/${PARAM}`)) return true;
  // The research: deleting a voice, and writing agents and their settings.
  if (method === "DELETE" && is(`/v1/voices/${PARAM}`)) return true;
  if (is("/v1/convai/agents/create")) return true;
  if (method === "POST" && is(`/v1/convai/agents/${PARAM}/(duplicate|avatar)`)) return true;
  if (["POST", "DELETE"].includes(method) && is(`/v1/convai/agents/${PARAM}/hold-audio`)) return true;
  if (["PUT", "PATCH", "DELETE"].includes(method) && is(`/v1/convai/agents/${PARAM}`)) return true;
  if (method === "PATCH" && is(`/v1/reception/customer-facing-agents/${PARAM}`)) return true;
  // An agent's link answers with a shareable token that may never expire.
  if (method === "GET" && is(`/v1/convai/agents/${PARAM}/link`)) return true;
  return false;
}

/** The single-use token types that start a live session; `batch_scribe` is for a file transcription. */
const LIVE_TOKEN_TYPES = ["realtime_scribe", "tts_websocket"];

/**
 * Whether a request mints a secret for a live session (plan D4): its live
 * single-use tokens, the agent conversation token and signed URL, and its
 * Realtime client secret. `sent` is the request path, for the operations
 * whose enum decides it.
 */
function liveTokenBySet(method: string, path: string, tags: readonly string[], sent: string): boolean {
  const is = (pattern: string) => new RegExp(`^${pattern}$`, "u").test(path);
  if (tags.includes("Single Use Token")) return method === "POST" && LIVE_TOKEN_TYPES.some((type) => sent.endsWith(`/${type}`));
  if (method === "POST") return is("/v1/convai/realtime/client_secrets");
  return method === "GET" && ["/v1/convai/conversation/token", "/v1/convai/conversation/get-signed-url", "/v1/convai/conversation/get_signed_url"].some(is);
}

/**
 * Two unlike values for a parameter the spec leaves free, so a rule that
 * reaches only some values (`p{voice_id}` reaches `p1`) shows up.
 */
const FREE_VALUES = ["p1", "x9"];

/**
 * Every request path an operation stands for: each parameter filled with each
 * value its enum allows, or with each of `FREE_VALUES` where the spec allows any.
 */
function requestPaths(path: string, enums: Readonly<Record<string, readonly string[]>> = {}): string[] {
  let paths = [path.replace(/^\//u, "")];
  for (const name of [...path.matchAll(/\{([^}/]+)\}/gu)].map((found) => found[1]!)) {
    const values = enums[name] ?? FREE_VALUES;
    paths = paths.flatMap((one) => values.map((value) => one.replace(`{${name}}`, value)));
  }
  return paths;
}

type Rule = { readonly path: string; readonly methods: readonly string[] | null; readonly token: boolean; readonly method?: HttpMethod; readonly mint?: string };
/** A description's refused and live-session token paths, as one list of rules. */
const rulesOf = (description: ProviderDescription): Rule[] => [
  ...description.refused.map((entry) =>
    typeof entry === "string" ? { path: entry, methods: null, token: false } : { path: entry.path, methods: entry.methods, token: false },
  ),
  ...(description.liveTokens ?? []).map((entry) => ({
    path: entry.path,
    methods: null,
    token: true,
    method: entry.method,
    ...(entry.mint === undefined ? {} : { mint: entry.mint }),
  })),
];
/** The description with its refused and live-session token paths replaced by `rules`. */
const withRules = (description: ProviderDescription, rules: readonly Rule[]): ProviderDescription => ({
  ...description,
  refused: rules.filter((rule) => !rule.token).map((rule) => (rule.methods === null ? rule.path : { path: rule.path, methods: rule.methods as HttpMethod[] })),
  liveTokens: rules
    .filter((rule) => rule.token)
    .map((rule) => ({ path: rule.path, method: rule.method ?? "POST", ...(rule.mint === undefined ? {} : { mint: rule.mint }) })),
});

/**
 * Whether a refused rule can match a real request of a spec operation,
 * template against template: a rule's literal stands against a spec literal
 * equal to it, or a parameter whose enum holds it. A literal, or a part with
 * a prefix or suffix, facing a free parameter matches only some requests
 * anyone was told to make, so it does not count.
 */
function ruleReaches(rule: Rule, method: string, path: string, enums: Readonly<Record<string, readonly string[]>> = {}): boolean {
  if (rule.methods !== null && !rule.methods.includes(method)) return false;
  const template = parseTemplate(rule.path, { rest: true }).segments;
  const spec = path.replace(/^\//u, "").split("/");
  const rest = template[template.length - 1]?.kind === "rest";
  const fixed = rest ? template.slice(0, -1) : template;
  if (rest ? spec.length < fixed.length : spec.length !== fixed.length) return false;
  return fixed.every((segment, index) => {
    const piece = spec[index]!;
    const parameter = /^\{([^}/]+)\}$/u.exec(piece)?.[1];
    const fits = (value: string): boolean => {
      const lower = value.toLowerCase();
      if (segment.kind === "literal") return segment.value.toLowerCase() === lower;
      if (segment.kind !== "part") return false;
      const { prefix, suffix } = segment;
      return lower.length > prefix.length + suffix.length && lower.startsWith(prefix.toLowerCase()) && lower.endsWith(suffix.toLowerCase());
    };
    // A bare part reaches any value; a free parameter is reached only by one.
    if (segment.kind === "part" && segment.prefix === "" && segment.suffix === "") return true;
    if (parameter === undefined) return fits(piece);
    return (enums[parameter] ?? []).some(fits);
  });
}

/**
 * Every disagreement between a provider description's refused and
 * live-session token paths and the closed set, over the whole API, and every
 * rule that reaches no operation. A plain listing must be refused exactly on
 * the set and the token paths; a listing that opts in must reach exactly the
 * token paths, and may opt in only there.
 */
function judge(description: ProviderDescription): { wrong: string[]; dead: string[] } {
  const matcher = new ProviderMatcher(description);
  const wrong: string[] = [];
  for (const [method, path, tags, enums] of OPERATIONS) {
    for (const sent of requestPaths(path, enums)) {
      const refused = refusedBySet(method, path, tags, sent);
      const token = liveTokenBySet(method, path, tags, sent);
      const expected = refused || token;
      const passthrough = compilePassthrough([{ method: method as HttpMethod, path: sent }]);
      const served = matcher.match(method, sent, { passthrough }).kind === "refused";
      const saved = matcher.refusedCovering(passthrough[0]!) !== null;
      if (served !== expected || saved !== expected) {
        wrong.push(`${method} /${sent} [${tags.join(", ")}]: expected ${expected ? "refused" : "allowed"}, served ${served ? "refused" : "allowed"}, saved ${saved ? "refused" : "allowed"}`);
      }
      const optedIn = compilePassthrough([{ method: method as HttpMethod, path: sent, liveToken: true }]);
      const match = matcher.match(method, sent, { passthrough: optedIn });
      const reached = match.kind === "passthrough" && match.liveToken !== null;
      const mayOptIn = matcher.liveTokenCovering(optedIn[0]!) !== null;
      if (reached !== token || mayOptIn !== token) {
        wrong.push(`${method} /${sent} [${tags.join(", ")}] opted in: expected ${token ? "a live-session token" : "no token"}, served ${reached ? "reached" : "refused"}, opt-in ${mayOptIn ? "allowed" : "refused"}`);
      }
    }
  }
  // A token path is dead when it reaches no operation, or when its own mint does not.
  const mintOf = (rule: Rule): Rule => ({ path: rule.mint ?? rule.path.replace(/\/\*$/u, ""), methods: [rule.method ?? "POST"], token: true });
  const reaches = (rule: Rule) => OPERATIONS.some(([method, path, , enums]) => ruleReaches(rule, method, path, enums));
  const dead = rulesOf(description)
    .filter((rule) => !reaches(rule) || (rule.token && !reaches(mintOf(rule))))
    .map((rule) => `${rule.methods?.join(",") ?? "*"} ${rule.path}${rule.mint === undefined ? "" : ` (mint ${rule.mint})`}`);
  return { wrong, dead };
}

describe("ElevenLabs refused paths, over every operation of its API", () => {
  const matcher = new ProviderMatcher(elevenlabs);

  it("has the whole API to judge, with the values of enum parameters", () => {
    expect(OPERATIONS.length).toBeGreaterThan(500);
    expect(requestPaths("/v1/single-use-token/{token_type}", { token_type: ["realtime_scribe", "batch_scribe", "tts_websocket"] })).toEqual([
      "v1/single-use-token/realtime_scribe",
      "v1/single-use-token/batch_scribe",
      "v1/single-use-token/tts_websocket",
    ]);
  });

  it("refuses exactly the closed set, even when listed, and lets everything else be listed; every rule reaches an operation", () => {
    expect(judge(elevenlabs)).toEqual({ wrong: [], dead: [] });
  });

  it.each([
    ["a mint narrowed to a value no request names", (rules: Rule[]) => rules.map((rule) => (rule.mint === "v1/single-use-token/realtime_scribe" ? { ...rule, mint: "v1/single-use-token/p1" } : rule))],
    [
      "the single-use token namespace narrowed to its two mints",
      (rules: Rule[]) =>
        rules
          .filter((rule) => rule.path !== "v1/single-use-token/batch_scribe")
          .map((rule) => (rule.mint?.startsWith("v1/single-use-token/") === true ? { path: rule.mint, methods: null, token: true, method: "POST" as const } : rule)),
    ],
    [
      "every single-use token type treated as live",
      (rules: Rule[]) => [
        ...rules.filter((rule) => !rule.path.startsWith("v1/single-use-token/")),
        { path: "v1/single-use-token/*", methods: null, token: true, method: "POST" as const, mint: "v1/single-use-token/{token_type}" },
      ],
    ],
    ["voice deletion widened to collections and samples", (rules: Rule[]) => rules.map((rule) => (rule.path === "v1/voices/{voice_id}" ? { ...rule, path: "v1/voices/*" } : rule))],
    ["an agent's link left out", (rules: Rule[]) => rules.filter((rule) => rule.path !== "v1/convai/agents/{agent_id}/link")],
    ["voice deletion narrowed to ids with a prefix", (rules: Rule[]) => rules.map((rule) => (rule.path === "v1/voices/{voice_id}" ? { ...rule, path: "v1/voices/p{voice_id}" } : rule))],
  ])("fails when the list has %s", (_, mutate) => {
    const { wrong, dead } = judge(withRules(elevenlabs, mutate(rulesOf(elevenlabs))));
    expect(wrong.length + dead.length).toBeGreaterThan(0);
  });

  it.each([
    ["POST", "v1/voice-generation/generate-voice"],
    ["POST", "v1/convai/agents/p1/knowledge-base/rag-query"],
    ["POST", "v1/convai/agents/p1/simulate-conversation"],
    ["GET", "v1/convai/agents/p1"],
    ["GET", "v1/convai/knowledge-base/p1/dependent-agents"],
    ["POST", "v1/voices/add"],
    ["DELETE", "v1/voices/collections/c1"],
    ["DELETE", "v1/voices/collections/c1/voice/v1"],
    ["DELETE", "v1/voices/v1/samples/s1"],
    ["POST", "v1/text-to-voice/create-voice-from-preview"],
    ["DELETE", "v1/dubbing/p1"],
  ] as const)("lets %s %s be listed", (method, path) => {
    expect(matcher.match(method, path, { passthrough: compilePassthrough([{ method, path }]) })).toMatchObject({ kind: "passthrough" });
  });

  it.each([
    ["PATCH", "v1/reception/customer-facing-agents/a1"],
    ["POST", "v1/convai/agents/a1/avatar"],
    ["POST", "v1/convai/agents/a1/hold-audio"],
    ["DELETE", "v1/convai/agents/a1/hold-audio"],
    ["GET", "v1/convai/agents/a1/link"],
    ["DELETE", "v1/convai/environments/production"],
    ["POST", "v1/reception/team/invites"],
    ["PATCH", "v1/reception/team/members/u1"],
    ["POST", "v1/single-use-token/realtime_scribe"],
  ] as const)("refuses %s %s, even when listed", (method, path) => {
    expect(matcher.match(method, path, { passthrough: compilePassthrough([{ method, path }]) })).toMatchObject({ reason: "refused_path" });
  });

  it("reaches a live single-use token only with the opt-in, and never the batch transcription token", () => {
    for (const type of ["realtime_scribe", "tts_websocket"]) {
      const path = `v1/single-use-token/${type}`;
      expect(matcher.match("POST", path, { passthrough: compilePassthrough([{ method: "POST", path, liveToken: true }]) })).toMatchObject({ kind: "passthrough" });
    }
    for (const listed of ["v1/single-use-token/batch_scribe", "v1/single-use-token/{token_type}"]) {
      const passthrough = compilePassthrough([{ method: "POST", path: listed, liveToken: true }]);
      expect(matcher.match("POST", "v1/single-use-token/batch_scribe", { passthrough })).toMatchObject({ kind: "refused", reason: "refused_path" });
    }
  });

  // Requests the spec does not list, so the walk above cannot see them.
  it.each([
    ["GET", "v1/single-use-token/batch_scribe"],
    ["GET", "v1/single-use-token/realtime_scribe"],
    ["DELETE", "v1/single-use-token/tts_websocket"],
    ["POST", "v1/single-use-token/other_kind"],
    ["POST", "v1/single-use-token/realtime_scribe/extra"],
  ] as const)("keeps %s %s refused, listed or opted in, and on save", (method, path) => {
    for (const liveToken of [false, true]) {
      const passthrough = compilePassthrough([{ method, path, ...(liveToken ? { liveToken: true as const } : {}) }]);
      expect(matcher.match(method, path, { passthrough })).toMatchObject({ kind: "refused", reason: "refused_path" });
      expect(matcher.liveTokenCovering(passthrough[0]!)).toBeNull();
    }
    expect(matcher.refusedCovering(compilePassthrough([{ method, path }])[0]!)).not.toBeNull();
  });

  it("refuses an agent's link even when the listing opts in", () => {
    const path = "v1/convai/agents/a1/link";
    const passthrough = compilePassthrough([{ method: "GET", path, liveToken: true }]);
    expect(matcher.match("GET", path, { passthrough })).toMatchObject({ kind: "refused", reason: "refused_path" });
    expect(matcher.liveTokenCovering(passthrough[0]!)).toBeNull();
  });
});
