import type { AdapterEffect, AdapterState, JsonObject, ProtocolAdapter } from '../types';
import { cap, count, invalid, keys, object } from './validation';
import type { UsageObservation } from '../../usage/pricing';

/**
 * Dormant explicit-turn implementation. Production policy has NO enabled Gemini profile.
 * A profile must establish per-turn snapshot usage and a finite output cap with live conformance.
 * Default/proactive/extended-thinking Gemini sessions cannot use this adapter.
 */
export class GeminiAdapter implements ProtocolAdapter {
  private setup = false;
  private mode: 'text' | 'audio' | null = null;
  private activity = false;
  private usage: UsageObservation | null = null;
  private turn = 0;
  constructor(private model: string, private ceiling: number) {}
  initial(): null { return null; }
  cancel(): null { return null; } // Close is the only cancellation supported in this profile.
  client(frame: JsonObject, state: AdapterState): AdapterEffect[] {
    if (frame.setup !== undefined) {
      if (this.setup) invalid('Gemini setup cannot be repeated');
      keys(frame, ['setup']); const setup = object(frame.setup);
      keys(setup, ['model', 'generationConfig', 'systemInstruction', 'realtimeInputConfig']);
      if (setup.model !== this.model && setup.model !== `models/${this.model}`) invalid('Gemini model is immutable');
      const generation = object(setup.generationConfig);
      keys(generation, ['maxOutputTokens', 'responseModalities', 'speechConfig', 'temperature', 'topP', 'topK']);
      if (!Array.isArray(generation.responseModalities) || generation.responseModalities.length !== 1 || !['TEXT', 'AUDIO'].includes(String(generation.responseModalities[0]))) invalid('Unsupported Gemini modality');
      const config = object(setup.realtimeInputConfig);
      keys(config, ['automaticActivityDetection', 'activityHandling', 'turnCoverage']);
      const detection = object(config.automaticActivityDetection); keys(detection, ['disabled']);
      if (detection.disabled !== true) invalid('Gemini automatic activity detection must be disabled');
      if (config.activityHandling !== undefined && config.activityHandling !== 'NO_INTERRUPTION') invalid('Gemini interruption is unsupported');
      this.setup = true;
      return [{ kind: 'configure', frame: { setup: { ...setup, model: `models/${this.model}`, generationConfig: { ...generation, maxOutputTokens: cap(generation.maxOutputTokens, this.ceiling) }, realtimeInputConfig: { ...config, activityHandling: 'NO_INTERRUPTION' } } } }];
    }
    if (!state.ready || state.configuring || !this.setup) invalid('Wait for Gemini setupComplete');
    if (frame.clientContent !== undefined) {
      keys(frame, ['clientContent']); if (state.active || this.mode === 'audio') invalid('Gemini overlapping or mixed turns are unsupported');
      const content = object(frame.clientContent); keys(content, ['turns', 'turnComplete']);
      if (content.turnComplete !== true || !Array.isArray(content.turns) || content.turns.length !== 1) invalid('Send one complete Gemini text turn');
      const turn = object(content.turns[0]); keys(turn, ['role', 'parts']);
      if (turn.role !== 'user' || !Array.isArray(turn.parts) || !turn.parts.length) invalid('Expected user text');
      for (const raw of turn.parts) { const part = object(raw); keys(part, ['text']); if (typeof part.text !== 'string') invalid('Only text is supported'); }
      this.mode = 'text'; this.usage = null; this.turn++;
      return [{ kind: 'generate', frame }];
    }
    keys(frame, ['realtimeInput']); const input = object(frame.realtimeInput);
    if (this.mode === 'text') invalid('Gemini input mode is locked to text');
    if (input.activityStart !== undefined) {
      keys(input, ['activityStart']); keys(object(input.activityStart), []);
      if (state.active || this.activity) invalid('Nested Gemini activity is unsupported');
      this.mode = 'audio'; this.activity = true; this.usage = null; this.turn++;
      return [{ kind: 'generate', frame, inputActivity: true }];
    }
    if (!this.activity || !state.active) invalid('Gemini audio requires an admitted activity');
    if (input.activityEnd !== undefined) {
      keys(input, ['activityEnd']); keys(object(input.activityEnd), []); this.activity = false;
      return [{ kind: 'forward', frame, input: true, useful: true, endInput: true }];
    }
    keys(input, ['audio']); const audio = object(input.audio); keys(audio, ['data', 'mimeType']);
    if (typeof audio.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/u.test(audio.data) || audio.mimeType !== 'audio/pcm;rate=16000') invalid('Expected 16 kHz Gemini PCM');
    return [{ kind: 'forward', frame, input: true, useful: true }];
  }
  server(frame: JsonObject, state: AdapterState): AdapterEffect[] {
    if (frame.setupComplete !== undefined) {
      if (!this.setup || state.ready || state.active) invalid('Unexpected Gemini setup acknowledgement');
      keys(object(frame.setupComplete), []);
      return [{ kind: 'ready' }, { kind: 'forward', frame }];
    }
    if (frame.toolCall !== undefined || frame.sessionResumptionUpdate !== undefined) invalid('Unsupported Gemini server feature');
    const effects: AdapterEffect[] = [];
    if (frame.usageMetadata !== undefined) {
      if (!state.active) invalid('Unattributed Gemini usage');
      this.usage = geminiSnapshot(frame.usageMetadata);
      effects.push({ kind: 'observe', usage: this.usage });
    }
    if (frame.serverContent !== undefined) {
      if (!state.active) invalid('Unadmitted Gemini output');
      const content = object(frame.serverContent);
      if (content.interrupted === true) invalid('Unexpected Gemini interruption');
      if (content.turnComplete === true) {
        if (this.activity) invalid('Gemini turn completed before activityEnd');
        effects.push({ kind: 'finalize', responseId: `gemini-turn-${this.turn}`, status: 'completed', usage: this.usage, frame });
        return effects;
      }
    }
    effects.push({ kind: 'forward', frame }); return effects;
  }
}
/** Candidate per-turn snapshot strategy, never summed or differenced across rolling context. */
export function geminiSnapshot(value: unknown): UsageObservation {
  const raw = object(value); const input = count(raw.promptTokenCount); const output = count(raw.responseTokenCount);
  const cached = count(raw.cachedContentTokenCount ?? 0);
  if (cached !== 0 || (raw.thoughtsTokenCount !== undefined && count(raw.thoughtsTokenCount) !== 0)) invalid('Cached/thinking usage is unverified for this Gemini profile');
  const modalities = (values: unknown, total: number) => {
    if (!Array.isArray(values)) return invalid('Gemini modality usage is missing');
    let sum = 0; let audio = 0;
    for (const value of values) { const entry = object(value); const tokens = count(entry.tokenCount); sum += tokens;
      if (entry.modality === 'AUDIO') audio += tokens; else if (entry.modality !== 'TEXT') invalid('Unsupported Gemini modality'); }
    if (sum !== total) invalid('Inconsistent Gemini usage'); return { audio };
  };
  return { inputTokens: input, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: output,
    modalityTokens: { input: modalities(raw.promptTokensDetails, input), output: modalities(raw.responseTokensDetails, output), cachedInput: {} } };
}
