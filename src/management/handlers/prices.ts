import type { OperationHandlerTable } from "../executor";
import { modelPrices } from "../prices";

export const priceHandlers = {
  /** Supplies the priced model catalog used by the proxy-policy editor. */
  listModelPrices: () => modelPrices(),
} satisfies OperationHandlerTable;
