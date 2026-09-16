import { fail, origin, VERSION } from "./common.ts";
import type { CliErrorDetails } from "../../src/contracts/operation-schemas.ts";

export interface RequestOptions {
  key?: string | undefined;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface WireResponse {
  data: unknown;
}

/** The HTTP surface a `Transport` is built on; swapped out wholesale in tests. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** The two shapes a rejected request arrives in; both carry only public fields. */
interface WireError {
  error?: { code?: unknown; message?: unknown; data?: Record<string, unknown> };
  code?: unknown;
  message?: unknown;
}

/** How much of a deployment's own explanation is worth repeating. */
const MESSAGE_LIMIT = 300;

/** Every string the request carried, however deeply the body nested it. */
function* strings(value: unknown): Generator<string> {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const entry of value) yield* strings(entry);
  else if (value && typeof value === "object")
    for (const entry of Object.values(value)) yield* strings(entry);
}

/**
 * The deployment's own explanation of a refusal, made safe to print.
 *
 * Without it a caller cannot tell a duplicate slug from an unacceptable field,
 * which is the difference between changing the request and giving up. It is
 * remote text, so it is stripped of control characters, capped, and cleared of
 * anything the request itself sent — a refusal that quotes back a submitted
 * provider key must not turn into a key on stdout.
 */
export function reported(value: unknown, sent?: unknown): string {
  if (typeof value !== "string") return "";
  let text = value.replace(/\p{C}/gu, " ").replace(/\s+/g, " ").trim();
  for (const secret of strings(sent))
    if (secret.length >= 8) text = text.split(secret).join("[redacted]");
  return text.length > MESSAGE_LIMIT ? text.slice(0, MESSAGE_LIMIT) + "…" : text;
}

const RECOVERABLE_RESOURCE_CODES = ["resource_receipt_expired", "resource_key_unavailable"];
const RECOVERABLE_RESOURCE_FIELDS = ["appId", "keyId", "providerId", "providerGatewayId"] as const;

export class Transport {
  private readonly fetch: FetchLike;

  constructor(fetchImpl: FetchLike = fetch) {
    this.fetch = fetchImpl;
  }

  async request(
    url: string,
    path: string,
    { key, method = "GET", body, headers = {} }: RequestOptions = {},
  ): Promise<WireResponse> {
    const base = origin(url);
    if (!path.startsWith("/") || path.startsWith("//"))
      fail("invalid_request", "Invalid API path.");
    let response: Response;
    try {
      response = await this.fetch(base + path, {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(30000),
        headers: {
          accept: "application/json",
          "user-agent": `agw/${VERSION}`,
          ...(body ? { "content-type": "application/json" } : {}),
          ...(key ? { authorization: `Bearer ${key}` } : {}),
          ...headers,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      fail(
        "connection_failed",
        "Could not reach the selected deployment.",
        "Check connectivity and the selected URL; no fallback was attempted.",
        3,
      );
    }
    if (response.status >= 300 && response.status < 400)
      fail(
        "redirect_refused",
        "API redirects are refused to keep credentials bound to their origin.",
        "Connect explicitly to the intended deployment.",
        3,
      );
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      fail(
        "invalid_response",
        "Deployment returned an invalid JSON response.",
        "Check deployment version and connectivity.",
        3,
      );
    }
    if (!response.ok) {
      const wire: WireError = (data ?? {}) as WireError;
      const code =
        typeof wire.error?.code === "string"
          ? wire.error.code
          : typeof wire.code === "string"
            ? wire.code
            : `http_${response.status}`;
      const details: CliErrorDetails = { status: response.status };
      if (RECOVERABLE_RESOURCE_CODES.includes(code)) {
        const reported = wire.error?.data ?? {};
        for (const field of RECOVERABLE_RESOURCE_FIELDS) {
          const value = reported[field];
          if (typeof value === "string") details[field] = value;
        }
      }
      const explanation = reported(wire.error?.message ?? wire.message, body);
      fail(
        code,
        `Deployment rejected the request (HTTP ${response.status})` +
          (explanation ? `: ${explanation}` : "."),
        response.status === 401
          ? "Run agw account login."
          : "Review command configuration and account status.",
        3,
        details,
      );
    }
    return { data };
  }
}
