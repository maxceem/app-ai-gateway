import { GatewayError } from '../core/errors';
import type { AppRecord } from '../core/types';
import { providerPolicyFor } from '../shared/app-config';
import { lookup } from '../shared/records';
import type { ResolvedProvider } from '../providers/provider-store';
import { modelPrice, type Price } from '../usage/pricing';
import type { RealtimeProtocol } from '../shared/capabilities';
import { REALTIME_LIMITS } from './limits';

/** Supported realtime profiles, independent of catalog membership. */
export const OPENAI_REALTIME_MODELS = ['gpt-realtime', 'gpt-realtime-mini'] as const;
export function realtimePolicy(app: AppRecord, provider: ResolvedProvider, requestedModel: string): {
  model: string; protocol: RealtimeProtocol; path: string; outputCap: number; price: Price;
} {
  if (!app.config.realtime.enabled) throw new GatewayError(403, 'realtime_not_supported', 'Realtime is disabled for this app');
  if (provider.route.kind !== 'direct' || provider.baseUrl !== null) throw new GatewayError(400, 'realtime_not_supported', 'Realtime requires an official direct provider origin');
  const policy = providerPolicyFor(app.config.routing, provider.slug);
  if (!policy) throw new GatewayError(403, 'path_not_allowed', 'Provider is disabled for this app');
  const requested = requestedModel.replace(/^models\//u, '');
  if (policy.allowed_models.length && !policy.allowed_models.includes(requested)) throw new GatewayError(403, 'model_not_allowed', 'Model is not allowed');
  const model = lookup(app.config.routing.model_rewrites, requested) ?? requested;
  if (provider.type !== 'openai' || !OPENAI_REALTIME_MODELS.some(value => value === model)) {
    throw new GatewayError(400, 'realtime_not_supported', provider.type === 'gemini'
      ? 'Gemini Live profiles are unavailable until live usage attribution and output-cap conformance are verified'
      : 'This model has no supported realtime profile');
  }
  const path = 'v1/realtime';
  if (policy.allowed_paths.length && !policy.allowed_paths.some(entry => (typeof entry === 'string' ? entry : entry.path) === path)) {
    throw new GatewayError(403, 'path_not_allowed', 'Provider realtime path is not allowed');
  }
  const price = modelPrice(provider.type, model, provider.pricing);
  const required = ['input', 'output', 'audio_input', 'audio_output', 'cached_input', 'cached_audio_input'] as const;
  if (!price || required.some(field => typeof price[field] !== 'number' || !Number.isFinite(price[field]) || price[field]! < 0)) {
    throw new GatewayError(400, 'pricing_not_configured', 'Realtime needs text, audio, and cached text/audio prices');
  }
  return { model, protocol: 'openai_realtime', path, price, outputCap: Math.min(policy.max_output_tokens ?? REALTIME_LIMITS.outputTokens, REALTIME_LIMITS.outputTokens) };
}
