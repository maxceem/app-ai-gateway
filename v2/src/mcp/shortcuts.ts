/**
 * Flat arguments of `patch_app` that stand for app patch operations, as v1's
 * MCP tools took them (`src/mcp/shortcuts.ts` at the repository root): what
 * `agw app update` takes as flags, declared once beside the gateway that knows
 * where each setting lives.
 *
 * Each one replaces a whole leaf, so shortcuts alone apply to the app as it is
 * now: `patch_app` reads the app first, rather than asking for a revision.
 * v1's `providers` and `all_providers` are not here: a v2 route names its
 * operations and models, so a list of provider slugs alone cannot say what
 * each one may do. Those go through operations.
 */
import { z } from "zod";
import type { AppPatchOperation } from "../contracts/admin.ts";
import { APP_STATUSES } from "../contracts/admin.ts";
import { APP_ATTEST_ENVIRONMENTS, APP_ATTEST_VERIFY_ON } from "../contracts/app-config.ts";
import { GatewayError } from "../core/errors.ts";

/** The app document as `get_app` answers it: only what the shortcuts read. */
export interface ShortcutApp {
  readonly config?: { readonly authentication?: { readonly type?: string } };
}

interface Shortcut {
  readonly schema: z.ZodType;
  readonly operations: (value: never, app: ShortcutApp) => AppPatchOperation[];
}

/**
 * Each shortcut sets one object field with JSON Patch `add`, which writes the
 * field whether or not it is there: an operation before it may have replaced
 * its parent without it (an `app_attest` without `verify_on`).
 */
const set = (path: string, value: unknown): AppPatchOperation => ({ op: "add", path, value }) as AppPatchOperation;

/** A setting only an iOS app has, refused by name for any other. */
function appAttest(argument: string, setting: string): Shortcut["operations"] {
  return (value: never, app) => {
    if (app.config?.authentication?.type !== "apple_app_attest") {
      throw new GatewayError(400, "invalid_request", `${argument}: only an iOS (App Attest) app has this setting; nothing was saved`);
    }
    return [set(`/config/authentication/app_attest/${setting}`, value)];
  };
}

export const APP_SHORTCUTS: Readonly<Record<string, Shortcut>> = {
  name: {
    schema: z.string().trim().min(1).max(100).meta({ description: "The app's new name." }),
    operations: (value: string) => [set("/name", value)],
  },
  status: {
    schema: z.enum(APP_STATUSES).meta({ description: "active serves requests; disabled pauses the app, reversibly." }),
    operations: (value: string) => [set("/status", value)],
  },
  team_id: {
    schema: z.string().trim().min(1).meta({ description: "An iOS app's Apple team ID, ten uppercase letters or digits." }),
    operations: appAttest("team_id", "team_id"),
  },
  bundle_id: {
    schema: z.string().trim().min(1).meta({ description: "An iOS app's bundle ID, such as com.example.app." }),
    operations: appAttest("bundle_id", "bundle_id"),
  },
  attest_environments: {
    schema: z.array(z.enum(APP_ATTEST_ENVIRONMENTS)).min(1).meta({
      description: "The App Attest environments an iOS app accepts. A release build should accept production only.",
    }),
    operations: appAttest("attest_environments", "environments"),
  },
  verify_on: {
    schema: z.enum(APP_ATTEST_VERIFY_ON).meta({
      description: "When an iOS app's App Attest assertion is checked: every_request, or once per hourly token at token_exchange.",
    }),
    operations: appAttest("verify_on", "verify_on"),
  },
};

/** Every shortcut as an optional argument, for a tool's input. */
export function shortcutInput(): Record<string, z.ZodType> {
  return Object.fromEntries(Object.entries(APP_SHORTCUTS).map(([name, shortcut]) => [name, shortcut.schema.optional()]));
}

/** The shortcuts a call uses: every one it sends, `null` included; only one left out is skipped. */
export function usedShortcuts(input: Record<string, unknown>): string[] {
  return Object.keys(APP_SHORTCUTS).filter((name) => input[name] !== undefined);
}

/** Refuses, before anything is read or written, a shortcut whose value is not what it takes (`null` included). */
export function checkShortcuts(input: Record<string, unknown>): void {
  for (const name of usedShortcuts(input)) {
    const parsed = APP_SHORTCUTS[name]!.schema.safeParse(input[name]);
    if (!parsed.success) throw new GatewayError(400, "invalid_request", `${name}: ${parsed.error.issues[0]?.message ?? "invalid"}; nothing was saved`);
  }
}

/** The operations the shortcuts a call uses stand for, in the table's order, judged against the app as read. */
export function shortcutOperations(input: Record<string, unknown>, app: ShortcutApp): AppPatchOperation[] {
  return usedShortcuts(input).flatMap((name) => {
    const shortcut = APP_SHORTCUTS[name]!;
    const parsed = shortcut.schema.safeParse(input[name]);
    if (!parsed.success) throw new GatewayError(400, "invalid_request", `${name}: ${parsed.error.issues[0]?.message ?? "invalid"}; nothing was saved`);
    return shortcut.operations(parsed.data as never, app);
  });
}
