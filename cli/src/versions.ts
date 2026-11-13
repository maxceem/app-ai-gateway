/**
 * Saying, when a command fails, that the CLI and the gateway it talks to are
 * different releases.
 *
 * The two are released together under one version number, so a difference is
 * a fact rather than a guess, and often the reason a request was refused: a
 * route, a field or a rule one side has and the other does not. It is said
 * only after a failure the gateway itself answered, and only when it could be
 * the cause, so it never becomes a line people learn to skip.
 */

import { CliError, VERSION } from "./common.ts";
import type { Context, Notice } from "./context.ts";
import type { CommandName } from "./parser.ts";

/** How long the version lookup may take; a slow answer leaves the hint out. */
const LOOKUP_MS = 5_000;

/**
 * Refusals whose cause is known and has nothing to do with versions: a
 * credential, a permission, a conflict with another write, or a limit. An
 * upgrade suggested there would send somebody after the wrong fix.
 */
const UNRELATED_STATUS = new Set([401, 403, 409, 429]);

/** Commands whose failures come from Cloudflare or a release, not from the gateway. */
const NOT_GATEWAY: ReadonlySet<CommandName> = new Set([
  "deployment setup",
  "deployment update",
  "deployment domain",
]);

/** `0.17.1` as numbers; anything else is not compared. */
function parts(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** Negative when `a` is the older release, positive when it is newer, 0 when the same. */
export function compareVersions(a: string, b: string): number | undefined {
  const left = parts(a);
  const right = parts(b);
  if (!left || !right) return undefined;
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! - right[i]!;
  return 0;
}

/** Whether a failure is one a version difference could explain. */
function gatewayAnswered(command: CommandName, error: CliError): boolean {
  if (NOT_GATEWAY.has(command)) return false;
  if (error.code === "invalid_response") return true;
  const status = error.details?.status;
  return status !== undefined && !UNRELATED_STATUS.has(status) && !error.code.startsWith("billing_");
}

/**
 * The note a failure gets when the CLI and the gateway API are different
 * releases, or `undefined`: same release, a failure versions cannot explain,
 * or a gateway that could not be asked.
 */
export async function versionNotice(
  ctx: Context,
  command: CommandName,
  error: CliError,
): Promise<Notice | undefined> {
  if (!gatewayAnswered(command, error)) return undefined;
  let capabilities;
  try {
    const lookup = ctx.client.publicCall("getCliCapabilities", { url: ctx.url });
    lookup.catch(() => {});
    capabilities = (await Promise.race([
      lookup,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), LOOKUP_MS).unref()),
    ]))?.data;
  } catch {
    return undefined;
  }
  if (!capabilities) return undefined;
  const api = capabilities.serverVersion;
  const order = compareVersions(VERSION, api);
  if (order === undefined || order === 0) return undefined;
  const versions = { cliVersion: VERSION, apiVersion: api };
  if (order < 0)
    return {
      code: "version_mismatch",
      message: `Your agw CLI (${VERSION}) is older than the gateway API it talks to (${api}). Updating the CLI may fix this: npm install -g @maxceem/agw`,
      ...versions,
    };
  // Only a self-hosted gateway is the user's to update; the hosted one is kept
  // current for them.
  if (capabilities.deployment.mode !== "self_hosted") return undefined;
  return {
    code: "version_mismatch",
    message: `Your self-hosted gateway API (${api}) is older than this agw CLI (${VERSION}). Updating the gateway may fix this: agw deployment update`,
    ...versions,
  };
}
