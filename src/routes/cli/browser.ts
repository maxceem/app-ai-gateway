import { completeProviderSubmission } from "./provider-handoff";
import { cliJson } from "./security";
import { GatewayError } from "../../core/errors";
import { enforceEndpointRateLimit } from "../../core/endpoint-rate-limit";
import { CliSubmissionRequestSchema } from "../../contracts/cli";
import type {
  CliBrowserDetailsResponse,
  CliBrowserSubmitResponse,
  CliOperationKind,
} from "../../contracts/cli";
import { providerSchemaBody } from "../admin/provider-shared";
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
import { completeIdentity } from "./identity-handoff";
import { proofMatches } from "./security";
import type { CliContext } from "./types";

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
  const input = providerSchemaBody(
    CliSubmissionRequestSchema,
    await cliJson(c.req.raw),
  );
  const row = await challenge(c);
  await enforceEndpointRateLimit(c.env, `submission:${row.id}`, 10, 60_000);
  if (row.expires_at <= Date.now())
    throw new GatewayError(410, "invalid_request", "Operation has expired");
  if (!(await proofMatches(input.submissionToken, row.submission_proof_hash)))
    throw new GatewayError(403, "forbidden", "Invalid submission proof");
  await assertAccountAccess(c.env, row.organization_id, row.kind === "claim" ? "claim" : "read");
  return { input, row };
}
export async function browserDetails(c: CliContext): Promise<Response> {
  const { row } = await verifiedSubmission(c);
  const state = await authState(c, true);
  const visiblePayload = JSON.parse(row.request_json) as Record<string, unknown>;
  for (const field of [
    "__requestHash",
    "expectedUpdatedAt",
    "expectedGatewayUpdatedAt",
  ])
    delete visiblePayload[field];
  return c.json({
    kind: row.kind as CliOperationKind,
    payload: visiblePayload,
    account: await accountLifecycle(c.env, row.organization_id),
    signedIn: state.assurance === "interactive",
    googleEnabled: googleAuthEnabled(c.env),
    expiresAt: new Date(row.expires_at).toISOString(),
  } satisfies CliBrowserDetailsResponse);
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

export async function browserSubmit(c: CliContext): Promise<Response> {
  const { row, input } = await verifiedSubmission(c);
  if (input.approve !== true)
    throw new GatewayError(
      400,
      "invalid_request",
      "Explicit approval is required",
    );
  if (row.kind === "claim") {
    if (typeof input.allowServiceAccess !== "boolean")
      throw new GatewayError(
        400,
        "invalid_request",
        "Choose whether to allow ongoing CLI access",
      );
    await completeIdentity(c, row, input.allowServiceAccess);
  } else {
    await completeProviderSubmission(c, row, input.secret);
  }
  return c.json({
    state: "completed",
    message: "Approved. Return to your CLI.",
  } satisfies CliBrowserSubmitResponse);
}
