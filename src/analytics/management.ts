/**
 * The optional `MANAGEMENT_ANALYTICS` Analytics Engine dataset, and everything
 * this gateway ever writes to it.
 *
 * A deployment may bind a dataset of its own to learn how its accounts manage
 * the gateway — from the console, the API, the CLI or MCP — and how often each
 * of those is refused or fails, and why. The open-source deployment binds
 * nothing, and then nothing here runs: no header is read and no data point is
 * written.
 *
 * What is written is exactly {@link ManagementCall}, one data point per
 * management call: which account, which channel and credential, which
 * operation, and how it ended. A refusal is described by the constants this
 * codebase spells — its status, its `ErrorCode`, its granular `reason`, the
 * request field and schema issue a validation names — and never by its
 * message, which may quote what the caller sent. No credential, body, argument,
 * email address or name ever reaches the dataset. What a client says about
 * itself — its `user-agent`, an MCP client's declared name — is the caller's
 * to choose, so it is reduced to one of {@link KNOWN_CLIENTS} or `other`, and
 * of its version only the digits are kept. The data point
 * is built field by field from plain values, never by spreading an object, so
 * a field added anywhere else cannot ride along.
 *
 * Writing is synchronous and fire-and-forget: Analytics Engine buffers the
 * point and sends it after the response, its failure is only logged, and
 * nothing here can slow down or change a management call. It is never written
 * from the application request path.
 *
 * Keep this file free of anything else: it is the dataset's schema, and a query
 * written against it reads the blobs and doubles by the positions below.
 */
import { GatewayError } from "../core/errors";
import { errorFacts } from "../core/error-facts";
import { log } from "../core/log";
import { asGatewayError } from "../core/platform-errors";

/**
 * How the call reached the gateway: the console, the management API, the CLI,
 * or the MCP endpoint. Decided by the gateway from the surface and the
 * credential, except that `cli` is the API called by a client naming itself
 * `agw`, which only the CLI does.
 */
export type ManagementChannel = "console" | "api" | "cli" | "mcp";

/** `none` where no credential was presented, or none was resolved before the call was refused. */
export type ManagementCredential = "session" | "apiKey" | "oauth" | "none";

/** `refused` for a 4xx, the caller's to fix; `failed` for a 5xx, the gateway's. */
export type ManagementOutcome = "ok" | "refused" | "failed";

export interface ManagementCall {
  /** The account's id, or null when the call was refused before one was known. Random; carries no personal data. */
  accountId: string | null;
  channel: ManagementChannel;
  credential: ManagementCredential;
  /** `service` for an identity an agent provisioned, null where no identity was resolved. */
  identity: "human" | "service" | null;
  /** The catalog operation, or null where the call was refused before one was matched. */
  operation: string | null;
  /** The MCP tool called, on the `mcp` channel. */
  tool: string | null;
  /** The engine operation kind a CLI operation or an MCP tool opened, such as `app.create`. */
  kind: string | null;
  outcome: ManagementOutcome;
  status: number;
  /** The refusal's `ErrorCode`, or `internal_error` for a failure that is not one. Null on success. */
  code: string | null;
  /** The refusal's granular cause, where it has one. */
  reason: string | null;
  /** The top-level request field a validation refusal names. Never its value. */
  field: string | null;
  /** The schema's issue code for that field, such as `invalid_type`. */
  issue: string | null;
  /** Which known client called, such as `agw`, `claude-code` or `curl`; `other` for any client not on the list. */
  client: string | null;
  /** The client's version where it names one: the CLI's, or what an MCP client declares. */
  clientVersion: string | null;
  durationMs: number;
}

/** What a call's ending contributes to its data point. */
export type CallEnding = Pick<ManagementCall, "outcome" | "status" | "code" | "reason" | "field" | "issue">;

/** One bounded token: what a client name, an operation, a code or a kind is made of. */
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,63}$/;
/**
 * A version number, such as `1.4.0`, and whatever suffix follows it. Only the
 * digits are kept: a suffix such as `-beta.2` is free text and could spell
 * anything.
 */
const VERSION = /^(\d{1,6}(?:\.\d{1,6}){1,3})(?:[-+].*)?$/su;

/**
 * The clients worth telling apart, by the name they give themselves —
 * lowercased, spaces as hyphens — and the label recorded for each. A name is
 * the caller's to choose and could be anything, a key included, so only a
 * label spelled here is ever written; any other name is `other`.
 */
