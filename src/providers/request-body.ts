/**
 * Reading a client body and writing the one that goes upstream, for both kinds
 * of served request.
 *
 * A proxied request and a custom endpoint differ in who chose the path and the
 * model — the client or the application's configuration — and in nothing about
 * how a body is read, bounded, re-encoded with another model, capped, or handed
 * to the provider type's and the route's own same-protocol rewrites. Those
 * steps live here once, so the two paths cannot drift into two policies.
 */

import type { ApiStyle, OutputClampStyle } from "../shared/capabilities.ts";
import { GatewayError } from "../core/errors.ts";
import { clampOutput } from "./protocols.ts";
import { costReport } from "./provider-type.ts";
import type { ResolvedRoute } from "./route-adapters.ts";
import { providerDescriptor, type ProviderType } from "../shared/providers.ts";

export const MAX_REQUEST_BYTES = 20 * 1024 * 1024;

/**
 * The whole request body, or a 413 before any of it reaches a provider. The
 * return type is exact on purpose: an `ArrayBuffer`-backed view is what the
 * runtime accepts as a `BodyInit`, and what lets callers forward these bytes
 * without copying them.
 */
export async function readBodyLimited(request: Request): Promise<Uint8Array<ArrayBuffer>> {
  const declared = request.headers.get("content-length");
  if (declared && Number.parseInt(declared, 10) > MAX_REQUEST_BYTES) {
    throw new GatewayError(413, "payload_too_large", "Request body exceeds 20 MB");
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new GatewayError(413, "payload_too_large", "Request body exceeds 20 MB");
    }
    chunks.push(value);
  }
  // Exactly `total` bytes at offset 0, never a view onto something larger:
  // callers hand this array straight to `fetch` and to `Request` as a body,
  // which is only the same bytes because of that.
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export function isMultipart(contentType: string): boolean {
  return contentType.toLowerCase().startsWith("multipart/form-data");
}

/** A multipart body as its form. The bytes themselves are the body; nothing is copied to parse it. */
export function parseForm(bytes: Uint8Array<ArrayBuffer>, contentType: string): Promise<FormData> {
  return new Request("https://local.invalid", {
    method: "POST",
    headers: { "content-type": contentType },
    body: bytes,
  }).formData();
}

/**
 * The form with its `model` field replaced. A fresh form, so a fallback attempt
 * never sees the model an earlier attempt wrote, and so fetch writes a new
 * boundary for it — the caller drops the client's `content-type`.
 */
export function formWithModel(source: FormData, model: string): FormData {
  const form = new FormData();
  source.forEach((value, name) => {
    if (name !== "model") form.append(name, value as string | File);
  });
  form.set("model", model);
  return form;
}

/**
 * What a transcription for this provider type must be sent as so its answer
 * carries the measure it is billed by: `null` where it already is, the
 * `response_format` to send it with instead, or `"refuse"` where no format the
 * client could have meant carries one — a plain-text answer, or a field that
 * is not text at all. See `transcriptionFormats` in `src/shared/providers.ts`.
 */
export function meteredTranscriptionFormat(
  provider: ProviderType,
  requested: FormDataEntryValue | null,
): { send: string } | "refuse" | null {
  const formats = providerDescriptor(provider).transcriptionFormats;
  if (!formats) return null;
  if (requested !== null && typeof requested !== "string") return "refuse";
  const format = requested ?? formats.default;
  if (formats.metered.includes(format)) return null;
  const upgrade = formats.upgrades?.[format];
  return upgrade ? { send: upgrade } : "refuse";
}

/** The answer to a transcription format {@link meteredTranscriptionFormat} refuses. */
export function unmeteredTranscriptionFormat(provider: ProviderType): GatewayError {
  const metered = providerDescriptor(provider).transcriptionFormats?.metered ?? [];
  return new GatewayError(
    400,
    "invalid_request",
    `This response_format answers without the usage or duration a transcription is billed by; use ${metered.join(" or ")}`,
  );
}

export function jsonObject(bytes: Uint8Array): Record<string, unknown> {
  return jsonObjectFromText(new TextDecoder().decode(bytes));
}

/**
 * The same, for a caller that already holds the text. A request whose body is
 * forwarded unchanged is forwarded as that text, so decoding the bytes a second
 * time to produce it was a second pass over every byte of every JSON request.
 */
export function jsonObjectFromText(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not object");
    return value as Record<string, unknown>;
  } catch {
    throw new GatewayError(400, "invalid_request", "Request body must be a JSON object");
  }
}

/**
 * A same-protocol request rewrite the provider type's cost-report integration
 * asks for, if it declares one. Generic on purpose: this asks whether the type
 * has an integration and hands it the body, and never knows which provider's
 * fields are being written.
 */
export function costReportBodyMutation(
  provider: ProviderType,
  style: ApiStyle,
  body: Record<string, unknown>,
): boolean {
  return costReport(provider)?.mutateBody?.({ style, body }) ?? false;
}

/**
 * Everything the gateway itself writes into a JSON body once its model is set,
 * in order: the output cap, the provider type's cost-report rewrite, and the
 * route's own routing directive last, so it wins over anything a client put in
 * the same field. Every step is same-protocol — the provider behind the route
 * sees the payload it would have seen anyway. Returns whether the body changed.
 */
export function finishJsonBody(
  body: Record<string, unknown>,
  input: {
    provider: ProviderType;
    route: ResolvedRoute;
    style: ApiStyle;
    clamp: OutputClampStyle;
    cap: number | undefined;
  },
): boolean {
  const capped = clampOutput(input.clamp, input.provider, body, input.cap);
  const reported = costReportBodyMutation(input.provider, input.style, body);
  const routed = input.route.adapter.mutateBody?.({
    routeConfig: input.route.config,
    style: input.style,
    body,
  }) ?? false;
  return capped || reported || routed;
}
