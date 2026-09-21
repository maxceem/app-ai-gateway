import type { AppResponse as WireAppResponse } from "@contracts/responses";
import type { AppWriteInput } from "@contracts/schemas";
import { ConfigError, parseAppConfig, type AppConfig } from "@shared/app-config";
import type { AppConfigDraft, ProviderConfig } from "./config-types";
import type { AppResponse, AppUpsertBody, InvalidAppResponse, ValidAppResponse } from "./types";

function rawObject(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value));
}

function invalidResponse(response: WireAppResponse, message: string): InvalidAppResponse {
  const { config, ...metadata } = response.app;
  return {
    kind: "invalid",
    app: { ...metadata, config: rawObject(config) },
    config_error: message,
  };
}

/**
 * Converts the broad repair-capable wire response into a discriminated editor
 * result.
 *
 * The configuration is parsed rather than resolved a second time: the server
 * stores what this same schema produced, so parsing here is the identity on
 * every row the server accepted — and the one row it did not is exactly the
 * `config_error` case the repair editor exists for.
 */
export function fromWireApp(response: WireAppResponse): AppResponse {
  if (response.config_error !== null) return invalidResponse(response, response.config_error);
  try {
    const config = parseAppConfig(response.app.config);
    const { config: _raw, ...metadata } = response.app;
    return { kind: "valid", app: { ...metadata, config }, config_error: null } satisfies ValidAppResponse;
  } catch (error) {
    return invalidResponse(
      response,
      error instanceof Error ? error.message : "Invalid stored configuration",
    );
  }
}

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

/** Materializes form-only omissions, then validates and normalizes before an HTTP request starts. */
export function normalizeAppConfigDraft(draft: AppConfigDraft): AppConfig {
  const providers = draft.routing.providers.mode === "all"
    ? { mode: "all" as const }
    : { mode: "selected" as const, selected: selectedPolicies(draft) };
  return parseAppConfig({
    ...draft,
    routing: {
      providers,
      model_rewrites: draft.routing.model_rewrites ?? {},
    },
  });
}

export function toAppWrite(body: AppUpsertBody): AppWriteInput {
  if (body.name.trim().length === 0) throw new ConfigError("name must be a non-empty string");
  if (body.name.length > 100) throw new ConfigError("name must be at most 100 characters");
  return {
    name: body.name,
    config: normalizeAppConfigDraft(body.config),
    ...(body.status === undefined ? {} : { status: body.status }),
  } satisfies AppWriteInput;
}
