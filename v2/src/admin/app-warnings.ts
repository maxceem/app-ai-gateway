/**
 * An app's warnings: things about it that will stop working on a stated date,
 * worked out on every read and never stored, as v1 (`appWarnings` at the
 * repository root). Each one is `{ code, message, until?, docs_url? }`.
 *
 * Nothing produces one yet, as in v1, so every app reads an empty list. The
 * API, the CLI and MCP already pass on whatever a producer adds here; the
 * console's warnings on the app page come with the console's own gaps.
 */
import type { z } from "zod";
import type { AppWarningSchema } from "../contracts/admin.ts";

export type AppWarning = z.infer<typeof AppWarningSchema>;

export function appWarnings(): AppWarning[] {
  return [];
}
