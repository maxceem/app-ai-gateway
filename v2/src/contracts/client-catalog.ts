/**
 * The operations an app calls: health, app sign-in, `/me` and job polls. Kept apart from
 * the management operations so the Worker's entry module can mount these
 * without evaluating the management schemas (they are loaded on first use,
 * with the rest of the management code). `./catalog.ts` joins both.
 */
import { z } from "zod";
import {
  ApiKeyTokenRequestSchema,
  AppAttestChallengeResponseSchema,
  AppAttestFailureReportResponseSchema,
  AppAttestFailureReportSchema,
  AppAttestRegisterRequestSchema,
  AppAttestRegisterResponseSchema,
  AppAttestTokenRequestSchema,
  CurrentUserResponseSchema,
  GatewayTokenResponseSchema,
} from "./auth.ts";
import { HealthResponseSchema, type OperationSpec } from "./operation.ts";

const APP_PARAM = { app: { description: "The app id." } } as const;

/** Errors every app sign-in route can answer with. */
const SIGN_IN_ERRORS = {
  400: "The request is invalid.",
  403: "The app is disabled, or does not support this sign-in method.",
  404: "The app does not exist.",
  413: "The request body is too large.",
  429: "Too many sign-in calls to this app from this network address. Carries Retry-After.",
  503: "The gateway could not finish the check in time, or a platform service is briefly unavailable. Retry shortly.",
} as const;

const ISSUER_ERRORS = {
  403: "The proof or the issuer token was rejected, the challenge is invalid or used, the user is blocked, or the app does not support this sign-in method.",
  503: "The issuer's keys cannot be fetched, or the gateway could not finish the check in time. Retry shortly.",
} as const;

/** A provider's own answer about a job, passed on as it is. */
const JobAnswerSchema = z
  .record(z.string(), z.unknown())
  .meta({ id: "JobAnswer", description: "The provider's own answer, with its links pointing at the gateway." });

const JOB_ERRORS = {
  401: "A valid app key or gateway token is required, or the request must carry X-AppAttest-Proof.",
  403: "The App Attest proof was rejected or replayed, the user is blocked, or the app is disabled.",
  404: "The app does not exist, or no job with this id belongs to this app and user.",
  502: "The provider could not be reached, or its connection is disabled.",
  503: "The gateway could not finish the check in time. Retry shortly.",
} as const;

