import { cliJson, proofMatches } from "./security";
import { GatewayError } from "../../core/errors";
import { enforceEndpointRateLimit } from "../../core/endpoint-rate-limit";
import { CliSubmissionRequestSchema } from "../../contracts/cli";
import type { ParsedOperationRequest } from "../../contracts/catalog";
import type {
  CliApprovalRefusal,
  CliBrowserDetailsResponse,
  CliBrowserSubmitResponse,
  CliHandoffContinuation,
  CliOperationKind,
} from "../../contracts/cli";
import { parseRequest } from "../../management/validation";
import {
  accountLifecycle,
  assertAccountAccess,
} from "../../core/account-lifecycle";
import { googleAuthEnabled, identityAuthFor } from "../../auth/identity";
import { operationKind, TARGET_SNAPSHOTS, type OperationKind } from "./operation-kinds";
import { authState, browserOperation, runResourceOperation } from "./operations";
import { claimRefusal, completeIdentity } from "./identity-handoff";
import type { AuthState } from "@maxceem/cf-auth";
import type { OperationInput } from "../catalog-router";
import type { CliContext, OperationRow } from "./types";

/**
 * The page's copy of the verdict the submission endpoint will reach. Only a
 * claim asks anything of whoever holds the browser, so the button a person is
 * offered and the answer they would get from pressing it can never disagree.
 */
function refusalFor(row: OperationRow, state: AuthState): CliApprovalRefusal | null {
  return operationKind(row.kind).type === "claim"
    ? claimRefusal(state, row.organization_id!)
    : null;
}

/**
 * The whole of what the page says once the step is approved, keyed on where
 * the registry sends the person next: a claim ends with its approver holding a
 * console session for the account they just took, and every other kind was
 * opened by a command that is still running, whose terminal already has the
 * answer.
 */
const CONTINUATION_MESSAGE: Record<CliHandoffContinuation, string> = {
  console: "This account is yours.",
  cli: "You can close this tab and return to your CLI.",
};

function outcomeFor(kind: OperationKind): CliBrowserSubmitResponse {
  return {
    state: "completed",
    message: CONTINUATION_MESSAGE[kind.continueTo],
    continueTo: kind.continueTo,
  };
}

/**
 * Refuses a browser endpoint reached other than from the first-party approval
 * page. Runs before the body is read, so a request from anywhere else learns
 * nothing about what it sent.
 */
export function assertConsoleOrigin(c: CliContext): void {
  const consoleOrigin = c.get("deployment").identity().consoleOrigin;
  if (new URL(c.req.url).origin !== consoleOrigin)
    throw new GatewayError(404, "not_found", "Page was not found");
  if (c.req.header("origin") !== consoleOrigin)
    throw new GatewayError(403, "forbidden", "Use the first-party approval page");
}

/**
 * The operation a browser submission proves it may act on, once
 * {@link assertConsoleOrigin} has passed and the body has been parsed.
 */
export async function verifiedSubmission(c: CliContext, input: ParsedOperationRequest<"cliBrowserSubmit">) {
  const row = await browserOperation(c);
  if (row.state === "pending" && row.expires_at <= Date.now())
    throw new GatewayError(410, "invalid_request", "Operation has expired");
  if (!(await proofMatches(input.submissionToken, row.browser_proof_hash)))
    throw new GatewayError(403, "forbidden", "Invalid submission proof");
  await enforceEndpointRateLimit(c.env, "submission", row.id);
  await assertAccountAccess(c.get("deployment"), c.env, row.organization_id!, "read");
  return { input, row };
}

/**
 * The same verification for the two relayed endpoints, which are not mounted
 * through the catalog router and so check the origin and read the body here.
 */
export async function relayedSubmission(c: CliContext) {
  assertConsoleOrigin(c);
  return verifiedSubmission(c, parseRequest(CliSubmissionRequestSchema, await cliJson(c.req.raw)));
}

/**
 * The rows a step's payload names, as they stand now: the one it edits, and
 * the provider gateway it routes through. The write itself is pinned by the
 * payload's own revision, so what is shown here is what it will be judged
 * against.
 */
async function reviewSnapshots(
  c: CliContext,
  row: OperationRow,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const kind = operationKind(row.kind);
  if (kind.type !== "resource") return {};
  const read = (table: keyof typeof TARGET_SNAPSHOTS, id: unknown) => typeof id === "string"
    ? c.env.DB.prepare(TARGET_SNAPSHOTS[table]).bind(id, row.organization_id).first<Record<string, unknown>>()
    : Promise.resolve(null);
  const target = kind.target === null ? null : await read(kind.target, payload.id);
  const gatewayId = payload.providerGatewayId ?? (kind.target === "provider" ? target?.providerGatewayId : undefined);
  const gateway = kind.target === "provider_gateway" ? null : await read("provider_gateway", gatewayId);
  return {
    ...(target ? { snapshot: target } : {}),
    ...(gateway ? { gatewaySnapshot: gateway } : {}),
  };
}

export async function browserDetails(
  c: CliContext,
  { body }: OperationInput<"cliBrowserDetails">,
): Promise<CliBrowserDetailsResponse> {
  const { row } = await verifiedSubmission(c, body);
  const state = await authState(c, true);
  const payload = row.request_json ? JSON.parse(row.request_json) as Record<string, unknown> : {};
  return {
    kind: row.kind as CliOperationKind,
    payload: { ...payload, ...(await reviewSnapshots(c, row, payload)) },
    account: await accountLifecycle(c.env, row.organization_id!),
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
  const { row, input } = await relayedSubmission(c);
  // The one door an operation opens onto registration, and only the kind whose
  // approver is expected to have no account yet may open it.
  if (operationKind(row.kind).type !== "claim" || row.state !== "pending")
    throw new GatewayError(403, "forbidden", "Registration is only available for a pending account claim");
  if (!input.email || !input.password || !input.name)
    throw new GatewayError(400, "invalid_request", "Name, email and password are required");
  return (await identityAuthFor(c, { claimRegistration: true })).auth.api.signUpEmail({
    body: { email: input.email, password: input.password, name: input.name },
    headers: c.req.raw.headers,
    asResponse: true,
  });
}

export async function browserSubmit(
  c: CliContext,
  { body }: OperationInput<"cliBrowserSubmit">,
): Promise<CliBrowserSubmitResponse> {
  const { row, input } = await verifiedSubmission(c, body);
  if (input.approve !== true)
    throw new GatewayError(400, "invalid_request", "Explicit approval is required");
  const kind = operationKind(row.kind);
  if (kind.type === "claim") {
    await completeIdentity(c, row);
    return outcomeFor(kind);
  }
  if (kind.type !== "resource")
    throw new GatewayError(400, "invalid_request", "This operation has no browser step");
  const secret = input.secret;
  if (secret !== undefined && !secret.trim())
    throw new GatewayError(400, "invalid_request", "A nonempty credential is required");
  if (kind.secret === "required" && secret === undefined)
    throw new GatewayError(400, "invalid_request", "A provider credential is required");
  // A step already approved is answered as approved, before its payload is
  // judged again.
  if (row.state !== "pending") return outcomeFor(kind);
  await runResourceOperation(c, row, kind, kind.prepare({
    payload: row.request_json ? JSON.parse(row.request_json) as Record<string, unknown> : {},
    secret,
  }));
  return outcomeFor(kind);
}
