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

/** The organization has no active subscription; the caller should upsell. */
export const isPaymentRequired = (error: unknown) =>
  error instanceof ApiError && error.status === 402;

/**
 * Two error envelopes reach this client. The gateway wraps its own failures in
 * `{ error: { code, message } }`, while Better Auth answers `/v1/auth/*`
 * straight from better-call with a flat `{ code, message }` and SCREAMING_CASE
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
 * requires, so a cross-site request can never reach the admin API.
 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
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

  if (!response.ok) throw toApiError(response.status, payload);
  return payload as T;
}

export const api = {
  get: <T,>(path: string) => request<T>(path),
  post: <T,>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T,>(path: string, body: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  delete: <T,>(path: string) => request<T>(path, { method: "DELETE" }),
};

export function query(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}
