import { GatewayError } from '../../core/errors';
import type { JsonObject } from '../types';
export function invalid(message: string): never {
  throw new GatewayError(400, 'realtime_protocol_error', message);
}
export function object(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid('Expected a JSON object');
  return value as JsonObject;
}
export function keys(value: JsonObject, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid('Unsupported realtime field');
}
export function id(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) return invalid('Invalid event or item identifier');
  return value;
}
export function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return invalid('Invalid provider usage');
  return value as number;
}
export function cap(value: unknown, ceiling: number): number {
  if (value === undefined) return ceiling;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) return invalid('Output limit must be finite and positive');
  return Math.min(value as number, ceiling);
}
