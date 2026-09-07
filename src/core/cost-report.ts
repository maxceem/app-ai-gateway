import type { ApiStyle } from "./api-styles";
import { asRecord } from "./records.ts";
import type { CredentialSource } from "../db/schema";

/**
 * What a response said about the request that produced it, on a route that
 * reports such things. Every field is optional and every absence means unknown:
 * none of it may ever be inferred from a successful status.
 */
export interface ProviderReport {
  /** USD the upstream says it charged, which is what the event is billed at. */
  costUsd: number | null;
  /** The host that actually served the request, as the upstream named it. */
  servedProvider: string | null;
  /** The model the upstream says it served, still in the route's own naming. */
  servedModel: string | null;
  /**
   * Whose credential paid for the inference behind a reporting service.
   * `byok` or nothing: "the operator's own upstream key" is a claim only the
   * upstream can make, and silence is recorded as silence.
   */
  credentialSource: CredentialSource | null;
}

/**
 * How one provider type reports what a request cost. The *presence* of this
 * declaration is what makes a type billable without a local price — generic
 * code asks whether a type has one and calls into it, and never knows which
 * upstream's field names are being read.
 *
 * Before this existed a bare `reportsCost: true` flag switched on OpenRouter's
 * own parsing, so a second reporting provider would have set the flag, bypassed
 * the local-price gate, and recorded every one of its requests unresolved.
 */
