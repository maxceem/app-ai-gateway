import models from "../../usage/models.json";
import type { OperationHandlerTable } from "../executor";

export const priceHandlers = {
  /** Supplies the priced model catalog used by the proxy-policy editor. */
  listModelPrices: () => ({ prices: models }),
} satisfies OperationHandlerTable;
