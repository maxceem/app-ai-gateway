import { GatewayError } from "../../core/errors";
import type { JsonObject } from "../types";

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;

export function invalid(message: string): never {
  throw new GatewayError(400, "realtime_protocol_error", message);
}

export function object(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid("Expected a JSON object");
  }
  return value as JsonObject;
}

export function keys(value: JsonObject, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid("Unsupported realtime field");
}

export function id(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    return invalid("Invalid event or item identifier");
  }
  return value;
}

export function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return invalid("Invalid provider usage");
  return value as number;
}

export function cap(value: unknown, ceiling: number): number {
  if (value === undefined) return ceiling;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    return invalid("Output limit must be finite and positive");
  }
  return Math.min(value as number, ceiling);
}

/** Whether `value` is a string of base64 characters, as audio chunks are sent. */
export function isBase64(value: unknown): boolean {
  return typeof value === "string" && BASE64.test(value);
}

/** Whether `value` names exactly one modality, and an allowed one. */
export function isSingleModality(value: unknown, allowed: readonly string[]): boolean {
  return Array.isArray(value) && value.length === 1 && allowed.includes(String(value[0]));
}
