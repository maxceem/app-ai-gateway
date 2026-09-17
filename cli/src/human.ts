import { AppConfigSchema } from "../../src/contracts/schemas.ts";
import type { CommandName } from "./parser.ts";
import type { GatewayCapability, ProviderCapability } from "./resources.ts";
import type { RenderedResult } from "./results.ts";

/** What every line of human output is written against: which gateway, whose account. */
export interface OutputContext {
  url: string;
  accountId?: string;
  deploymentId?: string;
}

/** A value a key/value line can carry; `undefined` and `null` drop the line. */
type Cell = string | number | boolean | undefined | null;

/**
 * Key/value lines with the values in one column.
 *
 * The width is measured rather than fixed so that a renderer never has to know
 * what the longest label in its own block is, and a label added later cannot
 * silently break the alignment of the ones above it.
 */
function kv(entries: readonly (readonly [string, Cell])[]): string[] {
  const rows: [string, string][] = [];
  for (const [key, value] of entries)
    if (value !== undefined && value !== null) rows.push([key, String(value)]);
  const width = Math.max(0, ...rows.map(([key]) => key.length + 1));
  return rows.map(([key, value]) => `${key}:`.padEnd(width + 1) + value);
}

/**
 * A padded-column table. No dependency: the columns are known strings and the
 * only thing a table library would add here is the box drawing nobody pipes.
 */
function table(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, column) =>
        column === widths.length - 1 ? cell : cell.padEnd((widths[column] ?? 0) + 2),
      )
      .join("")
      .trimEnd();
  return [line(headers), ...rows.map(line)];
}

/** The fallback for a shape no renderer claims, and for `show`'s full document. */
const json = (value: unknown): string => JSON.stringify(value, null, 2);

const yesNo = (value: boolean): string => (value ? "yes" : "no");

/**
 * The human rendering of one command's result.
 *
 * Dispatched on the command and then narrowed on the result union: the results
 * are one union, so a shape a branch cannot render is a type error here instead
 * of `undefined` on somebody's terminal. A branch that meets a shape it does not
 * recognize at runtime falls back to the indented document rather than printing
 * a half-rendered line.
 */
export function humanResult(
  command: CommandName,
  result: RenderedResult,
  context: OutputContext,
): string {
  // The snippet is source code somebody pipes into a file: it is the whole of
  // this command's output, with no trailers and no trailing blank line.
  if (command === "app snippet" && "snippet" in result && typeof result.snippet === "string")
    return result.snippet;
  const lines = render(command, result, context);
  // Which account this was said about, for the commands whose own rendering
  // does not name it. `Account ID`, and skipped once the id is already on the
  // screen: one label holding two different things is how a reader ends up
  // copying the wrong one.
  const accountId = context.accountId;
  if (accountId && !lines.some((line) => line.includes(accountId)))
    lines.push(`Account ID: ${accountId}`);
  if ("trial" in result && result.trial)
    lines.push(`Free access ends: ${result.trial.endsAt}`);
  if ("account" in result && result.account?.expiresAt)
    lines.push(`Recovery deadline: ${result.account.expiresAt}`);
  return lines.join("\n") + "\n";
}

