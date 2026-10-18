import type { PricesResponse } from "../contracts/responses";
import models from "../usage/models.json";

/**
 * The priced model catalog this deployment enforces, as `listModelPrices`
 * serves it. One reader of the shipped file, so an example written from it
 * names exactly the models the price list would.
 */
export function modelPrices(): PricesResponse {
  // JSON imports widen `kind` to a string; the shipped catalog's kinds are held
  // to `MODEL_KINDS` by test/usage.test.ts.
  return { prices: models as PricesResponse["prices"] };
}
