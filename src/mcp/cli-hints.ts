import type { CliToolHint } from "../contracts/cli";

/**
 * Where each MCP tool sits among `agw`'s commands.
 *
 * `agw` builds every command it does not implement itself from this table,
 * served by `GET /v1/cli/tools`, so a tool added here is a command of every
 * installed CLI the moment it is deployed, with flags from its input schema
 * and help from its description. A command the CLI does implement itself —
 * one that opens a browser, writes a key to a file or waits on an operation —
 * keeps its own implementation; its entry here only records the mapping.
 *
 * Keep what is here additive, like any contract with installed clients: a
 * command renamed or an argument made positional breaks a script calling the
 * old form. A view may change freely; it only decides how a person sees the
 * result, never what `--json` carries.
 *
 * `view.columns` are dotted keys into each row or the record; `key=Label`
 * names the column, and `$1`, `$2` are the keys a `*` in `rows` matched.
 * `view.notes` are lists printed one entry per line, and `view.document` an
 * object printed whole as JSON, both after the rest.
 */
export const CLI_HINTS: Readonly<Record<string, CliToolHint>> = {
  get_account: {
    command: "account status",
    summary: "Show the account, its deadlines and its request allowance",
    view: {
      record: "",
      columns: [
        "account.name=Account",
        "account.id=Account ID",
        "account.claimed=Claimed",
        "account.expiresAt=Expires",
        "deployment.mode=Deployment",
        "deployment.consoleOrigin=Console",
        "usage.used=Requests used",
        "usage.limit=Request limit",
        "usage.resetAt=Resets",
      ],
    },
  },
  get_capabilities: {
    command: "deployment capabilities",
    summary: "List what this gateway supports: provider types and their API styles",
    view: { rows: "providers", columns: ["type", "name", "baseUrl=Base URL", "apiStyles=API styles"] },
  },
  list_models: {
    command: "model list",
    view: {
      rows: "prices.*.*",
      columns: ["$1=Provider", "$2=Model", "kind", "input=Input $/1M", "output=Output $/1M", "retirement_date=Retires"],
    },
  },
  list_providers: {
    command: "provider list",
    view: { rows: "providers", columns: ["slug", "type", "status", "route", "id"] },
  },
  get_provider: {
    command: "provider show",
    args: ["provider"],
    view: {
      record: "provider",
      columns: ["slug", "name", "id", "type", "status", "route", "baseUrl=Base URL", "secretHint=Key", "revision", "createdAt=Created"],
    },
  },
  list_provider_gateways: {
    command: "provider-gateway list",
    view: { rows: "gateways", columns: ["name", "type", "status", "id"] },
  },
  list_apps: {
    command: "app list",
    view: {
      rows: "apps",
      columns: ["id", "name", "status", "authentication_type=Type", "usage.requests=Requests", "usage.cost_usd=Cost $"],
    },
  },
  get_app: {
    command: "app show",
    args: ["app"],
    view: {
      record: "app",
      columns: ["name", "id", "status", "config.authentication.type=Type", "config.routing.providers.mode=Providers", "revision", "updated_at=Updated"],
      notes: ["app.warnings"],
      document: "app.config",
    },
  },
  validate_app: { command: "app validate", args: ["app"] },
  check_app: {
    command: "app check",
    args: ["app"],
    view: { rows: "providers", columns: ["slug=Provider", "status", "id"], notes: ["warnings", "limitations"] },
  },
  get_app_snippet: { command: "app snippet", args: ["app"] },
  list_app_keys: {
    command: "app key list",
    args: ["app"],
    view: { rows: "keys", columns: ["id", "name", "key_prefix=Prefix", "status", "created_at=Created", "last_used_at=Last used"] },
  },
  list_app_users: {
    command: "app user list",
    args: ["app"],
    view: {
      rows: "users",
      columns: ["id", "status", "installs", "usage.requests=Requests", "usage.cost_usd=Cost $", "last_seen_at=Last seen"],
    },
  },
  get_app_user: {
    command: "app user show",
    args: ["app", "user"],
    view: {
      record: "user",
      columns: [
        "id",
        "status",
        "installs",
        "attest_registered=Attested",
        "created_at=Created",
        "last_seen_at=Last seen",
        "usage.requests=Requests",
        "usage.cost_usd=Cost $",
        "usage.errors=Errors",
      ],
    },
  },
  list_app_events: {
    command: "app event list",
    args: ["app"],
    view: {
      rows: "events",
      columns: ["id", "created_at=Time", "status", "provider_slug=Provider", "model", "input_tokens=In", "output_tokens=Out", "cost_usd=Cost $", "latency_ms=ms"],
    },
  },
  list_auth_events: {
    command: "app auth-event list",
    args: ["app"],
    view: { rows: "events", columns: ["id", "created_at=Time", "event", "outcome", "reason", "user_id=User"] },
  },
  get_auth_event_summary: {
    command: "app auth-event summary",
    args: ["app"],
    view: { rows: "daily", columns: ["date", "event", "outcome", "reason", "count"] },
  },
  list_rejection_events: {
    command: "app rejection list",
    args: ["app"],
    view: { rows: "events", columns: ["id", "created_at=Time", "reason", "scope", "model", "user_id=User"] },
  },
  get_usage: {
    command: "usage show",
    view: { rows: "apps", columns: ["appId=App", "requests", "input_tokens=In", "output_tokens=Out", "cost_usd=Cost $", "errors", "deleted"] },
  },
  get_usage_breakdown: {
    command: "usage breakdown",
    view: { rows: "rows", columns: ["key", "requests", "input_tokens=In", "output_tokens=Out", "cost_usd=Cost $", "errors"] },
  },
  get_usage_timeseries: {
    command: "usage timeseries",
    view: { rows: "buckets", columns: ["date", "provider", "requests", "cost_usd=Cost $", "errors"] },
  },
  get_operation: {
    command: "operation show",
    args: ["id"],
    view: { record: "", columns: ["id", "kind", "state", "createdAt=Created", "expiresAt=Expires", "reveal_url=Reveal at"] },
  },
  add_provider: { command: "provider add" },
  add_provider_gateway: { command: "provider-gateway add" },
  update_provider: { command: "provider update", args: ["id"] },
  update_provider_gateway: { command: "provider-gateway update", args: ["id"] },
  rotate_provider_key: { command: "provider rotate-key", args: ["id"] },
  rotate_provider_gateway_key: { command: "provider-gateway rotate-key", args: ["id"] },
  remove_provider: { command: "provider remove", args: ["id"], confirm: "id" },
  remove_provider_gateway: { command: "provider-gateway remove", args: ["id"], confirm: "id" },
  add_app: { command: "app add" },
  update_app: {
    command: "app replace",
    summary: "Replace an app's whole document",
    args: ["app"],
    view: { record: "app", columns: ["name", "id", "status", "revision"] },
  },
  patch_app: {
    command: "app update",
    args: ["app"],
    view: { record: "app", columns: ["name", "id", "status", "revision"] },
  },
  remove_app: { command: "app remove", args: ["app"], confirm: "app" },
  add_app_key: { command: "app key add", args: ["app"] },
  revoke_app_key: {
    command: "app key revoke",
    args: ["app", "key"],
    view: { record: "key", columns: ["id", "name", "status"] },
  },
  block_app_user: { command: "app user block", args: ["app", "user"] },
  unblock_app_user: { command: "app user unblock", args: ["app", "user"] },
  claim_account: { command: "account claim" },
  contact_support: { command: "support send" },
};

/** The command a tool without an entry is still reachable as: `tool` and its name. */
export function fallbackHint(name: string): CliToolHint {
  return { command: `tool ${name.replaceAll("_", "-")}` };
}
