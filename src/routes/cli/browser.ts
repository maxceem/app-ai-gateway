import { completeProviderSubmission } from "./provider-handoff";
import { cliJson } from "./security";
import { GatewayError } from "../../core/errors";
import { enforceEndpointRateLimit } from "../../core/endpoint-rate-limit";
import { CliSubmissionRequestSchema } from "../../contracts/cli";
import type {
  CliApprovalRefusal,
  CliBrowserDetailsResponse,
  CliBrowserSubmitResponse,
  CliHandoffContinuation,
  CliOperationKind,
} from "../../contracts/cli";
import { schemaBody } from "../../management/validation";
import {
  accountLifecycle,
  assertAccountAccess,
} from "../../core/account-lifecycle";
import { googleAuthEnabled, identityAuthFor } from "../../auth/identity";
import { handoffKind, type HandoffKind } from "./handoff-kinds";
import { authState, challenge } from "./operations";
import { claimRefusal, completeIdentity } from "./identity-handoff";
import { proofMatches } from "./security";
import type { AuthState } from "@maxceem/cf-auth";
import type { CliContext, HandoffRow } from "./types";

/**
 * The page's copy of the verdict the submission endpoint will reach.
 *
 * Read from the same registry entry `browserSubmit` dispatches on, so the
 * button a person is offered and the answer they would get from pressing it
 * can never disagree. Only a claim asks anything of whoever holds the browser,
 * and the registry says which kind that is by the account access it demands of
 * the approving side.
 */
function refusalFor(row: HandoffRow, state: AuthState): CliApprovalRefusal | null {
  return handoffKind(row.kind).type === "claim"
    ? claimRefusal(state, row.organization_id)
    : null;
}

/**
 * The whole of what the page says once the handoff is approved.
 *
 * Keyed on where the registry sends the person next, because the two are the
 * same fact: a claim ends with its approver holding a console session for the
 * account they just took, since they created their sign-in on the approval
 * page moments before, so the console is where they continue and the sentence
 * tells them what they now have. Every other kind was opened by a command that
 * is still running, and the terminal already has the answer.
 */
const CONTINUATION_MESSAGE: Record<CliHandoffContinuation, string> = {
  console: "This account is yours.",
  cli: "You can close this tab and return to your CLI.",
};

function outcomeFor(kind: HandoffKind): CliBrowserSubmitResponse {
  return {
    state: "completed",
    message: CONTINUATION_MESSAGE[kind.continueTo],
    continueTo: kind.continueTo,
  };
}

export async function verifiedSubmission(c: CliContext) {
  const consoleOrigin = c.get("deployment").identity().consoleOrigin;
  if (new URL(c.req.url).origin !== consoleOrigin)
    throw new GatewayError(404, "not_found", "Page was not found");
  if (c.req.header("origin") !== consoleOrigin)
    throw new GatewayError(
      403,
      "forbidden",
      "Use the first-party approval page",
    );
  const input = schemaBody(
    CliSubmissionRequestSchema,
    await cliJson(c.req.raw),
  );
  const row = await challenge(c);
  if (row.expires_at <= Date.now())
    throw new GatewayError(410, "invalid_request", "Operation has expired");
  if (!(await proofMatches(input.submissionToken, row.submission_proof_hash)))
    throw new GatewayError(403, "forbidden", "Invalid submission proof");
  await enforceEndpointRateLimit(c.env, "submission", row.id);
  await assertAccountAccess(
    c.get("deployment"),
    c.env,
    row.organization_id,
    handoffKind(row.kind).view,
  );
  return { input, row };
}
export async function browserDetails(c: CliContext): Promise<CliBrowserDetailsResponse> {
  const { row } = await verifiedSubmission(c);
  const state = await authState(c, true);
  // The payload as the CLI sent it, beside the rows it was pinned to: the page
  // shows a person the change and what it changes, and never a revision or a
  // digest, which live in columns of their own.
  const snapshot = row.snapshot_json === null
    ? {}
    : JSON.parse(row.snapshot_json) as { target?: unknown; gateway?: unknown };
  return {
    kind: row.kind as CliOperationKind,
    payload: {
      ...(JSON.parse(row.request_json) as Record<string, unknown>),
      ...(snapshot.target === undefined ? {} : { snapshot: snapshot.target }),
      ...(snapshot.gateway === undefined ? {} : { gatewaySnapshot: snapshot.gateway }),
    },
    account: await accountLifecycle(c.env, row.organization_id),
    // Named rather than reduced to a flag: the page shows who is about to
    // approve, so a person who is signed in as the wrong human can see it.
    viewer:
      state.assurance === "interactive" && state.user?.kind === "human"
        ? { name: state.user.name, email: state.user.email }
        : null,
    blockedBy: refusalFor(row, state),
    googleEnabled: googleAuthEnabled(c.env),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}
export async function browserRegister(c: CliContext): Promise<Response> {
  const { row, input } = await verifiedSubmission(c);
  // The one door a handoff opens onto registration, and only the kind whose
  // approver is expected to have no account yet may open it.
  if (handoffKind(row.kind).type !== "claim" || row.consumed_at)
    throw new GatewayError(
      403,
      "forbidden",
      "Registration is only available for a pending account claim",
    );
  if (!input.email || !input.password || !input.name)
    throw new GatewayError(
      400,
      "invalid_request",
      "Name, email and password are required",
    );
  const response = await (await identityAuthFor(c, { claimRegistration: true })).auth.api.signUpEmail({
    body: { email: input.email, password: input.password, name: input.name },
    headers: c.req.raw.headers,
    asResponse: true,
  });
  return response;
}

export async function browserSubmit(c: CliContext): Promise<CliBrowserSubmitResponse> {
  const { row, input } = await verifiedSubmission(c);
  if (input.approve !== true)
    throw new GatewayError(
      400,
      "invalid_request",
      "Explicit approval is required",
    );
  // Which half of the package completes this handoff is the registry's answer:
  // a resource kind is a write, and the claim is settled by cf-auth.
  const kind = handoffKind(row.kind);
  if (kind.type === "resource") await completeProviderSubmission(c, row, input.secret);
  else await completeIdentity(c, row);
  return outcomeFor(kind);
}
