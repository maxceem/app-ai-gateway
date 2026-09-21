import { completeProviderSubmission } from "./provider-handoff";
import { cliJson } from "./security";
import { GatewayError } from "../../core/errors";
import { enforceEndpointRateLimit } from "../../core/endpoint-rate-limit";
import { CliSubmissionRequestSchema } from "../../contracts/cli";
import type {
  CliApprovalRefusal,
  CliBrowserDetailsResponse,
  CliBrowserSubmitResponse,
  CliOperationKind,
} from "../../contracts/cli";
import { schemaBody } from "../../management/validation";
import {
  accountLifecycle,
  assertAccountAccess,
} from "../../core/account-lifecycle";
import {
  createClaimRegistrationAuth,
  googleAuthEnabled,
} from "../../auth/identity";
import { deployment } from "./bootstrap";
import { authState, challenge } from "./operations";
import { claimRefusal, completeIdentity } from "./identity-handoff";
import { proofMatches } from "./security";
import type { AuthState } from "@maxceem/cf-auth";
import type { CliContext, HandoffRow } from "./types";

/**
 * The page's copy of the verdict the submission endpoint will reach.
 *
 * Kept on the same kind dispatch `browserSubmit` uses, so the button a person
 * is offered and the answer they would get from pressing it can never disagree.
 */
function refusalFor(row: HandoffRow, state: AuthState): CliApprovalRefusal | null {
  return row.kind === "claim" ? claimRefusal(state, row.organization_id) : null;
}

/**
 * What the page says once the handoff is approved, and where it sends the
 * person afterwards.
 *
 * On the same kind dispatch `refusalFor` uses, and for the same reason: what
 * each kind leaves behind is the gateway's knowledge. A claim ends with its
 * approver holding a console session for the account they just took, since
 * they created their sign-in on the approval page moments before, so the
 * console is where they continue. Every other kind was opened by a command
 * that is still running, and the terminal already has the answer.
 */
function outcomeFor(kind: CliOperationKind): CliBrowserSubmitResponse {
  return kind === "claim"
    ? {
        state: "completed",
        message: "This account is yours.",
        continueTo: "console",
      }
    : {
        state: "completed",
        message: "You can close this tab and return to your CLI.",
        continueTo: "cli",
      };
}

export async function verifiedSubmission(c: CliContext) {
  const meta = deployment(c);
  if (new URL(c.req.url).origin !== meta.consoleOrigin)
    throw new GatewayError(404, "not_found", "Page was not found");
  if (c.req.header("origin") !== meta.consoleOrigin)
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
  await assertAccountAccess(c.env, row.organization_id, row.kind === "claim" ? "claim" : "read");
  return { input, row };
}
export async function browserDetails(c: CliContext): Promise<CliBrowserDetailsResponse> {
  const { row } = await verifiedSubmission(c);
  const state = await authState(c, true);
  const visiblePayload = JSON.parse(row.request_json) as Record<string, unknown>;
  for (const field of [
    "__requestHash",
    "expectedRevision",
    "expectedGatewayRevision",
  ])
    delete visiblePayload[field];
  for (const field of ["snapshot", "gatewaySnapshot"]) {
    const snapshot = visiblePayload[field];
    if (snapshot && typeof snapshot === "object") {
      delete (snapshot as Record<string, unknown>).expectedRevision;
    }
  }
  return {
    kind: row.kind as CliOperationKind,
    payload: visiblePayload,
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
  if (row.kind !== "claim" || row.consumed_at)
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
  const response = await createClaimRegistrationAuth(
    c.env,
    c.req.url,
  ).auth.api.signUpEmail({
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
  if (row.kind === "claim") {
    await completeIdentity(c, row);
  } else {
    await completeProviderSubmission(c, row, input.secret);
  }
  return outcomeFor(row.kind as CliOperationKind);
}
