/**
 * Saying, when a command fails, that the CLI and the gateway it talks to are
 * different releases (`version_mismatch`, as agw 1.x).
 *
 * The two are released together under one version number, so a difference is
 * a fact rather than a guess, and often the reason a request was refused: a
 * route, a field or a rule one side has and the other does not. It is said
 * only after a failure the gateway itself answered, and only when it could be
 * the cause, so it never becomes a line people learn to skip.
 */

import { CliError, VERSION } from "./common.ts";
import type { Context, Notice } from "./context.ts";

/** How long the release lookup may take; a slow answer leaves the release out. */
const LOOKUP_MS = 3_000;

/**
 * What the gateway says about itself, for its release: asked with a short
 * limit, and never a reason for a command to fail. Undefined when it could
 * not be asked in time.
 */
export async function gatewayRelease(ctx: Pick<Context, "client" | "url">): Promise<{ readonly serverVersion?: string; readonly billing: boolean } | undefined> {
  try {
    return (await ctx.client.publicCall("getConsoleCapabilities", { url: ctx.url, timeoutMs: LOOKUP_MS })).data;
  } catch {
    return undefined;
  }
}

/**
 * Refusals whose cause is known and has nothing to do with versions: a
 * credential, a permission, a conflict with another write, or a limit. An
 * update suggested there would send somebody after the wrong fix.
 */
const UNRELATED_STATUS = new Set([401, 403, 409, 429]);

/** `deployment connect` fails about a gateway other than the selected one this lookup would ask. */
const NOT_SELECTED_GATEWAY = new Set(["deployment connect"]);

/** `2.0.1` as numbers; anything else is not compared. */
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

/** Whether a failure is one a release difference could explain. */
function gatewayAnswered(command: string, error: CliError): boolean {
  if (NOT_SELECTED_GATEWAY.has(command)) return false;
  const status = error.details?.status;
  if (status !== undefined && UNRELATED_STATUS.has(status)) return false;
  // A body this release could not read is answered too, with or without a status.
  if (error.code === "invalid_response") return true;
  return status !== undefined && !error.code.startsWith("billing_");
}

/**
 * The note a failure gets when the CLI and the gateway are different releases,
 * or `undefined`: the same release, a failure releases cannot explain, a
 * gateway that could not be asked, or one that does not say its release.
 */
export async function versionNotice(ctx: Context, command: string, error: CliError): Promise<Notice | undefined> {
  if (!gatewayAnswered(command, error)) return undefined;
  const capabilities = await gatewayRelease(ctx);
  if (capabilities === undefined) return undefined;
  const api = capabilities.serverVersion;
  if (api === undefined) return undefined;
  const order = compareVersions(VERSION, api);
  if (order === undefined || order === 0) return undefined;
  const versions = { cliVersion: VERSION, apiVersion: api };
  if (order < 0)
    return {
      code: "version_mismatch",
      message: `Your agw CLI (${VERSION}) is older than the gateway it talks to (${api}). Updating the CLI may fix this: npm install -g @maxceem/agw`,
      ...versions,
    };
  // Only a self-hosted gateway is the person's to update; the hosted one (the
  // one with billing) is kept current for them.
  if (capabilities.billing) return undefined;
  return {
    code: "version_mismatch",
    message: `Your self-hosted gateway (${api}) is older than this agw CLI (${VERSION}). Updating the gateway may fix this.`,
    ...versions,
  };
}
