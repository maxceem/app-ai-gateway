/**
 * Our price list, as the management API serves it: the price file as it is,
 * in dollars per million units, keyed by provider type and model. The console
 * and the CLI list models from it, so they name exactly what can be billed.
 */
import type { Context } from "hono";
import type { OperationResponse } from "../contracts/catalog.ts";
import { PRICE_FILE } from "../pricing/price-file.ts";
import type { AdminVariables } from "./actor.ts";

export function listModelPrices(c: Context<{ Bindings: Env; Variables: AdminVariables }>): Response {
  return c.json({ prices: PRICE_FILE as Record<string, Record<string, Record<string, unknown>>> } satisfies OperationResponse<"listModelPrices">);
}