function render(
  command: CommandName,
  result: RenderedResult,
  context: OutputContext,
): string[] {
  // A browser handoff answers whichever command opened it, so it is recognized
  // before that command's own renderer ever sees the result.
  if ("state" in result && result.state === "pending" && "url" in result)
    return [
      `Waiting for browser handoff (${result.id}).`,
      result.url,
      `Resume: agw operation wait ${result.id}`,
    ];
  switch (command) {
    case "account status":
    case "account login":
    case "account claim":
    case "deployment connect":
    case "deployment status":
      return status(command, result, context);
    case "provider types":
    case "provider-gateway types":
    case "provider list":
    case "provider-gateway list":
    case "app list":
    case "app key list":
      return list(command, result);
    case "provider show":
    case "provider-gateway show":
    case "app show":
      return show(command, result);
    case "provider update":
    case "provider-gateway update":
    case "provider rotate-key":
    case "provider-gateway rotate-key":
    case "provider add":
    case "provider-gateway add":
    case "provider remove":
    case "provider-gateway remove":
    case "app remove":
    case "app key add":
    case "app key revoke":
    case "account logout":
      return mutation(command, result, context);
    case "usage show":
    case "usage breakdown":
      return usage(command, result);
    case "operation status":
    case "operation wait":
      return operation(result);
    case "app add":
    case "app update":
    case "app validate":
    case "app check":
    case "app snippet":
      return app(command, result, context);
    case "deployment setup":
    case "deployment update":
    case "deployment domain":
      return deployment(result);
  }
}

/** `account status`, `deployment status`, and the two commands that connect. */
function status(
  command: CommandName,
  result: RenderedResult,
  context: OutputContext,
): string[] {
  // A command that changed the selected connection confirms that first, the way
  // a mutation does; a plain status report has nothing to confirm.
  const did =
    command === "account login"
      ? [`Signed in to ${context.url}.`]
      : command === "deployment connect"
        ? [`Connected to ${context.url}.`]
        : [];
  if ("billing" in result)
    return [
      ...did,
      ...kv([
        ["Gateway", context.url],
        ["Account", `${result.account.name} (${result.account.id})`],
        ["Claimed", yesNo(result.account.claimed)],
        ["Deployment", result.deployment.mode === "cloud" ? "cloud" : "self-hosted"],
        ["Console", result.deployment.consoleOrigin],
      ]),
    ];
  if ("protocolVersion" in result)
    return [
      ...did,
      ...kv([
        ["Gateway", result.url],
        ["Connected", yesNo(result.connected)],
        ["Authenticated", yesNo(result.authenticated)],
        ["Version", result.serverVersion],
        ["Deployment", result.deployment.mode === "cloud" ? "cloud" : "self-hosted"],
        ["Console", result.consoleOrigin],
        ["Provider types", result.providers.length],
        ["Provider gateway types", result.providerGateways.length],
      ]),
    ];
  if ("state" in result) return [...did, ...operation(result)];
  return [...did, json(result)];
}

/**
 * One table per list command, each narrowed on the key that identifies its own
 * answer. Dispatched on the command first so that a key several results share
 * is read as the one this command can actually have returned.
 */
function list(command: CommandName, result: RenderedResult): string[] {
  if (command === "provider types" || command === "provider-gateway types") {
    if (!Array.isArray(result)) return [json(result)];
    // The two capability lists differ by one column, and a gateway type has no
    // origin of its own: its adapter holds it.
    const types: readonly (ProviderCapability | GatewayCapability)[] = result;
    if (!types.length) return ["No types."];
    return table(
      ["TYPE", "NAME", "BASE URL"],
      types.map((entry) => [entry.type, entry.name, "baseUrl" in entry ? entry.baseUrl : ""]),
    );
  }
  if (command === "provider list") {
    // Three results in the union carry `providers`: this list, an `app check`
    // report (`appId`) and a deployment's capabilities (`protocolVersion`).
    // Naming the other two out is what leaves `ProviderSummary[]` here rather
    // than a union of three different arrays.
    if (!("providers" in result) || "appId" in result || "protocolVersion" in result)
      return [json(result)];
    if (!result.providers.length) return ["No providers."];
    return table(
      ["ID", "SLUG", "TYPE", "NAME", "STATUS", "CREATED"],
      result.providers.map((provider) => [
        provider.id,
        provider.slug,
        provider.type,
        provider.name,
        provider.status,
        provider.createdAt,
      ]),
    );
  }
  if (command === "provider-gateway list" && "gateways" in result) {
    if (!result.gateways.length) return ["No provider gateways."];
    return table(
      ["ID", "TYPE", "NAME", "STATUS", "PROVIDERS", "CREATED"],
      result.gateways.map((gateway) => [
        gateway.id,
        gateway.type,
        gateway.name,
        gateway.status,
        String(gateway.providerCount),
        gateway.createdAt,
      ]),
    );
  }
  // `apps` is also the account-wide usage report's per-app list, which is the
  // one other result carrying that key.
  if (command === "app list" && "apps" in result && !("totals" in result)) {
    if (!result.apps.length) return ["No apps."];
    return table(
      ["ID", "NAME", "AUTH", "STATUS", "PROVIDERS", "CREATED"],
      result.apps.map((entry) => [
        entry.id,
        entry.name,
        entry.authentication_type,
        entry.status,
        String(entry.providers.length),
        entry.created_at,
      ]),
    );
  }
  // Matched on `app_id` as well as `keys`, because every array in the union
  // answers to `keys` too: it is a method on `Array.prototype`.
  if (command === "app key list" && "keys" in result && "app_id" in result) {
    if (!result.keys.length) return [`No keys for ${result.app_id}.`];
    return table(
      ["ID", "NAME", "PREFIX", "STATUS", "CREATED", "LAST USED"],
      result.keys.map((key) => [
        key.id,
        key.name,
        key.key_prefix,
        key.status,
        key.created_at,
        key.last_used_at ?? "never",
      ]),
    );
  }
  return [json(result)];
}

