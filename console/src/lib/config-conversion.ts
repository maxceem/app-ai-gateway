import type { AppWriteInput } from "@contracts/schemas";
import { parseAppConfig, parseAppWrite, type AppConfig } from "@shared/app-config";
import type { AppConfigDraft, ProviderConfig } from "./config-types";
import type { AppUpsertBody } from "./types";

function selectedPolicies(draft: AppConfigDraft): Record<string, ProviderConfig> {
  return Object.fromEntries(
    Object.entries(draft.routing.providers.selected ?? {})
      .filter((entry): entry is [string, ProviderConfig] => entry[1] !== undefined)
      .map(([slug, policy]) => [slug, {
        ...policy,
        allowed_paths: policy.allowed_paths ?? [],
        allowed_models: policy.allowed_models ?? [],
      }]),
  );
}

/** The draft with its form-only omissions filled in: what the schema is asked about. */
export function materializeAppConfigDraft(draft: AppConfigDraft): unknown {
  const providers = draft.routing.providers.mode === "all"
    ? { mode: "all" as const }
    : { mode: "selected" as const, selected: selectedPolicies(draft) };
  return {
    ...draft,
    routing: {
      providers,
      model_rewrites: draft.routing.model_rewrites ?? {},
    },
  };
}

/** Materializes form-only omissions, then validates and normalizes before an HTTP request starts. */
export function normalizeAppConfigDraft(draft: AppConfigDraft): AppConfig {
  return parseAppConfig(materializeAppConfigDraft(draft));
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
