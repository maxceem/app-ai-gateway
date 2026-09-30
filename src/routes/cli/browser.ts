import type { OperationBrowserCredential, OperationDetails } from "@maxceem/cf-auth";
import { cliJson } from "./security";
import { GatewayError } from "../../core/errors";
import { clientAddress, enforceEndpointRateLimit } from "../../core/endpoint-rate-limit";
import type { z } from "zod";
import { parseResourceEnvelope, type ResourceEnvelope } from "../../auth/operation-kinds";
import { CliBrowserRegisterRequestSchema } from "../../contracts/cli";
import type {
  CliBrowserDenyResponse,
  CliBrowserDetailsResponse,
  CliBrowserLookupResponse,
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
import {
  TARGET_SNAPSHOTS,
  type ClaimKind,
  type LoginKind,
  type OperationKind,
  type ResourceKind,
} from "./operation-kinds";
import { authState, operationEngine, runResourceOperation } from "./operations";
import { kindOf } from "./operation-rows";
import { approveClaim, approveLogin, loginOrganizations, pageRefusal } from "./identity-handoff";
import type { OperationInput } from "../catalog-router";
import type { CliContext } from "./types";

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
 * What a submission token is: a user code is eight characters, a proof at
 * least thirty-two, and the request schema admits nothing in between.
 */
function browserCredential(token: string): OperationBrowserCredential {
  return token.length < 32 ? { userCode: token } : { proof: token };
}

/** The step an approval page addresses, as the engine shows it, with the gateway's kind beside it. */
export type BrowserStep =
  | { details: OperationDetails; entry: ClaimKind }
  | { details: OperationDetails; entry: LoginKind }
  | { details: OperationDetails; entry: ResourceKind; envelope: ResourceEnvelope };

/**
 * The operation a browser submission proves it may act on, once
 * {@link assertConsoleOrigin} has passed and the body has been parsed.
 *
 * The engine judges the proof or the user code as it reads the step's details,
 * and that happens before the submission allowance is spent, so a stranger
 * guessing at proofs cannot lock the page out for its owner.
 */
export async function verifiedSubmission<Input extends CliBrowserProof>(c: CliContext, input: Input) {
  const credential = browserCredential(input.submissionToken);
  const viewer = await authState(c, true);
  const details = await (await operationEngine(c)).details({ id: c.req.param("id") ?? "", ...credential, viewer });
  if (details.state === "expired")
    throw new GatewayError(410, "invalid_request", "Operation has expired");
  await enforceEndpointRateLimit(c.env, "submission", details.id);
  if (details.organization)
    await assertAccountAccess(c.get("deployment"), c.env, details.organization.id, "read");
  const { entry } = kindOf(details.kind);
  let step: BrowserStep;
  switch (entry.type) {
    case "claim":
    case "login":
      step = { details, entry } as BrowserStep;
      break;
    case "resource":
      step = { details, entry, envelope: parseResourceEnvelope(details.payload) };
      break;
    default:
      throw new GatewayError(404, "not_found", "Operation was not found");
  }
  return { input, credential, step, viewer };
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
async function reviewSnapshots(
  c: CliContext,
  kind: ResourceKind,
  payload: Record<string, unknown>,
  organizationId: string,
): Promise<Record<string, unknown>> {
  const read = (table: keyof typeof TARGET_SNAPSHOTS, id: unknown) => typeof id === "string"
    ? c.env.DB.prepare(TARGET_SNAPSHOTS[table]).bind(id, organizationId).first<Record<string, unknown>>()
    : Promise.resolve(null);
  const target = kind.target === null ? null : await read(kind.target, payload.id);
  const gatewayId = payload.providerGatewayId ?? (kind.target === "provider" ? target?.providerGatewayId : undefined);
  const gateway = kind.target === "provider_gateway" ? null : await read("provider_gateway", gatewayId);
  return {
    ...payload,
    ...(target ? { snapshot: target } : {}),
    ...(gateway ? { gatewaySnapshot: gateway } : {}),
  };
}

export async function browserDetails(
  c: CliContext,
  { body }: OperationInput<"cliBrowserDetails">,
): Promise<CliBrowserDetailsResponse> {
  const { step, viewer: state } = await verifiedSubmission(c, body);
  const { details } = step;
  const login = step.entry.type === "login";
  const organizationId = details.organization?.id ?? null;
  return {
    kind: kindOf(details.kind).kind,
    payload: "envelope" in step
      ? await reviewSnapshots(c, step.entry, step.envelope.review ?? {}, organizationId ?? "")
      : {},
    account: organizationId === null || login ? null : await accountLifecycle(c.env, organizationId),
    // Named rather than reduced to a flag: the page shows who is about to
    // approve, so a person who is signed in as the wrong human can see it.
    viewer: details.viewer
      ? { name: details.viewer.user.name, email: details.viewer.user.email }
      : null,
    // The engine's verdict, from the kind's own `refusal`, so the button a
    // person is offered and the answer they would get from pressing it can
    // never disagree.
    blockedBy: pageRefusal(c, details.blockedBy),
    googleEnabled: googleAuthEnabled(c.env),
    expiresAt: details.expiresAt,
    userCode: details.userCode,
    client: login
      ? {
          label: details.client.label,
          os: details.client.meta?.os ?? null,
          ip: details.client.meta?.ip ?? null,
          requestedAt: details.createdAt,
        }
      : null,
    hasLoopbackRedirect: details.hasLoopbackRedirect,
    ...(login ? { organizations: loginOrganizations(state) } : {}),
  };
}

export async function browserRegister(c: CliContext): Promise<Response> {
  const { step, input } = await relayedSubmission(c, CliBrowserRegisterRequestSchema);
  // The one door an operation opens onto registration, and only the kinds
  // whose approver may have no sign-in here yet may open it. A claim admits its
  // one person even where registration is closed, and gives them no account of
  // their own, since the one being claimed is theirs; a login registers exactly
  // as the console's own sign-up would.
  if ((step.entry.type !== "claim" && step.entry.type !== "login") || step.details.state !== "pending")
    throw new GatewayError(403, "forbidden", "Registration is only available for a pending account claim or login");
  const options = step.entry.type === "claim" ? { claimRegistration: true } : { provisionRegistration: true };
  return (await identityAuthFor(c, options)).auth.api.signUpEmail({
    body: { email: input.email, password: input.password, name: input.name },
    headers: c.req.raw.headers,
    asResponse: true,
  });
}

export async function browserSubmit(
  c: CliContext,
  { body }: OperationInput<"cliBrowserSubmit">,
): Promise<CliBrowserSubmitResponse> {
  const { step, credential, input: { secret, organizationId } } = await verifiedSubmission(c, body);
  const { details } = step;
  if (step.entry.type === "claim") {
    await approveClaim(c, details, step.entry, credential);
    return outcomeFor(step.entry);
  }
  if (step.entry.type === "login") {
    const { redirectUrl } = await approveLogin(c, details, step.entry, credential, organizationId);
    return { ...outcomeFor(step.entry), ...(redirectUrl === null ? {} : { redirectUrl }) };
  }
  if (!("envelope" in step)) throw new GatewayError(500, "internal_error", "A stored operation does not match its kind");
  const kind = step.entry;
  if (kind.secret === "required" && secret === undefined)
    throw new GatewayError(400, "invalid_request", "A provider credential is required");
  // A step already approved is answered as approved, before its payload is
  // judged again. Only an approved one: a second person holding the link of a
  // step that was declined or retired must not be told their approval landed.
  switch (details.state) {
    case "pending":
      break;
    case "completed":
      return outcomeFor(kind);
    case "denied":
      throw new GatewayError(409, "operation_denied", "This request was declined; run the command again");
    case "retired":
      throw new GatewayError(409, "conflict", "This request was withdrawn; run the command again");
    case "expired":
      throw new GatewayError(410, "operation_expired", "Operation has expired");
  }
  const { review, sender } = step.envelope;
  if (!review || !sender || !details.organization)
    throw new GatewayError(500, "internal_error", "A stored operation does not match its kind");
  const engine = await operationEngine(c);
  await runResourceOperation(c, {
    id: details.id,
    // The write runs as the CLI that sent it; the engine rechecks that
    // credential, and its role, when it commits.
    actor: { organizationId: details.organization.id, ...sender },
    entry: kind,
    write: kind.prepare({ payload: review, secret }),
    browser: { credential, secret },
    settled: async () => (await engine.details({ id: details.id, ...credential })).state === "completed",
  });
  return outcomeFor(kind);
}

/**
 * Declines a browser step. Anyone holding the link may, signed in or not: a
 * person who did not start the request is exactly who should be able to say
 * so, and the CLI that did is told on its next poll.
 */
export async function browserDeny(
  c: CliContext,
  { body }: OperationInput<"cliBrowserDeny">,
): Promise<CliBrowserDenyResponse> {
  const { step, credential, viewer } = await verifiedSubmission(c, body);
  await (await operationEngine(c)).deny({ id: step.details.id, ...credential, actor: viewer });
  return { state: "denied", message: "Declined. You can close this tab; your CLI has been told." };
}

/**
 * The pending step a person typed the code of. Counted per network address
 * before anything is read, because eight characters are guessable in bulk and
 * a code is the whole of what a guess needs.
 */
export async function browserLookup(
  c: CliContext,
  { body }: OperationInput<"cliBrowserLookup">,
): Promise<CliBrowserLookupResponse> {
  await enforceEndpointRateLimit(c.env, "user_code", clientAddress(c.req.raw));
  const found = await (await operationEngine(c)).lookupByUserCode({ userCode: body.userCode });
  if (!found) return { found: false };
  return { found: true, id: found.id, kind: kindOf(found.kind).kind, expiresAt: found.expiresAt };
}
