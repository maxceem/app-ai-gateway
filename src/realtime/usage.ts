import { computeCost, type Price, type UsageObservation } from "../usage/pricing";
import type { ProviderPricing } from "../db/schema";
import type { UsageEvent } from "../usage/usage-record";
import { count, invalid, object } from "./relay/protocols/validation";
import type { Bootstrap, RealtimeProtocol, Settlement, UsageTicket } from "./relay/contract";

/**
 * Reading a realtime provider's usage, and recording it.
 *
 * This is the gateway's side of a response's usage. The realtime Worker sends
 * the provider's usage object as it arrived, with the ticket admission wrote,
 * and the gateway reads and prices it here. So a change in how usage is read
 * or priced is a gateway release, which leaves open sessions alone.
 */

/**
 * What each session check hands the realtime Worker, for its responses' usage
 * records: the record's metadata, and the price, as of that check. No secret,
 * so the realtime Worker may store it.
 */
export interface RealtimeTicket {
  /** The ticket's shape. A ticket can be read up to seven days after it was written, by a later release. */
  v: 1;
  event: UsageEvent;
  price: Price;
}

/** The provider's usage object read into token counts; null when it is missing or inconsistent. */
export function realtimeUsage(protocol: RealtimeProtocol, value: unknown): UsageObservation | null {
  if (value === null || value === undefined) return null;
  try {
    return protocol === "openai_realtime" ? openAIUsage(value) : geminiSnapshot(value);
  } catch {
    return null;
  }
}

/**
 * The usage record of a settled response. A response without usage the
 * gateway can read and price is recorded as `unresolved`, at no cost.
 */
export function settledEvent(bootstrap: Pick<Bootstrap, "protocol">, settlement: Settlement): UsageEvent {
  const { event, price } = settlement.ticket as unknown as RealtimeTicket;
  const usage = realtimeUsage(bootstrap.protocol, settlement.usage);
  const { row } = event;
  const cost = usage
    ? computeCost(row.providerType as "openai" | "gemini", row.model, usage, {
      [row.model]: price as ProviderPricing[string],
    })
    : null;
  const { status } = settlement;
  return {
    ...event,
    // The ticket is the session's; the response's own id and time are these.
    eventId: settlement.generationId,
    row: {
      ...row,
      eventId: settlement.generationId,
      realtimeGenerationId: settlement.generationId,
      createdAt: new Date(settlement.at).toISOString(),
      inputTokens: usage?.inputTokens ?? 0,
      cachedInputTokens: usage?.cachedInputTokens ?? 0,
      cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      modalityTokens: usage?.modalityTokens ?? {},
      tokenVariants: usage?.tokenVariants ?? {},
      costUsd: cost ?? 0,
      costSource: cost === null ? "unresolved" : "computed",
      providerResponseId: settlement.responseId,
      completionStatus: status,
      status: status === "failed" ? "provider_error" : "ok",
      // A failed response says why, as every failure does; the provider's own
      // reason stays with the app, which received its error event.
      error: status === "failed" ? "provider_error" : null,
      clientAborted: settlement.aborted ? 1 : null,
      latencyMs: Math.max(0, settlement.latencyMs),
    },
  };
}

/** The ticket admission hands the realtime Worker to store. */
export function realtimeTicket(ticket: Omit<RealtimeTicket, "v">): UsageTicket {
  return { v: 1, ...ticket } as unknown as UsageTicket;
}

/** OpenAI reports total prompt tokens including cached tokens and per-modality cached details. */
export function openAIUsage(value: unknown): UsageObservation {
  const usage = object(value);
  const total = count(usage.input_tokens);
  const output = count(usage.output_tokens);
  const input = object(usage.input_token_details);
  const out = object(usage.output_token_details);
  const cached = count(input.cached_tokens);
  const cachedDetails = input.cached_tokens_details === undefined && cached === 0
    ? { audio_tokens: 0, text_tokens: 0 }
    : object(input.cached_tokens_details);
  const audio = count(input.audio_tokens);
  const text = count(input.text_tokens);
  const cachedAudio = count(cachedDetails.audio_tokens);
  const cachedText = count(cachedDetails.text_tokens);
  const outputAudio = count(out.audio_tokens);
  const outputText = count(out.text_tokens);
  if (
    audio + text !== total ||
    cachedAudio + cachedText !== cached ||
    cachedAudio > audio ||
    cachedText > text ||
    cached > total ||
    outputAudio + outputText !== output
  ) {
    invalid("Inconsistent realtime modality usage");
  }
  return {
    inputTokens: total - cached,
    cachedInputTokens: cached,
    cacheWriteTokens: 0,
    outputTokens: output,
    // The modality count covers the whole prompt, cached part included; the
    // cached audio is the `cached_input` bucket's audio variant. See
    // `splitCachedModalities` in `src/usage/pricing.ts`.
    modalityTokens: {
      input: { audio },
      output: { audio: outputAudio },
    },
    tokenVariants: { cached_input: { audio: cachedAudio } },
  };
}

/** Candidate per-turn snapshot strategy, never summed or differenced across rolling context. */
export function geminiSnapshot(value: unknown): UsageObservation {
  const raw = object(value);
  const input = count(raw.promptTokenCount);
  const output = count(raw.responseTokenCount);
  const cached = count(raw.cachedContentTokenCount ?? 0);
  if (cached !== 0 || (raw.thoughtsTokenCount !== undefined && count(raw.thoughtsTokenCount) !== 0)) {
    invalid("Cached/thinking usage is unverified for this Gemini profile");
  }
  return {
    inputTokens: input,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: output,
    modalityTokens: {
      input: modalityUsage(raw.promptTokensDetails, input),
      output: modalityUsage(raw.responseTokensDetails, output),
    },
  };
}

/** The audio share of one direction's per-modality details, which must add up to its `total`. */
function modalityUsage(values: unknown, total: number): { audio: number } {
  if (!Array.isArray(values)) return invalid("Gemini modality usage is missing");
  let sum = 0;
  let audio = 0;
  for (const value of values) {
    const entry = object(value);
    const tokens = count(entry.tokenCount);
    sum += tokens;
    if (entry.modality === "AUDIO") {
      audio += tokens;
    } else if (entry.modality !== "TEXT") {
      invalid("Unsupported Gemini modality");
    }
  }
  if (sum !== total) invalid("Inconsistent Gemini usage");
  return { audio };
}
