/**
 * How saving judges a model an app lists on a route, for tests: the one
 * listed-model rule (`listedModelRefusal`), then each call the route admits
 * for it, by the one save rule (`callGap`), as `judgeApp` runs them.
 */
import { callGap, listedModelRefusal, reachableCalls, type PriceSources } from "../src/pricing/billability.ts";
import { builtInProvider } from "../src/providers/index.ts";
import type { OperationDescription } from "../src/providers/operation.ts";

/** Null when the model may be listed; `{}` when no enabled operation serves it; else the operation that charges it only partly. */
export function listedJudgement(operations: readonly OperationDescription[], sources: PriceSources, model: string): { readonly operation?: string } | null {
  const route = { operations: operations.map((operation) => operation.name), models: [model] };
  if (listedModelRefusal(route, undefined, sources, operations, model) !== null) return {};
  const description = builtInProvider(sources.type)!;
  const { calls } = reachableCalls({ routing: { providers: { main: route } } }, () => ({ sources, description }));
  const short = calls.find((call) => callGap(call) !== null);
  return short === undefined ? null : { operation: short.operation.name };
}
