import type { AppWriteInput } from "@contracts/schemas";
import { parseAppConfig, parseAppWrite, type AppConfig } from "@shared/app-config";
import type { AppConfigDraft } from "./config-types";
import type { AppUpsertBody } from "./types";

/** Validates and normalizes the draft before an HTTP request starts. */
export function normalizeAppConfigDraft(draft: AppConfigDraft): AppConfig {
  return parseAppConfig(draft);
}

/**
 * The draft as the write the API takes, held to the API's own schema: the one
 * place the console decides whether a save would be accepted.
 */
export function toAppWrite(body: AppUpsertBody): AppWriteInput {
  return parseAppWrite({
    name: body.name,
    config: normalizeAppConfigDraft(body.config),
    ...(body.status === undefined ? {} : { status: body.status }),
  });
}
