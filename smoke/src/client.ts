import release from "../../package.json" with { type: "json" };

/**
 * The name the checks give themselves wherever a client names itself: the
 * `user-agent` of their own requests, their MCP client's declared name, and a
 * product after the CLI's own when they run it (`./cli-agent.ts`). A
 * deployment that records management analytics labels every call naming it
 * `smoke`, so its own checks can be told apart from its accounts' use.
 */
export const SMOKE_CLIENT = "agw-smoke";

/** The release these checks belong to, so the calls of an older release's checks can be told apart. */
export const SMOKE_VERSION: string = release.version;

export const USER_AGENT = `${SMOKE_CLIENT}/${SMOKE_VERSION}`;
