/**
 * The built-in commands' results as a terminal shows them. `--json` prints the
 * same results as one document instead.
 */
import type { CommandName } from "./parser.ts";
import type { CommandResult, DeploymentStatusResult, OperationStatus } from "./results.ts";
import type { AppAddResult, AppKeyAddResult, AppUpdateResult, ProviderResult, StoredKey } from "./commands.ts";
import type { LoginResult, LogoutResult } from "./context.ts";
import { plain, type Style } from "./style.ts";

/** Where a result was produced, for the lines that name it. */
export interface OutputContext {
  url: string;
  accountId?: string;
}

/** Remote text, made safe to print: no control characters. */
const clean = (value: unknown): string => String(value ?? "").replace(/[\p{Cc}\p{Cf}]/gu, " ");

function keyLines(key: StoredKey, style: Style): string[] {
  return [
    `Key ${clean(key.name)} (${clean(key.id)}), starting ${clean(key.key_prefix)}`,
    `${style.headline("Written to:")} ${clean(key.storagePath)} (readable only by you)`,
    style.dim("The gateway never shows this key again. Move it to where your server reads its secrets."),
  ];
}

function signedIn(result: LoginResult, style: Style): string[] {
  return [
    `${style.headline("Signed in")} to ${clean(result.url)}`,
    `As ${clean(result.user.email ?? result.user.name ?? result.user.id)}, ${clean(result.role)} of ${clean(result.account.name)} (${clean(result.account.id)})`,
    `Access: ${clean(result.grant)}${result.credential === "environment" ? ", from AGW_MANAGEMENT_KEY" : ""}`,
  ];
}

function status(result: DeploymentStatusResult, style: Style): string[] {
  const lines = [`${style.headline("Gateway:")} ${clean(result.url)}`];
  if (!result.signedIn) {
    lines.push("Not signed in. Run agw account login, or set AGW_MANAGEMENT_KEY.");
    return lines;
  }
  if (result.user) lines.push(`Signed in as ${clean(result.user.email ?? result.user.name ?? result.user.id)}`);
  if (result.account) lines.push(`Account: ${clean(result.account.name)} (${clean(result.account.id)}), ${clean(result.role)}`);
  lines.push(`Access: ${clean(result.grant)}, ${result.credential === "environment" ? "from AGW_MANAGEMENT_KEY" : "this CLI's sign-in"}`);
  return lines;
}

function operation(result: OperationStatus, style: Style): string[] {
  if (result.state === "pending")
    return [
      `${style.warn("Waiting for a person")} to finish operation ${clean(result.id)} in the browser, until ${clean(result.expiresAt)}.`,
      `Run agw operation wait ${clean(result.id)} to wait for it.`,
    ];
  if (result.state === "expired") return [`Operation ${clean(result.id)} ${result.denied ? "was declined" : "lapsed"}.`];
  const provider = result.result?.provider;
  return provider
    ? [`Operation ${clean(result.id)} completed: provider ${clean(provider.slug)} (${clean(provider.id)}) is saved.`]
    : [`Operation ${clean(result.id)} completed.`];
}

/** The text for one built-in command's result. */
export function humanResult(command: CommandName, result: CommandResult, _context: OutputContext, style: Style = plain): string {
  let lines: string[];
  if (command === "account login" || command === "deployment connect") lines = signedIn(result as LoginResult, style);
  else if (command === "deployment status") lines = status(result as DeploymentStatusResult, style);
  else if (command === "account logout") {
    const out = result as LogoutResult;
    lines = [out.revoked ? "Signed out. The gateway ended this CLI's sign-in." : "Signed out on this machine."];
  } else if ("state" in result && "kind" in result) lines = operation(result as OperationStatus, style);
  else if (command === "provider add" || command === "provider rotate-key") {
    const { provider } = result as ProviderResult;
    lines = [
      `${style.headline(command === "provider add" ? "Added" : "Replaced the key of")} provider ${clean(provider.slug)} (${clean(provider.type)}, ${clean(provider.id)})`,
      ...(provider.secretHint ? [`Key ends in …${clean(provider.secretHint)}`] : []),
    ];
  } else if (command === "app add") {
    if ("dryRun" in result) lines = ["The app document is valid. Nothing was created."];
    else {
      const out = result as AppAddResult;
      lines = [`${style.headline("Created app")} ${clean(out.app.name)} (${clean(out.app.id)})`, ...(out.key ? keyLines(out.key, style) : [])];
    }
  } else if (command === "app key add") {
    const out = result as AppKeyAddResult;
    lines = [`${style.headline("Created a key")} for ${clean(out.app_id)}`, ...keyLines(out.key, style)];
  } else if (command === "app update") {
    const { app } = result as AppUpdateResult;
    lines = [`${style.headline("Saved")} app ${clean(app.name)} (${clean(app.id)}): ${clean(app.status)}, revision ${clean(app.revision)}`];
  } else lines = [JSON.stringify(result, null, 2)];
  return lines.join("\n") + "\n";
}