export const KNOWN_CLIENTS: Readonly<Record<string, string>> = {
  // The CLI, and the console's own browser.
  agw: "agw",
  mozilla: "browser",
  // HTTP tools and runtimes an agent or a script calls the API with.
  curl: "curl",
  wget: "wget",
  httpie: "httpie",
  postmanruntime: "postman",
  insomnia: "insomnia",
  "python-requests": "python-requests",
  "python-httpx": "python-httpx",
  "python-urllib": "python-urllib",
  python: "python",
  node: "node",
  undici: "node",
  "node-fetch": "node",
  axios: "axios",
  deno: "deno",
  bun: "bun",
  "go-http-client": "go",
  okhttp: "okhttp",
  "java-http-client": "java",
  dart: "dart",
  // MCP clients, by the names they declare.
  "claude-code": "claude-code",
  claude: "claude",
  "claude-ai": "claude",
  "claude-desktop": "claude",
  cursor: "cursor",
  "cursor-vscode": "cursor",
  "visual-studio-code": "vscode",
  vscode: "vscode",
  windsurf: "windsurf",
  codex: "codex",
  "codex-mcp-client": "codex",
  "gemini-cli": "gemini-cli",
  chatgpt: "chatgpt",
  "openai-mcp": "chatgpt",
  cline: "cline",
  zed: "zed",
  continue: "continue",
  goose: "goose",
  opencode: "opencode",
  "mcp-inspector": "mcp-inspector",
  "inspector-client": "mcp-inspector",
  "mcp-remote": "mcp-remote",
};

/**
 * Writes one call's data point, when the deployment binds the dataset.
 *
 * Positions are the dataset's schema. Blobs: 1 channel, 2 operation, 3 tool,
 * 4 kind, 5 outcome, 6 code, 7 reason, 8 field, 9 issue, 10 credential,
 * 11 identity, 12 client, 13 client version. Doubles: 1 status, 2 duration in
 * milliseconds. The index is the account, so sampling keeps an account's
 * calls together; a call with none shares the empty index.
 */
export function recordManagementCall(env: Env, call: ManagementCall): void {
  const dataset = env.MANAGEMENT_ANALYTICS;
  if (dataset === undefined) return;
  try {
    dataset.writeDataPoint({
      indexes: [token(call.accountId) ?? ""],
      blobs: [
        call.channel,
        token(call.operation),
        token(call.tool),
        token(call.kind),
        call.outcome,
        token(call.code),
        token(call.reason),
        token(call.field),
        token(call.issue),
        call.credential,
        call.identity,
        token(call.client),
        token(call.clientVersion),
      ],
      doubles: [call.status, Math.max(0, Math.round(call.durationMs))],
    });
  } catch (error) {
    log("warn", "management_analytics_write_failed", { error: errorFacts(error) });
  }
}

/** A successful call, or one answered with a status of its own, such as a relayed response. */
export function endingOf(status: number): CallEnding {
  return {
    outcome: status >= 500 ? "failed" : status >= 400 ? "refused" : "ok",
    status,
    code: null,
    reason: null,
    field: null,
    issue: null,
  };
}

/**
 * A call that threw, as the client is answered: a gateway error by its own
 * status and code, a platform failure as the `service_unavailable` it is
 * answered as, and anything else as the `500 internal_error` the entry module
 * answers it with. Pass a cf-auth error through `asGatewayAuthError` first.
 */
export function refusalOf(error: unknown): CallEnding {
  const refusal = error instanceof GatewayError ? error : asGatewayError(error);
  if (refusal === null) {
    return { outcome: "failed", status: 500, code: "internal_error", reason: null, field: null, issue: null };
  }
  return {
    ...endingOf(refusal.status),
    code: refusal.code,
    reason: refusal.reason ?? null,
    field: refusal.field?.name ?? null,
    issue: refusal.field?.issue ?? null,
  };
}

/**
 * The label for a name a client gives itself: one of {@link KNOWN_CLIENTS},
 * `other` for any name not on it, and null where there is no name at all.
 */
export function knownClient(name: string | undefined): string | null {
  const normalized = name?.trim().toLowerCase().replace(/\s+/gu, "-");
  if (!normalized) return null;
  return Object.hasOwn(KNOWN_CLIENTS, normalized) ? KNOWN_CLIENTS[normalized]! : "other";
}

/** The client a `user-agent` names by its first product token, as {@link knownClient} labels it. */
export function clientOf(userAgent: string | undefined): string | null {
  return knownClient(userAgent?.trim().split(/[\s/]/u, 1)[0]);
}

/** The numeric part of a version, `1.4.0` from `1.4.0-beta.2`, or null where the value is not one. */
export function versionOf(value: string | undefined): string | null {
  return VERSION.exec(value ?? "")?.[1] ?? null;
}

/** The CLI's version, from its `user-agent`, `agw/<version>`, or null for any other client. */
export function cliVersionOf(userAgent: string | undefined): string | null {
  const [name, version, ...rest] = userAgent?.trim().split("/") ?? [];
  return name === "agw" && rest.length === 0 ? versionOf(version) : null;
}

/** The value if it is one bounded token, else null. */
export function token(value: string | null | undefined): string | null {
  return value !== null && value !== undefined && TOKEN.test(value) ? value : null;
}