/**
 * The full stored configuration, under a line naming what it is.
 *
 * The document stays indented JSON on purpose: `app show --json` output is what
 * the guides tell people to save and edit, and the plain run is how they read
 * the same thing before deciding to.
 */
function show(command: CommandName, result: RenderedResult): string[] {
  if (command === "app show" && "app" in result && !("guidance" in result)) {
    const lines = [`${result.app.name} (${result.app.id})`];
    if (result.config_error) lines.push(`Configuration error: ${result.config_error}`);
    return [...lines, "", json(result)];
  }
  if ("slug" in result)
    return [
      `${result.name} (${result.id}), type ${result.type}, slug ${result.slug}`,
      "",
      json(result),
    ];
  if ("referencedCount" in result)
    return [`${result.name} (${result.id}), type ${result.type}`, "", json(result)];
  return [json(result)];
}

/** One line naming what happened, plus where a key was written. */
function mutation(
  command: CommandName,
  result: RenderedResult,
  context: OutputContext,
): string[] {
  if ("loggedOut" in result)
    return [`Signed out of ${context.url}. The stored credential was removed.`];
  if ("deleted" in result) {
    if ("provider_id" in result) return [`Removed provider ${result.provider_id}.`];
    if ("provider_gateway_id" in result)
      return [`Removed provider gateway ${result.provider_gateway_id}.`];
    return [
      `Removed app ${result.app_id}. ${result.removed_users} users removed; usage events retained.`,
    ];
  }
  if ("key" in result)
    return [`Revoked key ${result.key.name} (${result.key.id}) for app ${result.app_id}.`];
  if ("applicationKey" in result && "appId" in result)
    return [
      `Created key ${result.applicationKey.name} (${result.applicationKey.id}) for app ${result.appId}.`,
      `Key saved: ${result.applicationKey.storagePath}`,
    ];
  if ("provider" in result) {
    const added = command === "provider add";
    return [
      `${added ? "Stored" : "Updated"} provider ${result.provider.name} (${result.provider.id}).`,
      ...kv([
        ["Gateway", context.url],
        ["Status", result.provider.status],
        ["Key hint", result.provider.secretHint],
      ]),
      ...(added
        ? ["Credential stored; no upstream probe or inference was performed."]
        : []),
    ];
  }
  if ("gateway" in result) {
    const added = command === "provider-gateway add";
    return [
      `${added ? "Stored" : "Updated"} provider gateway ${result.gateway.name} (${result.gateway.id}).`,
      ...kv([
        ["Gateway", context.url],
        ["Status", result.gateway.status],
        ["Token hint", result.gateway.secretHint],
      ]),
      ...(added
        ? ["Credential stored; no upstream probe or inference was performed."]
        : []),
    ];
  }
  return [json(result)];
}

