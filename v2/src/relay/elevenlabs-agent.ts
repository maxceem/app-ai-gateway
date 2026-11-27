/**
 * ElevenLabs agents, relayed (plan step 11, 11a): what the gateway asks ElevenLabs itself.
 *
 * - At `open`, a single-use signed URL for the session's agent, with `include_conversation_id=true`, so
 *   the conversation's id is in it before the call starts (`signedSessionUrl`). The relay connects there,
 *   and keeps the id as the session's provider call id. The key goes only through the vault, sealed for
 *   the session (its ticket's copy), as for any call.
 * - After the call, ElevenLabs' own record of the conversation settles the session (`elevenlabsLookup`,
 *   by the rules every lookup follows, `./session-lookup.ts`): `metadata.cost_fiat`, its list-price figure
 *   in dollars, plus `voice_surcharge_charge` if it is ever filled in (T16, and ElevenLabs' reference:
 *   it "is not included in `cost`"), which is in credits, so it is turned into dollars at the record's own
 *   `cost_fiat` / `cost`.
 */
import { errorFacts } from "../core/error-facts.ts";
import { log } from "../core/log.ts";
import { vault, type SealedCallCredentials } from "../vault/client.ts";
import { sessionLookup, type Figure } from "./session-lookup.ts";
import type { Ticket } from "./tickets.ts";

/** How long asking for the signed URL may take: it is on the session's way to its first audio (T17a: about 250 ms). */
const SIGNED_URL_MS = 5_000;

/** Why the signed URL could not be had: a code, never a value from ElevenLabs' answer. */
export class SignedUrlRefused extends Error {
  constructor(readonly status: number) {
    super("signed_url_refused");
    this.name = "SignedUrlRefused";
  }
}

/**
 * The session's signed URL, from ElevenLabs: its request is the session's address with `/get-signed-url`
 * after the path, the same query (the agent, and the app's options such as `branch_id`), and
 * `include_conversation_id=true`, which makes the URL start one conversation only. Throws
 * `SignedUrlRefused` when ElevenLabs refuses or answers no URL; anything else (the vault, a timeout) throws
 * as it is. The URL is never logged: it starts a conversation.
 */
export async function signedSessionUrl(env: Env, ticket: Ticket): Promise<string> {
  const ask = new URL(ticket.url);
  ask.pathname = `${ask.pathname.replace(/\/+$/u, "")}/get-signed-url`;
  ask.searchParams.set("include_conversation_id", "true");
  const deadline = Date.now() + SIGNED_URL_MS;
  const response = await vault(env).call({
    url: ask.toString(),
    method: "GET",
    headers: new Headers({ accept: "application/json" }),
    body: null,
    signal: AbortSignal.timeout(SIGNED_URL_MS),
    deadline,
    credentials: ticket.seal as SealedCallCredentials,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new SignedUrlRefused(response.status);
  }
  let signed: unknown;
  try {
    signed = ((await response.json()) as { signed_url?: unknown } | null)?.signed_url;
  } catch (error) {
    log("warn", "elevenlabs_signed_url_unreadable", { app: ticket.app, session: ticket.sid, error: errorFacts(error) });
    throw new SignedUrlRefused(response.status);
  }
  if (typeof signed !== "string" || signed.length > 4096 || !URL.canParse(signed)) throw new SignedUrlRefused(response.status);
  return signed;
}

/**
 * The charges known to be inside `cost_fiat` (T16: `cost` = `llm_charge` + `platform_charge`, and
 * `call_charge` the same as `platform_charge`), and the voice surcharge, which is added. Any other charge
 * that is not zero, a top-level `*_charge` or the post-call analysis's (`analysis.total`), makes the
 * figure doubtful until its part in the bill is confirmed: the estimate stays (Sol, #275 round 1).
 */
const KNOWN_CHARGES = new Set(["call_charge", "platform_charge", "llm_charge", "voice_surcharge_charge"]);

/** A number, when the value is a finite one. @param value */
const numberOf = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * What a conversation record says (`GET v1/convai/conversations/{id}`): `final` once its `status` is `done`
 * or `failed`, with `cost_fiat` (null, a call that never started, is $0: judged by the caller) plus the
 * voice surcharge in dollars; `pending` while ElevenLabs is still on it (`initiated`, `in-progress`,
 * `processing`); `doubtful` when a charge can't be counted: a surcharge with no credit price to turn it
 * into dollars, or another charge that is not zero (`KNOWN_CHARGES`).
 */
export function conversationFigure(record: unknown): { readonly kind: "final"; readonly usd: number } | { readonly kind: "pending" } | { readonly kind: "doubtful" } {
  const fields = typeof record === "object" && record !== null ? (record as { status?: unknown; metadata?: unknown }) : {};
  if (fields.status !== "done" && fields.status !== "failed") return { kind: "pending" };
  const metadata = typeof fields.metadata === "object" && fields.metadata !== null ? (fields.metadata as Record<string, unknown>) : {};
  const fiat = numberOf(metadata.cost_fiat) ?? 0;
  const charging = typeof metadata.charging === "object" && metadata.charging !== null ? (metadata.charging as Record<string, unknown>) : {};
  for (const [name, value] of Object.entries(charging)) {
    if (name.endsWith("_charge") && !KNOWN_CHARGES.has(name) && (numberOf(value) ?? 0) !== 0) return { kind: "doubtful" };
  }
  const analysis = (charging.analysis as { total?: { charge?: unknown; price?: unknown } } | null | undefined)?.total;
  if ((numberOf(analysis?.charge) ?? 0) !== 0 || (numberOf(analysis?.price) ?? 0) !== 0) return { kind: "doubtful" };
  const surcharge = numberOf(charging.voice_surcharge_charge) ?? 0;
  if (surcharge === 0) return { kind: "final", usd: fiat };
  const credits = numberOf(metadata.cost) ?? 0;
  if (credits <= 0 || fiat <= 0) return { kind: "doubtful" };
  return { kind: "final", usd: fiat + (surcharge * fiat) / credits };
}

/** The sweep's handler for an agent call's lookup (`PROVIDER_LOOKUPS.elevenlabs` in `../ledger/sweep.ts`). */
export const elevenlabsLookup = sessionLookup("elevenlabs", async (get, conversationId): Promise<Figure> => {
  const record = await get(`v1/convai/conversations/${encodeURIComponent(conversationId)}`);
  // A key that may not read conversations won't gain it within the hour.
  if (record.status === 401 || record.status === 403) return { kind: "keep", message: "session_lookup_refused", facts: { status: record.status } };
  // ElevenLabs makes the record when the conversation starts: one not found is gone, with its agent deleted (plan step 11).
  if (record.status === 404) return { kind: "keep", message: "session_lookup_record_gone" };
  if (record.status !== 200) return { kind: "retry", reason: `record answered ${record.status}` };
  const figure = conversationFigure(record.body);
  if (figure.kind === "pending") return { kind: "retry", reason: "record not complete" };
  if (figure.kind === "doubtful") return { kind: "keep", message: "session_lookup_figure_doubtful" };
  return figure;
});