export const CLIENT_CATALOG = {
  getHealth: {
    method: "GET",
    path: "/v2/healthz",
    tags: ["Operations"],
    summary: "Check gateway health",
    security: "public",
    response: HealthResponseSchema,
    responseDescription: "The Worker is accepting requests.",
  },

  appAuthChallenge: {
    method: "POST",
    path: "/v2/apps/{app}/auth/challenge",
    params: APP_PARAM,
    tags: ["App sign-in"],
    summary: "Create an App Attest challenge",
    security: "public",
    response: AppAttestChallengeResponseSchema,
    responseDescription: "A five-minute, single-use challenge.",
    errors: SIGN_IN_ERRORS,
  },

  appAuthRegister: {
    method: "POST",
    path: "/v2/apps/{app}/auth/register",
    params: APP_PARAM,
    tags: ["App sign-in"],
    summary: "Register an App Attest key",
    security: "public",
    request: AppAttestRegisterRequestSchema,
    response: AppAttestRegisterResponseSchema,
    responseDescription: "The key was registered for the install, or for the issuer's user.",
    errors: { ...SIGN_IN_ERRORS, ...ISSUER_ERRORS },
  },

  appAuthFailure: {
    method: "POST",
    path: "/v2/apps/{app}/auth/failure",
    params: APP_PARAM,
    tags: ["App sign-in"],
    summary: "Report a failure on the device after a challenge",
    description:
      "Sent by the app when a step after the challenge failed on the device, so the app's auth events can say why. Diagnostic only. It must name a challenge this app issued that nothing has used yet, and uses it up, so one challenge carries at most one report.",
    security: "public",
    request: AppAttestFailureReportSchema,
    response: AppAttestFailureReportResponseSchema,
    responseDescription: "Whether a report was recorded for the challenge.",
    errors: SIGN_IN_ERRORS,
  },

  appAuthToken: {
    method: "POST",
    path: "/v2/apps/{app}/auth/token",
    params: APP_PARAM,
    tags: ["App sign-in"],
    summary: "Exchange a client proof for a gateway token",
    description:
      "App Attest clients send key_id, assertion and challenge; the answer's verify_on says whether requests sent with the token must also carry X-AppAttest-Proof. Server apps with an issuer send api_key and issuer_token. The verified issuer claim is always the user.",
    security: "public",
    request: z.union([AppAttestTokenRequestSchema, ApiKeyTokenRequestSchema]),
    response: GatewayTokenResponseSchema,
    responseDescription: "A gateway access token, valid for one hour.",
    errors: { ...SIGN_IN_ERRORS, ...ISSUER_ERRORS },
  },

  getCurrentUser: {
    method: "GET",
    path: "/v2/apps/{app}/me",
    params: APP_PARAM,
    tags: ["Application"],
    summary: "Get the current user",
    description:
      "Who the caller is. On App Attest apps, install_id names the install. Signed with X-AppAttest-Proof like every other request where the app signs every request.",
    security: "gateway",
    response: CurrentUserResponseSchema,
    responseDescription: "The caller's user id and install id.",
    errors: {
      401: "A valid app key or gateway token is required, or the request must carry X-AppAttest-Proof.",
      403: "The App Attest proof was rejected or replayed, or the app is disabled.",
      404: "The app does not exist, or identifies no end users.",
      503: "The gateway could not finish the check in time. Retry shortly.",
    },
  },

  getJobStatus: {
    method: "GET",
    path: "/v2/apps/{app}/jobs/{job}/status",
    params: { ...APP_PARAM, job: { description: "The job id the gateway returned when the job was submitted." } },
    tags: ["Jobs"],
    summary: "Get a job's status",
    description:
      "The provider's own status answer for a job submitted through the gateway, such as a fal queue job. Its polling links point at the gateway, and its request id is the gateway's job id. Polls are free: they use no request limit and no plan allowance.",
    security: "gateway",
    response: JobAnswerSchema,
    responseDescription: "The provider's status answer, passed on with its status code.",
    errors: JOB_ERRORS,
  },

  getJobResult: {
    method: "GET",
    path: "/v2/apps/{app}/jobs/{job}",
    params: { ...APP_PARAM, job: { description: "The job id the gateway returned when the job was submitted." } },
    tags: ["Jobs"],
    summary: "Get a job's result",
    description:
      "The provider's own result answer, passed on as it is. A final result settles the job's charge to what the provider billed. Polls are free: they use no request limit and no plan allowance.",
    security: "gateway",
    response: JobAnswerSchema,
    responseDescription: "The provider's result answer, passed on with its status code.",
    errors: JOB_ERRORS,
  },

  cancelJob: {
    method: "PUT",
    path: "/v2/apps/{app}/jobs/{job}/cancel",
    params: { ...APP_PARAM, job: { description: "The job id the gateway returned when the job was submitted." } },
    tags: ["Jobs"],
    summary: "Cancel a job",
    description:
      "Asks the provider to cancel a job submitted through the gateway, and passes its answer on. A cancelled job ends in one of three ways, whether it is cancelled here or at the provider directly: a queued job the provider confirms with no billed units costs nothing; a cancel or failure the provider bills is charged at the job's saved rate, by the reported units or as one job for a flat price per job; and if the provider's billed units cannot be read, the estimate stays. Free: it uses no request limit and no plan allowance.",
    security: "gateway",
    response: JobAnswerSchema,
    responseDescription: "The provider's answer to the cancel, passed on with its status code.",
    errors: { ...JOB_ERRORS, 404: "The app does not exist, no job with this id belongs to this app and user, or its provider cannot cancel jobs." },
  },
} as const satisfies Readonly<Record<string, OperationSpec>>;

export type ClientOperationName = keyof typeof CLIENT_CATALOG;
export type ClientOperationResponse<K extends ClientOperationName> = z.output<(typeof CLIENT_CATALOG)[K]["response"]>;

/** A catalog path in Hono's syntax: `{app}` becomes `:app`. */
export function honoPath(path: string): string {
  return path.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, ":$1");
}
