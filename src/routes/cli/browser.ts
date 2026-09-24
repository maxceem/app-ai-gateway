import { cliJson, proofMatches } from "./security";
import { GatewayError } from "../../core/errors";
import { enforceEndpointRateLimit } from "../../core/endpoint-rate-limit";
import type { z } from "zod";
import { CliBrowserRegisterRequestSchema } from "../../contracts/cli";
import type {
  CliApprovalRefusal,
  CliBrowserDetailsResponse,
  CliBrowserProof,
  CliBrowserSubmitResponse,
  CliHandoffContinuation,
} from "../../contracts/cli";
import { parseRequest } from "../../management/validation";
import {
  accountLifecycle,
  assertAccountAccess,
} from "../../core/account-lifecycle";
import { googleAuthEnabled, identityAuthFor } from "../../auth/identity";
import { TARGET_SNAPSHOTS, type OperationKind } from "./operation-kinds";
import { authState, browserOperation, runResourceOperation, type BrowserOperation } from "./operations";
import { claimRefusal, completeIdentity } from "./identity-handoff";
import type { AuthState } from "@maxceem/cf-auth";
import type { OperationInput } from "../catalog-router";
import type { CliContext } from "./types";

/**
 * The page's copy of the verdict the submission endpoint will reach. Only a
 * claim asks anything of whoever holds the browser, so the button a person is
 * offered and the answer they would get from pressing it can never disagree.
 */
function refusalFor(row: BrowserOperation, state: AuthState): CliApprovalRefusal | null {
  return row.family === "claim" ? claimRefusal(state, row.actor.organizationId) : null;
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
export async function verifiedSubmission<Input extends CliBrowserProof>(c: CliContext, input: Input) {
  const row = await browserOperation(c);
  if (row.state === "pending" && row.expiresAt <= Date.now())
    throw new GatewayError(410, "invalid_request", "Operation has expired");
  if (!(await proofMatches(input.submissionToken, row.browser.proofHash)))
    throw new GatewayError(403, "forbidden", "Invalid submission proof");
  await enforceEndpointRateLimit(c.env, "submission", row.id);
  await assertAccountAccess(c.get("deployment"), c.env, row.actor.organizationId, "read");
  return { input, row };
}

/**
 * The same verification for the two relayed endpoints, which are not mounted
 * through the catalog router and so check the origin and read the body here.
 */
export async function relayedSubmission<Schema extends z.ZodType<CliBrowserProof>>(c: CliContext, schema: Schema) {
  assertConsoleOrigin(c);
  return verifiedSubmission(c, parseRequest(schema, await cliJson(c.req.raw)));
}

/**
 * The rows a step's payload names, as they stand now: the one it edits, and
 * the provider gateway it routes through. The write itself is pinned by the
 * payload's own revision, so what is shown here is what it will be judged
 * against.
 */
async function reviewSnapshots(c: CliContext, row: BrowserOperation): Promise<Record<string, unknown>> {
  if (row.family !== "resource") return {};
  const { entry: kind, browser: { request: payload } } = row;
  const read = (table: keyof typeof TARGET_SNAPSHOTS, id: unknown) => typeof id === "string"
    ? c.env.DB.prepare(TARGET_SNAPSHOTS[table]).bind(id, row.actor.organizationId).first<Record<string, unknown>>()
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
  return {
    kind: row.kind,
    payload: { ...row.browser.request, ...(await reviewSnapshots(c, row)) },
    account: await accountLifecycle(c.env, row.actor.organizationId),
    // Named rather than reduced to a flag: the page shows who is about to
    // approve, so a person who is signed in as the wrong human can see it.
    viewer:
      state.assurance === "interactive" && state.user?.kind === "human"
        ? { name: state.user.name, email: state.user.email }
        : null,
    blockedBy: refusalFor(row, state),
    googleEnabled: googleAuthEnabled(c.env),
    expiresAt: new Date(row.expiresAt).toISOString(),
  };
}

export async function browserRegister(c: CliContext): Promise<Response> {
  const { row, input } = await relayedSubmission(c, CliBrowserRegisterRequestSchema);
  // The one door an operation opens onto registration, and only the kind whose
  // approver is expected to have no account yet may open it.
  if (row.family !== "claim" || row.state !== "pending")
    throw new GatewayError(403, "forbidden", "Registration is only available for a pending account claim");
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
  const { row, input: { secret } } = await verifiedSubmission(c, body);
  if (row.family === "claim") {
    await completeIdentity(c, row);
    return outcomeFor(row.entry);
  }
  const kind = row.entry;
  if (kind.secret === "required" && secret === undefined)
    throw new GatewayError(400, "invalid_request", "A provider credential is required");
  // A step already approved is answered as approved, before its payload is
  // judged again.
  if (row.state !== "pending") return outcomeFor(kind);
  await runResourceOperation(c, row, kind.prepare({ payload: row.browser.request, secret }));
  return outcomeFor(kind);
}
