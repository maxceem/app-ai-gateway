import { z } from "zod";
import type { OperationResponse } from "../contracts/catalog";
import {
  APP_ATTEST_ENVIRONMENTS,
  APP_ATTEST_VERIFY_ON,
  type AppPatchOperation,
} from "../contracts/schemas";
import { GatewayError } from "../core/errors";
import { parseRequest } from "../management/validation";
import { APP_STATUSES } from "../shared/app-status";

/**
 * Shorthand arguments for one setting deep inside a document.
 *
 * A shortcut is declared once, here, beside the tool it belongs to, and is an
 * ordinary optional argument of that tool: MCP's `tools/list` advertises it,
 * and `agw` turns it into a flag with its help — `team_id` becomes
 * `--team-id` — without knowing where the setting lives. Where it lives is
 * this table's to say, so moving a setting moves its shortcut with it, and no
 * installed CLI writes to the old place.
 *
 * A shortcut stands for patch operations rather than a value, so it can write
 * more than one leaf, keep what is already there beside the one it changes,
 * or refuse a document it does not apply to in its own words.
 */
export interface Shortcut<Doc> {
  /** The value it takes, with the description `tools/list` and `agw --help` show. */
  schema: z.ZodType;
  /**
   * The patch operations it stands for, given its parsed value and the
   * document as the explicit operations before it leave it — not yet judged,
   * so read defensively: the whole result is judged once it is written.
   */
  operations(value: never, current: Doc): AppPatchOperation[];
}

export type Shortcuts<Doc> = Readonly<Record<string, Shortcut<Doc>>>;

/** Every shortcut as an optional argument, for a tool's input. */
export function shortcutInput<Doc>(shortcuts: Shortcuts<Doc>): Record<string, z.ZodType> {
  return Object.fromEntries(Object.entries(shortcuts).map(([name, shortcut]) => [name, shortcut.schema.optional()]));
}

/** The shortcuts one call's arguments use: those present with a value. */
export function usedShortcuts<Doc>(shortcuts: Shortcuts<Doc>, input: Record<string, unknown>): string[] {
  return Object.keys(shortcuts).filter((name) => input[name] !== undefined && input[name] !== null);
}

/**
 * The operations the shortcuts a call uses stand for, in the table's order.
 * Each value is parsed with its own schema first, and refused in the words
 * every argument is refused in.
 */
export function shortcutOperations<Doc>(
  shortcuts: Shortcuts<Doc>,
  input: Record<string, unknown>,
  current: Doc,
): AppPatchOperation[] {
  const used = usedShortcuts(shortcuts, input);
  const parsed = parseRequest(
    z.object(Object.fromEntries(used.map((name) => [name, shortcuts[name]!.schema]))),
    Object.fromEntries(used.map((name) => [name, input[name]])),
  ) as Record<string, never>;
  return used.flatMap((name) => shortcuts[name]!.operations(parsed[name]!, current));
}

// ---------------------------------------------------------------------------
// patch_app
// ---------------------------------------------------------------------------

type AppDocument = OperationResponse<"getApp">["app"];

const replace = (path: string, value: unknown): AppPatchOperation => ({ op: "replace", path, value });

/** A setting only an iOS app has, refused by name for any other. */
function appAttest(argument: string, setting: string): Shortcut<AppDocument>["operations"] {
  return (value: never, app) => {
    if (app.config?.authentication?.type !== "apple_app_attest") {
      throw new GatewayError(400, "invalid_request", `${argument}: only an iOS (App Attest) app has this setting`);
    }
    return [replace(`/config/authentication/app_attest/${setting}`, value)];
  };
}

/**
 * The shortcuts of `patch_app`: what `agw app update` has always taken as
 * flags, now declared beside the gateway that knows where each one lives.
 */
export const APP_SHORTCUTS: Shortcuts<AppDocument> = {
  name: {
    schema: z.string().min(1).meta({ description: "The app's new name." }),
    operations: (value: string) => [replace("/name", value)],
  },
  status: {
    schema: z.enum(APP_STATUSES).meta({
      description: "active serves requests; disabled pauses the app reversibly.",
    }),
    operations: (value: string) => [replace("/status", value)],
  },
  team_id: {
    schema: z.string().min(1).meta({ description: "An iOS app's Apple team ID, ten uppercase letters or digits." }),
    operations: appAttest("team_id", "team_id"),
  },
  bundle_id: {
    schema: z.string().min(1).meta({ description: "An iOS app's bundle ID, such as com.example.app." }),
    operations: appAttest("bundle_id", "bundle_id"),
  },
  attest_environments: {
    schema: z.array(z.enum(APP_ATTEST_ENVIRONMENTS)).min(1).meta({
      description: "The App Attest environments an iOS app accepts. Production releases should accept production only.",
    }),
    operations: appAttest("attest_environments", "environments"),
  },
  verify_on: {
    schema: z.enum(APP_ATTEST_VERIFY_ON).meta({
      description: "When an iOS app's App Attest assertion is checked: every_request, or once per hourly token at token_exchange.",
    }),
    operations: appAttest("verify_on", "verify_on"),
  },
  providers: {
    schema: z.array(z.string().min(1)).min(1).meta({
      description: "The slugs of the only providers the app may use. A provider it already selected keeps its allowed paths and models.",
    }),
    operations: (value: string[], app) => {
      const routing = app.config?.routing?.providers;
      const previous: Record<string, unknown> = routing?.mode === "selected" ? routing.selected ?? {} : {};
      return [replace("/config/routing/providers", {
        // Within the mode it already has, the block keeps whatever else is in it.
        ...(routing?.mode === "selected" ? routing : {}),
        mode: "selected",
        selected: Object.fromEntries(
          value.map((slug) => [slug, previous[slug] ?? { allowed_paths: [], allowed_models: [] }]),
        ),
      })];
    },
  },
  all_providers: {
    schema: z.literal(true).meta({ description: "Let the app use every provider of the account." }),
    operations: (_value: true, app) =>
      app.config?.routing?.providers?.mode === "all" ? [] : [replace("/config/routing/providers", { mode: "all" })],
  },
};