export interface CostReport {
  /**
   * Headers this integration needs on every request for the report to be
   * complete. Merged with the spec's own {@link ProviderSpec.requestHeaders} by
   * `providerRequestHeaders`, so the sanitizer strips a client's version of them
   * exactly as it does any other declared header.
   */
  requestHeaders?: Readonly<Record<string, string>>;
  /**
   * Fills in what one parsed response value says, and answers whether it said
   * anything at all. Only fields still unknown are written, so a caller may scan
   * the values of a stream in any order and the answer is the same.
   */
  read(value: Record<string, unknown>, report: ProviderReport): boolean;
  /**
   * A same-protocol request rewrite this integration needs, if any — the kind
   * model rewrites and output caps already are, never a conversion between
   * provider API formats. Returns whether the body changed.
   */
  mutateBody?(input: { style: ApiStyle; body: Record<string, unknown> }): boolean;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The serving host named in one value. OpenRouter reports its routing decision
 * under `openrouter_metadata` (opt-in per request — see {@link requestHeaders}),
 * marking the endpoint it picked with `selected`. A root `provider` string is
 * read as a fallback, so a response that names the host the older way still
 * populates the field.
 */
function servedProviderOf(root: Record<string, unknown>): string | null {
  const available = asRecord(asRecord(root.openrouter_metadata)?.endpoints)?.available;
  if (Array.isArray(available)) {
    for (const entry of available) {
      const endpoint = asRecord(entry);
      if (endpoint?.selected === true) {
        const named = nonEmptyString(endpoint.provider);
        if (named) return named;
      }
    }
  }
  return nonEmptyString(root.provider);
}

/**
 * What the operator's own upstream key was charged behind an OpenRouter BYOK
 * request, or `null` where the response claims none.
 *
 * The two figures are disjoint ledgers, so the money that left the operator's
 * accounts is their sum. Verified against OpenRouter's own documentation rather
 * than inferred:
 *
 * - Usage accounting defines `cost` as "the total amount charged to your
 *   account" and `cost_details.upstream_inference_cost` as "the actual cost
 *   charged by the upstream AI provider".
 * - The BYOK page prices custom provider keys at "5% of what the same
 *   model/provider would cost normally on OpenRouter".
 * - The documented example settles the inclusion question arithmetically:
 *   `cost: 0.95` alongside `upstream_inference_cost: 19`, and 0.95 is exactly
 *   5% of 19. An inclusive `cost` would read 19.95.
 * - The batch API says it outright, for sync requests too: "For BYOK-routed
 *   batches, that's only the OpenRouter BYOK fee, since the provider bills you
 *   directly for inference."
 *
 * Billing `usage.cost` alone would therefore let every BYOK request through at
 * a twentieth of its real price, with the rest invisible to every budget. On a
 * non-BYOK request the upstream figure is "0 or null", so the sum is the right
 * expression on both paths without branching.
 */
function upstreamInferenceCost(usage: Record<string, unknown> | null): number | null {
  const upstream = finiteNumber(asRecord(usage?.cost_details)?.upstream_inference_cost);
  return upstream !== null && upstream > 0 ? upstream : null;
}

/**
 * Whether the response states the inference was paid for with the operator's
 * own upstream key. OpenRouter says so outright, and says it a second way by
 * reporting what the upstream charged — a figure it only has when the operator's
 * key was the one billed.
 */
function reportedByok(root: Record<string, unknown>, usage: Record<string, unknown> | null): boolean {
  if (usage?.is_byok === true) return true;
  if (asRecord(root.openrouter_metadata)?.is_byok === true) return true;
  return upstreamInferenceCost(usage) !== null;
}

/**
 * OpenRouter's per-request self-report, the only one shipped today.
 *
 * No `mutateBody`: `usage: {include: true}` used to be injected into every chat
 * body to opt into cost accounting. OpenRouter documents accounting as always
 * on — "no additional parameters are required" — and lists `usage.include` under
 * *Deprecated Parameters*, "deprecated and have no effect"; its OpenAPI schema
 * has dropped `usage` from the chat request entirely. The injection therefore
 * bought nothing and cost a full JSON re-serialization of every chat body on the
 * hot path. If OpenRouter ever makes accounting opt-in again, this is where the
 * injection returns — as a declared mutation of this integration rather than a
 * provider check in the shared proxy path.
 */
export const OPENROUTER_COST_REPORT: CostReport = {
  // Which host actually served a request is opt-in per request; without this
  // header the response names no serving provider at all.
  requestHeaders: { "x-openrouter-metadata": "enabled" },
  read(root, report) {
    let said = false;
    const usage = asRecord(root.usage);
    if (report.costUsd === null) {
      const cost = usage ? finiteNumber(usage.cost) : null;
      // A zero is a real report — free models exist. A negative one is not a
      // charge, so it is treated as no report at all and surfaces as unresolved
      // rather than crediting a budget.
      if (cost !== null && cost >= 0) {
        // What the operator paid in total: OpenRouter's own charge plus the
        // upstream charge it reports separately for a BYOK request.
        report.costUsd = cost + (upstreamInferenceCost(usage) ?? 0);
        said = true;
      }
    }
    if (report.servedProvider === null) {
      const served = servedProviderOf(root);
      if (served !== null) {
        report.servedProvider = served;
        said = true;
      }
    }
    if (report.servedModel === null) {
      const model = nonEmptyString(root.model);
      if (model !== null) {
        report.servedModel = model;
        said = true;
      }
    }
    if (report.credentialSource === null && reportedByok(root, usage)) {
      report.credentialSource = "byok";
      said = true;
    }
    return said;
  },
};

/**
 * Reads a whole response's self-report, merging across SSE events because a
 * stream carries its cost and its routing metadata only in the final chunk.
 * `null` when the response said none of it, which is what turns a reporting
 * route's silence into an unresolved event rather than a free request.
 *
 * Scanned back to front, like `usageFromValues`: what a stream reports lives in
 * its last event, so the common case reads one value instead of every delta
 * chunk. {@link CostReport.read} never overwrites a field, so the traversal
 * order does not change the answer.
 */
export function readProviderReport(
  values: unknown[],
  integration: CostReport,
): ProviderReport | null {
  const report: ProviderReport = {
    costUsd: null,
    servedProvider: null,
    servedModel: null,
    credentialSource: null,
  };
  let reported = false;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const root = asRecord(values[index]);
    if (!root) continue;
    if (integration.read(root, report)) reported = true;
    // `credentialSource` is deliberately not required to stop: it is a claim
    // that is simply absent on a non-BYOK request, so waiting for it would mean
    // walking every chunk of every stream. The response that carries it carries
    // the cost too.
    if (
      report.costUsd !== null
      && report.servedProvider !== null
      && report.servedModel !== null
    ) {
      break;
    }
  }
  return reported ? report : null;
}