function usage(command: CommandName, result: RenderedResult): string[] {
  if (command === "usage breakdown" && "rows" in result) {
    const head = kv([
      ["App", result.app_id],
      ["Grouped by", result.by],
      ["Period", `${result.from} to ${result.to}`],
    ]);
    const rows = result.rows.length
      ? table(
          ["KEY", "REQUESTS", "INPUT", "OUTPUT", "COST USD", "ERRORS", "BLOCKED"],
          result.rows.map((row) => [
            row.key ?? "(none)",
            String(row.requests),
            String(row.input_tokens),
            String(row.output_tokens),
            row.cost_usd.toFixed(4),
            String(row.errors),
            String(row.blocked),
          ]),
        )
      : ["No usage in this period."];
    return [...head, "", ...rows, "", result.coverage.source];
  }
  if ("totals" in result)
    return [
      ...kv([
        ["Month", result.month],
        ["Requests", result.totals.requests],
        ["Input tokens", result.totals.input_tokens],
        ["Output tokens", result.totals.output_tokens],
        ["Cost USD", result.totals.cost_usd.toFixed(4)],
        ["Errors", result.totals.errors],
        ["Blocked", result.totals.blocked],
      ]),
      "",
      // The totals are the sum of these rows, so the apps they came from are
      // printed rather than counted: a month is read to find which app spent it.
      ...(result.apps.length
        ? table(
            ["APP", "REQUESTS", "INPUT", "OUTPUT", "COST USD", "ERRORS", "BLOCKED"],
            result.apps.map((entry) => [
              entry.deleted ? `${entry.appId} (deleted)` : entry.appId,
              String(entry.requests),
              String(entry.input_tokens),
              String(entry.output_tokens),
              entry.cost_usd.toFixed(4),
              String(entry.errors),
              String(entry.blocked),
            ]),
          )
        : ["No app usage recorded."]),
      "",
      result.coverage.historicalAttribution,
    ];
  if ("requests" in result)
    return kv([
      ["App", result.app_id],
      ["Month", result.month],
      ["Requests", result.requests],
      ["Input tokens", result.input_tokens],
      ["Cached input tokens", result.cached_input_tokens],
      ["Cache write tokens", result.cache_write_tokens],
      ["Output tokens", result.output_tokens],
      ["Cost USD", result.cost_usd.toFixed(4)],
    ]);
  return [json(result)];
}

/** A handoff that is no longer pending: `operation status`, `operation wait`. */
function operation(result: RenderedResult): string[] {
  if (!("state" in result)) return [json(result)];
  const stored = "result" in result ? result.result : undefined;
  return kv([
    ["Operation", result.id],
    ["State", result.state],
    ["Expires", result.expiresAt],
    ["Account", stored?.accountId],
    ["Provider", stored?.provider && `${stored.provider.name} (${stored.provider.id})`],
    ["Provider gateway", stored?.gateway && `${stored.gateway.name} (${stored.gateway.id})`],
  ]);
}

function app(
  command: CommandName,
  result: RenderedResult,
  context: OutputContext,
): string[] {
  if ("output" in result) return [`Saved: ${result.output}`];
  if ("ready" in result)
    return [
      `${result.appId} is ${result.ready ? "ready to serve requests" : "not ready to serve requests"}.`,
      ...kv([
        ["Status", result.status],
        ["Providers", result.providers.length],
        ["Active providers", result.providers.filter((p) => p.status === "active").length],
      ]),
      ...notes([
        ...(result.validation.remote ? [] : result.validation.skipped),
        ...result.limitations,
      ]),
    ];
  if ("definition" in result) {
    const dryRun = "dryRun" in result;
    return [
      `${dryRun ? "Dry run: " : ""}${result.definition.name} is valid${
        result.validation.remote ? " here and on the gateway" : " locally"
      }.`,
      ...kv([
        ["Gateway", context.url],
        ["Status", result.definition.status],
        ["Authentication", result.definition.config.authentication.type],
        ["App ID", result.validation.remote ? result.validation.app_id : undefined],
      ]),
      ...notes(result.validation.remote ? [] : result.validation.skipped),
      ...(dryRun ? ["", "Nothing was written."] : []),
    ];
  }
  if ("guidance" in result && "app" in result) return written(command, result, context);
  return [json(result)];
}

