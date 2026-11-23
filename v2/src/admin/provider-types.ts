/**
 * The provider types a connection can be added for, as the management API
 * serves them (`../providers/provider-types.ts` builds the list), so the CLI
 * and agents learn a new provider or style from the gateway, never from a
 * release of their own.
 */
import type { Context } from "hono";
import type { OperationResponse } from "../contracts/catalog.ts";
import { providerTypes } from "../providers/provider-types.ts";
import type { AdminVariables } from "./actor.ts";

export function listProviderTypes(c: Context<{ Bindings: Env; Variables: AdminVariables }>): Response {
  return c.json({
    types: providerTypes().map((entry) => ({ ...entry, styles: [...entry.styles], operations: [...entry.operations] })),
  } satisfies OperationResponse<"listProviderTypes">);
}
