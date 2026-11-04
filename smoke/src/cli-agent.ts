import { USER_AGENT } from "./client.ts";

/**
 * Preloaded into the CLI under test (`node --import`), so its calls name the
 * smoke checks after its own `agw/<version>`: `agw/1.4.0 agw-smoke/0.13.0`. A
 * deployment still records them as the CLI, with the CLI's version, and labels
 * them `smoke`. Done from outside rather than by the CLI, because the checks
 * also run published versions, and nothing else about a request changes.
 */
const fetchAsCli = globalThis.fetch;

globalThis.fetch = (input, init) => {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const agent = headers.get("user-agent");
  if (agent === null || !agent.startsWith("agw/")) return fetchAsCli(input, init);
  headers.set("user-agent", `${agent} ${USER_AGENT}`);
  return fetchAsCli(input, { ...init, headers });
};