/** The issue list a verdict is followed by, one per line, or nothing at all. */
const notes = (values: readonly string[]): string[] =>
  values.length ? ["", ...values.map((value) => `- ${value}`)] : [];

/** What `app add` and `app update` report about the application they wrote. */
function written(
  command: CommandName,
  result: Extract<RenderedResult, { guidance: string }>,
  context: OutputContext,
): string[] {
  const lines = [
    `${command === "app add" ? "Created" : "Updated"} ${result.app.name}`,
    `Gateway: ${context.url}`,
    `App ID: ${result.app.id}`,
    "",
  ];
  const parsed = AppConfigSchema.safeParse(result.app.config);
  if (parsed.success) {
    const config = parsed.data;
    if (config.authentication.type === "apple_app_attest") {
      const endUser = config.authentication.end_user;
      lines.push(
        `App Attest: ${(config.authentication.app_attest.environments ?? ["production"]).join(" + ")}`,
        `User identity: ${endUser.source === "app_install" ? "per installation; sign-in not required" : "verified issuer; integrate your sign-in SDK"}`,
        `Paid subscription check: ${endUser.source === "issuer" && endUser.issuer.required_claims.length ? "configured claim requirements" : "off"}`,
      );
    } else lines.push("Authentication: server application API key");
    const limits = config.limits?.per_user;
    lines.push(
      `Per-user limits: ${limits?.requests.per_minute ?? "unlimited"} requests/minute, ${limits?.requests.per_day ?? "unlimited"}/day`,
    );
  }
  if (result.applicationKey)
    lines.push(`Key saved: ${result.applicationKey.storagePath}`);
  if (result.guidance) lines.push("", result.guidance);
  if ("snippet" in result && result.snippet) lines.push("", result.snippet);
  return lines;
}

/** The three deployment plans, each printed as the fields it actually carries. */
function deployment(result: RenderedResult): string[] {
  if ("hostname" in result)
    return kv([
      [result.dryRun ? "Would attach domain" : "Domain", result.hostname],
      ["Worker", result.worker],
      ["Cloudflare account", result.accountId],
      ["Zone", result.zoneId],
      ["Previous URL", result.previousUrl],
      ["URL", result.url],
      ["Note", result.note],
    ]);
  if ("fromVersion" in result)
    return kv([
      [result.dryRun ? "Would update worker" : "Worker", result.worker],
      ["Cloudflare account", result.accountId],
      ["Database", result.databaseId],
      ["From version", result.fromVersion],
      ["To version", result.toVersion],
      ["Updated", result.updated ? "yes" : undefined],
    ]);
  // Every setup answer carries one of these two: a dry run reports the plan it
  // would install, and the other two report an installation that is complete.
  if ("installed" in result || "resources" in result)
    return kv([
      [result.dryRun ? "Would install worker" : "Worker", result.name],
      ["Cloudflare account", result.accountId],
      ["URL", result.url],
      ["Version", result.version],
      ["Domain", result.domain],
      ["Pending domain", result.pendingDomain],
      ["Deployment", result.deploymentId],
      ["Resources", result.resources?.join(", ")],
      ["Backup", result.backup],
      ["Installed", result.installed ? "yes" : undefined],
      ["Note", result.note],
    ]);
  return [json(result)];
}
