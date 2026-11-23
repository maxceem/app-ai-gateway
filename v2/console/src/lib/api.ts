import {
  CATALOG,
  operationPath,
  type OperationName,
  type OperationParams,
  type OperationQuery,
  type OperationRequest,
  type OperationResponse,
} from "@contracts/catalog";
import { isLeavingForAccountSwitch, switchTabAccount, tabAccount, withTabAccount } from "./tab-account";
import { CONSOLE_ACCOUNT_HEADER } from "@contracts/access";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const isUnauthorized = (error: unknown) => error instanceof ApiError && error.status === 401;

/** A read-only member tried to mutate, or lacks the role for a whole surface. */
export const isForbidden = (error: unknown) => error instanceof ApiError && error.status === 403;

/**
 * The organization has no active subscription; the caller should upsell.
 *
 * Matched on the status, not the code, so it holds for both the gateway's
 * `billing_payment_required` and any bare 402 the billing service returns.
 */
export const isPaymentRequired = (error: unknown) =>
  error instanceof ApiError && error.status === 402;

/**
 * Two error envelopes reach this client. The gateway wraps its own failures in
 * `{ error: { code, message } }`, while Better Auth answers its own routes
 * straight from better-call (under `/v2/auth`) with a flat `{ code, message }` and SCREAMING_CASE
 * codes. Normalizing both here keeps every caller on one `ApiError` shape.
 */
function toApiError(status: number, payload: unknown): ApiError {
  const body = (payload ?? {}) as {
    error?: { code?: string; message?: string };
    code?: string;
    message?: string;
  };
  const code = body.error?.code ?? body.code ?? "unknown";
  const message = body.error?.message
    ?? body.message
    ?? `Request failed with status ${status}`;
  return new ApiError(status, code, message);
}

/**
 * Every call rides the HttpOnly session cookie plus the header the Worker
 * requires, so a cross-site request can never reach the admin API. It also
 * names the account this tab acts in (`x-account-id`), so each tab keeps its
 * own account.
 *
 * Exported for `./auth`, which talks to Better Auth's own surface: those five
 * endpoints are the library's, not this gateway's, so they have no catalog
 * entry to be sent through.
 */
export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  // A page leaving for an account switch sends nothing more: the tab already
  // names the next account, which this page does not show.
  if (isLeavingForAccountSwitch()) {
    throw new ApiError(0, "account_switching", "The console is switching account; the page is reloading");
  }
  const headers = withTabAccount(new Headers(init.headers));
  headers.set("x-console-request", "1");
  if (init.body !== undefined) headers.set("content-type", "application/json");

  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  const text = await response.text();
  // An HTML error page or an empty body must not surface as a JSON SyntaxError.
  let payload: unknown = null;
  try {
    payload = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const error = toApiError(response.status, payload);
    // The account this tab uses is no longer the person's (removed from it
    // mid-session, say): the tab forgets it and reloads once, on the account
    // the session selects.
    const named = headers.get(CONSOLE_ACCOUNT_HEADER);
    if (error.code === "account_forbidden" && named !== null && named === tabAccount()) switchTabAccount(null);
    throw error;
  }
  return payload as T;
}

export interface CallOptions<K extends OperationName> {
  /** The `{name}` segments of the operation's path, if it has any. */
  params?: OperationParams<K>;
  query?: OperationQuery<K>;
  body?: OperationRequest<K>;
  headers?: HeadersInit;
  /** Cancels the request: a read nobody waits for any more is stopped, not left running. */
  signal?: AbortSignal;
}

/**
 * One documented operation, sent the console's way.
 *
 * The catalog entry supplies the method, the URL and both types, so no caller
 * writes a path or names a response type: changing a schema in `src/contracts`
 * produces an error at the call site instead of a surprise at runtime. The
 * transport itself — the cookie and `x-console-request` — is unchanged, and the
 * console still parses nothing, because the server is the one that validates.
 */
export function call<K extends OperationName>(
  name: K,
  { params, query, body, headers, signal }: CallOptions<K> = {},
): Promise<OperationResponse<K>> {
  // One cast, because `operationPath` takes the parameters this operation's own
  // template declares and a generic name stands for every template at once.
  const path = (operationPath as (
    name: OperationName,
    params?: Record<string, string>,
    query?: object,
  ) => string)(name, params as Record<string, string> | undefined, query as object | undefined);
  return request<OperationResponse<K>>(path, {
    method: CATALOG[name].method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(headers === undefined ? {} : { headers }),
    ...(signal === undefined ? {} : { signal }),
  });
}
