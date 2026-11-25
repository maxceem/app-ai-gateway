/**
 * A provider's own report of what a request cost (ported from v1's
 * `src/shared/cost-report.ts`). Read from the same response as the usage;
 * where there is one, the charge is billed at it (`price_source:
 * provider_usd`), converted to nano-dollars once (D20).
 *
 * A negative figure is not a charge: it reads as no report, never as a credit.
 */
import type { ProviderCostReport } from "../providers/operation.ts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * What OpenRouter says the inference cost on a request paid with the
 * customer's own upstream key (BYOK). OpenRouter's `usage.cost` is then only
 * its own 5% fee, and the upstream's charge is reported apart; the money that
 * left the customer is their sum. On any other request it is 0 or absent.
 */
function upstreamInferenceCost(usage: Record<string, unknown> | null): number {
  const upstream = finiteNumber(asRecord(usage?.cost_details)?.upstream_inference_cost);
  return upstream !== null && upstream > 0 ? upstream : 0;
}

/** OpenRouter: `usage.cost` on every Chat Completions answer, in dollars. */
function openRouterCost(root: Record<string, unknown>): number | null {
  const usage = asRecord(root.usage);
  const cost = usage ? finiteNumber(usage.cost) : null;
  // A zero is a real report: free models exist.
  if (cost === null || cost < 0) return null;
  return cost + upstreamInferenceCost(usage);
}

/** xAI's billing unit: `cost_in_usd_ticks` counts ten-billionths of a dollar. */
const XAI_TICKS_PER_USD = 10_000_000_000;

/**
 * xAI: `usage.cost_in_usd_ticks`, the amount actually billed after every
 * discount, at the root of an answer and under `response` on the event that
 * closes a Responses stream.
 */
function xaiCost(root: Record<string, unknown>): number | null {
  const usage = asRecord(root.usage) ?? asRecord(asRecord(root.response)?.usage);
  const ticks = usage ? finiteNumber(usage.cost_in_usd_ticks) : null;
  if (ticks === null || ticks < 0) return null;
  return ticks / XAI_TICKS_PER_USD;
}

/**
 * Perplexity: `usage.cost.total_cost`, in dollars, at the root of an answer
 * and under `response` on the event that closes an Agent API stream
 * (`response.completed`). The Agent API's holds what the tokens cost and what
 * the built-in tools it ran cost (`tool_calls_cost`, such as a web search);
 * Sonar's, its request fee (`request_cost`). No token price of ours covers
 * either. Sonar names no currency; a figure in another currency than US
 * dollars is no report.
 */
function perplexityCost(root: Record<string, unknown>): number | null {
  const usage = asRecord(root.usage) ?? asRecord(asRecord(root.response)?.usage);
  const cost = asRecord(usage?.cost);
  if (cost === null) return null;
  if (cost.currency !== undefined && cost.currency !== "USD") return null;
  const total = finiteNumber(cost.total_cost);
  return total === null || total < 0 ? null : total;
}

const READERS: Readonly<Record<ProviderCostReport, (root: Record<string, unknown>) => number | null>> = {
  openrouter: openRouterCost,
  xai: xaiCost,
  perplexity: perplexityCost,
};

/**
 * How finely a provider's figure is rounded, in dollars, where it is rounded
 * coarser than a call can cost: Perplexity gives five decimals, so a small
 * call reads $0. Such a figure is never charged below what our price says the
 * call's usage costs (`../proxy/call-charge.ts`).
 */
const ROUNDED_TO_USD: Partial<Record<ProviderCostReport, number>> = { perplexity: 0.00001 };

/** The step a provider's figure is rounded to, in dollars, or null when it is exact. */
export function costReportStep(report: ProviderCostReport): number | null {
  return ROUNDED_TO_USD[report] ?? null;
}

/**
 * The reader of one document's cost in dollars, or null when it reports
 * none. A stream reports its cost in its final chunk: the body reader keeps
 * the last one reported.
 */
export function costReader(report: ProviderCostReport): (root: Record<string, unknown>) => number | null {
  return READERS[report];
}
