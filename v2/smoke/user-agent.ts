/**
 * The name the smoke checks give themselves, in one place: loaded before them
 * (`--import ./smoke/user-agent.ts`, as `pnpm run smoke` does), it makes every
 * `fetch` they send carry the `user-agent` `agw-smoke/<version>`, unless a
 * request names another on purpose. The MCP check declares the same name as
 * its client. A deployment that records management analytics labels all of
 * these `smoke`, so its own checks can be told apart from its accounts' use
 * (v1's convention).
 */
import release from "../package.json" with { type: "json" };

export const SMOKE_CLIENT = "agw-smoke";

export const USER_AGENT = `${SMOKE_CLIENT}/${release.version}`;

const WRAPPED = Symbol.for("agw-smoke.user-agent");

const scope = globalThis as typeof globalThis & { [WRAPPED]?: true };
if (scope[WRAPPED] === undefined) {
  scope[WRAPPED] = true;
  const plain = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has("user-agent")) headers.set("user-agent", USER_AGENT);
    return plain(input, { ...init, headers });
  };
}
