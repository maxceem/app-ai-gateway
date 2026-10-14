/**
 * An application's warnings: things about it that will stop working on a
 * stated date, computed on every read and never stored or written. Each one
 * is `{ code, message, until?, docs_url? }`.
 *
 * Nothing produces one at the moment, so every application reads an empty
 * list; the API, the console, the CLI and MCP already surface whatever a
 * future producer adds here.
 */

import type { AppWarning } from "../contracts/responses";
import type { AppRecord } from "../core/types";

export function appWarnings(_app: AppRecord): AppWarning[] {
  return [];
}
