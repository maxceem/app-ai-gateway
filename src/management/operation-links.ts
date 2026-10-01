import type { OperationView } from "@maxceem/cf-auth";
import type { Deployment } from "../policy/deployment";

/** The console page an operation's browser step is approved on. */
export function browserPath(id: string): string {
  return `/cli/approve/${encodeURIComponent(id)}`;
}

/**
 * The link a person opens to approve a pending operation: the console's own
 * page, with the proof that lets whoever holds the link approve it in the
 * fragment, which no server and no referrer ever sees. Null for an operation
 * with no browser step, or one whose proof has already been spent.
 */
export function approvalUrl(
  deployment: Deployment,
  view: Pick<OperationView, "id" | "browserProof">,
): string | null {
  if (view.browserProof === null) return null;
  return `${deployment.identity().consoleOrigin}${browserPath(view.id)}#${view.browserProof}`;
}

/** The console page a person reveals a key an operation created on. */
export function revealPath(id: string): string {
  return `/reveal/${encodeURIComponent(id)}`;
}

/**
 * The link a person opens to reveal, once, the key an operation created. It
 * carries nothing but the operation's id: the person's own session, as an
 * owner or admin of the account, is the whole authority to reveal it.
 */
export function revealUrl(deployment: Deployment, id: string): string {
  return `${deployment.identity().consoleOrigin}${revealPath(id)}`;
}
