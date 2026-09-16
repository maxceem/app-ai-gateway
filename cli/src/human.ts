import { AppConfigSchema } from "../../src/contracts/schemas.ts";
import type { CommandName } from "./parser.ts";
import type { RenderedResult } from "./results.ts";

/** What every line of human output is written against: which gateway, whose account. */
export interface OutputContext {
  url: string;
  accountId?: string;
  deploymentId?: string;
}

/**
 * The human rendering of one command's result.
 *
 * Every branch reads the result through a narrowing check rather than an
 * assumption: the results are one union now, so a shape a branch cannot render
 * is a type error here instead of `undefined` on somebody's terminal.
 */
export function humanResult(
  command: CommandName,
  result: RenderedResult,
  context: OutputContext,
): string {
  const lines: string[] = [];
  if (command === "app snippet" && "snippet" in result && typeof result.snippet === "string")
    return result.snippet;
  if ("state" in result && result.state === "pending" && "url" in result) {
    lines.push(`Waiting for browser handoff (${result.id}).`, result.url);
    if (result.humanCode)
      lines.push(`Human confirmation code: ${result.humanCode}`);
    lines.push(`Resume: agw operation wait ${result.id}`);
  } else if ("guidance" in result && "app" in result) {
    lines.push(
      `${command === "app add" ? "Created" : "Updated"} ${result.app.name}`,
      `Gateway: ${context.url}`,
      `App ID: ${result.app.id}`,
      "",
    );
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
  } else if (command === "provider add" || command === "provider-gateway add") {
    const stored =
      "provider" in result
        ? result.provider
        : "gateway" in result
          ? result.gateway
          : undefined;
    const label = stored?.name ?? stored?.type ?? "connection";
    const id = stored?.id ?? ("id" in result ? result.id : undefined);
    lines.push(
      `Stored ${label} (${id}).`,
      `Gateway: ${context.url}`,
      "Credential stored; no upstream probe or inference was performed.",
    );
  } else if ("output" in result && typeof result.output === "string") {
    lines.push(`Saved: ${result.output}`);
  } else lines.push(JSON.stringify(result, null, 2));
  if (context.accountId) lines.push(`Account: ${context.accountId}`);
  if ("trial" in result && result.trial)
    lines.push(`Free access ends: ${result.trial.endsAt}`);
  if ("account" in result && result.account?.expiresAt)
    lines.push(`Recovery deadline: ${result.account.expiresAt}`);
  return lines.join("\n") + "\n";
}
