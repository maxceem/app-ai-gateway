/**
 * ElevenLabs' refused paths, checked against every operation of its API
 * (`test/fixtures/elevenlabs-operations.json`, written by
 * `scripts/elevenlabs-operations.ts` from ElevenLabs' OpenAPI document).
 *
 * The refused set is closed (`src/providers/elevenlabs.ts`). `refusedBySet`
 * states it again, from the spec's own tags where they fit and from named
 * paths otherwise, so the two must agree on every operation, both ways: one
 * in the set that a listing reaches, and one outside it that is refused,
 * both fail. A refused rule that no operation matches fails too.
 */
import { describe, expect, it } from "vitest";
import operations from "./fixtures/elevenlabs-operations.json" with { type: "json" };
import { elevenlabs } from "../src/providers/elevenlabs.ts";
import { compilePassthrough, ProviderMatcher } from "../src/providers/matcher.ts";
import type { HttpMethod } from "../src/providers/operation.ts";
import { matchTemplate, parseTemplate } from "../src/providers/path.ts";

type Operation = readonly [method: string, path: string, tags: readonly string[]];
const OPERATIONS = operations as unknown as readonly Operation[];

/** Tags whose every operation is in the set: the account's admin, its history, its keys and single-use tokens. */
const REFUSED_TAGS = new Set(["workspace", "api-key", "speech-history", "Single Use Token"]);

const PARAM = "\\{[^}/]+\\}";

/** Whether an operation is in the closed set, worked out from the spec, not from the refused list. */
function refusedBySet(method: string, path: string, tags: readonly string[]): boolean {
  if (tags.some((tag) => REFUSED_TAGS.has(tag))) return true;
  const is = (pattern: string) => new RegExp(`^${pattern}$`, "u").test(path);
  const under = (prefix: string) => is(`${prefix}(/.*)?`);
  // The account and its admin, and billing actions.
  if (["/v1/user", "/v1/workspace", "/v1/workspaces", "/v1/service-accounts", "/v1/usage"].some(under)) return true;
  if (under("/v1/reception/reseller/workspaces") || under("/v1/reception/reseller/billing")) return true;
  if (method === "POST" && is(`/v1/productions/orders/${PARAM}/submit`)) return true;
  // Account-wide history.
  if (under("/v1/history") || under("/v1/audio-isolation/history")) return true;
  // Stored credentials.
  if (under("/v1/convai/secrets")) return true;
  if (method !== "GET" && under("/v1/convai/environment-variables")) return true;
  // Live-session tokens, until step 5c.
  if (["/v1/convai/conversation/token", "/v1/convai/conversation/get-signed-url", "/v1/convai/conversation/get_signed_url", "/v1/convai/realtime/client_secrets"].some(is)) return true;
  if (under("/v1/single-use-token")) return true;
  // The research: deleting voices, and the agent records themselves.
  if (method === "DELETE" && under("/v1/voices")) return true;
  if (is("/v1/convai/agents/create")) return true;
  if (method === "POST" && is(`/v1/convai/agents/${PARAM}/duplicate`)) return true;
  if (["PUT", "PATCH", "DELETE"].includes(method) && is(`/v1/convai/agents/${PARAM}`)) return true;
  return false;
}

/** The operation's path with each parameter filled. */
const concrete = (path: string) => path.replace(/\{[^}/]+\}/gu, "p1").replace(/^\//u, "");

describe("ElevenLabs refused paths, over every operation of its API", () => {
  const matcher = new ProviderMatcher(elevenlabs);

  it("has the whole API to judge", () => {
    expect(OPERATIONS.length).toBeGreaterThan(500);
  });

  it("refuses exactly the closed set, even when listed, and lets everything else be listed", () => {
    const wrong: string[] = [];
    for (const [method, path, tags] of OPERATIONS) {
      const sent = concrete(path);
      const passthrough = compilePassthrough([{ method: method as HttpMethod, path: sent }]);
      const refused = matcher.match(method, sent, { passthrough }).kind === "refused";
      const listedRefused = matcher.refusedCovering(passthrough[0]!) !== null;
      const expected = refusedBySet(method, path, tags);
      if (refused !== expected || listedRefused !== expected) {
        wrong.push(`${method} ${path} [${tags.join(", ")}]: expected ${expected ? "refused" : "allowed"}, served ${refused ? "refused" : "allowed"}, saved ${listedRefused ? "refused" : "allowed"}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("has no refused rule that matches no operation", () => {
    const dead = elevenlabs.refused.filter((entry) => {
      const rule = typeof entry === "string" ? { path: entry, methods: null } : entry;
      const template = parseTemplate(rule.path, { rest: true });
      return !OPERATIONS.some(
        ([method, path]) =>
          (rule.methods === null || (rule.methods as readonly string[]).includes(method)) &&
          matchTemplate(template, concrete(path).split("/"), { ignoreCase: true }) !== null,
      );
    });
    expect(dead).toEqual([]);
  });

  it.each([
    ["POST", "v1/voice-generation/generate-voice"],
    ["POST", "v1/convai/agents/p1/knowledge-base/rag-query"],
    ["GET", "v1/convai/knowledge-base/p1/dependent-agents"],
    ["POST", "v1/voices/add"],
    ["POST", "v1/text-to-voice/create-voice-from-preview"],
    ["DELETE", "v1/dubbing/p1"],
  ] as const)("lets %s %s be listed", (method, path) => {
    expect(matcher.match(method, path, { passthrough: compilePassthrough([{ method, path }]) })).toMatchObject({ kind: "passthrough" });
  });
});
