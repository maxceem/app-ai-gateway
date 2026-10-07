import type { AdapterEffect, AdapterState, JsonObject, ProtocolAdapter } from '../types';
import type { UsageObservation } from '../../usage/pricing';
import { cap, count, id, invalid, keys, object } from './validation';

/** GA conversation profile: text/PCM audio, function tools, manual or mediated server VAD. */
export class OpenAIAdapter implements ProtocolAdapter {
  private auto = false;
  private interrupt = false;
  private seenCommits = new Set<string>();
  private toolCalls = new Set<string>();
  private requestedVad: JsonObject | null = null;
  private outputCap: number;
  constructor(private model: string, private ceiling: number) { this.outputCap = ceiling; }

  initial(): JsonObject {
    return { type: 'session.update', session: {
      type: 'realtime', max_output_tokens: this.ceiling,
      audio: { input: { turn_detection: null, transcription: null, format: { type: 'audio/pcm', rate: 24000 } } },
      tools: [],
    } };
  }
  cancel(): JsonObject { return { type: 'response.cancel' }; }

  private configuration(frame: JsonObject): JsonObject {
    keys(frame, ['type', 'event_id', 'session']);
    const session = object(frame.session);
    keys(session, ['type', 'model', 'instructions', 'audio', 'output_modalities', 'tools', 'tool_choice', 'max_output_tokens', 'truncation']);
    if (session.type !== undefined && session.type !== 'realtime') invalid('Only realtime conversation sessions are supported');
    if (session.model !== undefined && session.model !== this.model) invalid('Session model is immutable');
    if (session.output_modalities !== undefined && (!Array.isArray(session.output_modalities) || session.output_modalities.length !== 1 || !['text', 'audio'].includes(String(session.output_modalities[0])))) invalid('Unsupported output modalities');
    const audio = session.audio === undefined ? {} : object(session.audio);
    keys(audio, ['input', 'output']);
    const input = audio.input === undefined ? {} : object(audio.input);
    keys(input, ['format', 'noise_reduction', 'turn_detection', 'transcription']);
    if (input.transcription !== undefined && input.transcription !== null) invalid('Input transcription is unavailable');
    if (input.format !== undefined) {
      const format = object(input.format);
      keys(format, ['type', 'rate']);
      if (format.type !== 'audio/pcm' || format.rate !== 24000) invalid('Only 24 kHz PCM input is supported');
    }
    if (input.turn_detection !== undefined) {
      if (input.turn_detection === null) { this.requestedVad = null; this.auto = false; this.interrupt = false; }
      else {
        const vad = object(input.turn_detection);
        keys(vad, ['type', 'threshold', 'prefix_padding_ms', 'silence_duration_ms', 'create_response', 'interrupt_response']);
        if (vad.type !== 'server_vad') invalid('Only manual or server_vad turn detection is supported');
        for (const field of ['create_response', 'interrupt_response']) if (vad[field] !== undefined && typeof vad[field] !== 'boolean') invalid('Invalid VAD control');
        for (const field of ['threshold', 'prefix_padding_ms', 'silence_duration_ms']) if (vad[field] !== undefined && (typeof vad[field] !== 'number' || !Number.isFinite(vad[field]) || vad[field] < 0)) invalid('Invalid VAD parameter');
        this.auto = vad.create_response !== false;
        this.interrupt = vad.interrupt_response !== false;
        this.requestedVad = { ...vad, create_response: false, interrupt_response: false };
      }
    }
    if (audio.output !== undefined) {
      const output = object(audio.output); keys(output, ['format', 'voice', 'speed']);
      if (output.format !== undefined) { const format = object(output.format); keys(format, ['type', 'rate']); if (format.type !== 'audio/pcm' || format.rate !== 24000) invalid('Only PCM output is supported'); }
    }
    if (session.tools !== undefined) {
      if (!Array.isArray(session.tools) || session.tools.length > 32) invalid('Invalid function tools');
      for (const raw of session.tools) {
        const tool = object(raw); keys(tool, ['type', 'name', 'description', 'parameters']);
        if (tool.type !== 'function') invalid('Hosted tools are unavailable');
        id(tool.name);
      }
    }
    if (session.max_output_tokens !== undefined) this.outputCap = cap(session.max_output_tokens, this.ceiling);
    return { ...frame, session: { ...session, type: 'realtime', max_output_tokens: this.outputCap,
      audio: { ...audio, input: { ...input, transcription: null, turn_detection: this.requestedVad } } } };
  }

  client(frame: JsonObject, state: AdapterState): AdapterEffect[] {
    if (frame.type === 'session.update') {
      if (state.configuring || state.active) invalid('Wait for session configuration and the active response to finish');
      return [{ kind: 'configure', frame: this.configuration(frame) }];
    }
    if (!state.ready || state.configuring) invalid('Wait for the safe session.updated acknowledgement before input');
    switch (frame.type) {
      case 'response.create': {
        keys(frame, ['type', 'event_id', 'response']);
        if (this.auto) invalid('Manual response.create conflicts with managed VAD; select manual mode first');
        const response = frame.response === undefined ? {} : object(frame.response);
        keys(response, ['instructions', 'output_modalities', 'max_output_tokens', 'metadata']);
        if (response.output_modalities !== undefined && (!Array.isArray(response.output_modalities) || response.output_modalities.length !== 1 || !['text', 'audio'].includes(String(response.output_modalities[0])))) invalid('Unsupported output modalities');
        return [{ kind: 'generate', frame: { ...frame, response: { ...response, max_output_tokens: cap(response.max_output_tokens, this.outputCap) } } }];
      }
      case 'response.cancel':
        keys(frame, ['type', 'event_id', 'response_id']);
        if (!state.active || (frame.response_id !== undefined && frame.response_id !== state.responseId)) invalid('No matching active response');
        return [{ kind: 'cancel' }];
      case 'input_audio_buffer.append':
        keys(frame, ['type', 'event_id', 'audio']);
        if (typeof frame.audio !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/u.test(frame.audio)) invalid('Expected base64 PCM audio');
        return [{ kind: 'forward', frame, useful: true, input: true }];
      case 'input_audio_buffer.commit':
      case 'input_audio_buffer.clear':
        keys(frame, ['type', 'event_id']);
        if (this.auto && frame.type === 'input_audio_buffer.commit') invalid('Managed VAD commits audio upstream');
        return [{ kind: 'forward', frame, input: true }];
      case 'conversation.item.create': {
        keys(frame, ['type', 'event_id', 'previous_item_id', 'item']);
        const item = object(frame.item); keys(item, ['id', 'type', 'role', 'content', 'call_id', 'output']);
        if (item.id !== undefined) id(item.id);
        if (item.type === 'function_call_output') {
          const call = id(item.call_id);
          if (!this.toolCalls.delete(call) || typeof item.output !== 'string') invalid('Function result has no outstanding call');
        } else {
          if (item.type !== 'message' || !['user', 'assistant', 'system'].includes(String(item.role)) || !Array.isArray(item.content)) invalid('Unsupported conversation item');
          for (const raw of item.content) {
            const part = object(raw); keys(part, ['type', 'text', 'audio']);
            if (!['input_text', 'text', 'input_audio'].includes(String(part.type))) invalid('Unsupported input content');
            if (part.type === 'input_audio' && typeof part.audio !== 'string') invalid('Expected audio');
            if (part.type !== 'input_audio' && typeof part.text !== 'string') invalid('Expected text');
          }
        }
        return [{ kind: 'forward', frame, useful: true, input: true }];
      }
      case 'conversation.item.truncate':
        keys(frame, ['type', 'event_id', 'item_id', 'content_index', 'audio_end_ms']); id(frame.item_id);
        if (!Number.isSafeInteger(frame.audio_end_ms) || (frame.audio_end_ms as number) < 0) invalid('Invalid audio truncation');
        return [{ kind: 'forward', frame }];
      case 'conversation.item.delete':
        keys(frame, ['type', 'event_id', 'item_id']); id(frame.item_id);
        return [{ kind: 'forward', frame }];
      default: return invalid('Unsupported realtime client event');
    }
  }

  server(frame: JsonObject, state: AdapterState): AdapterEffect[] {
    if (frame.type === 'session.updated') {
      const session = object(frame.session);
      const input = object(object(session.audio).input);
      const vad = input.turn_detection;
      if (session.model !== this.model || typeof session.max_output_tokens !== 'number' || session.max_output_tokens > this.outputCap || session.max_output_tokens <= 0 || input.transcription != null) invalid('Unsafe upstream configuration acknowledgement');
      if (vad !== null && (object(vad).create_response !== false || object(vad).interrupt_response !== false || object(vad).idle_timeout_ms != null)) invalid('Autonomous generation was not disabled');
      if ((this.requestedVad === null) !== (vad === null)) invalid('Unexpected upstream turn detection');
      return [{ kind: 'ready' }, { kind: 'forward', frame }];
    }
    if (frame.type === 'input_audio_buffer.speech_started' && this.auto && this.interrupt && state.active) {
      return [{ kind: 'cancel' }, { kind: 'forward', frame }];
    }
    if (frame.type === 'input_audio_buffer.committed' && this.auto) {
      const item = id(frame.item_id);
      if (this.seenCommits.has(item)) return [];
      if (this.seenCommits.size >= 1000) invalid('Committed item limit exceeded');
      this.seenCommits.add(item);
      const trigger = { type: 'response.create', response: { max_output_tokens: this.outputCap } };
      return [{ kind: 'forward', frame }, state.active ? { kind: 'pendingAuto', frame: trigger, correlation: item } : { kind: 'generate', frame: trigger, correlation: item }];
    }
    if (frame.type === 'response.created') {
      const response = object(frame.response);
      if (!state.active || state.responseId !== null) invalid('Unadmitted provider response');
      return [{ kind: 'created', responseId: id(response.id) }, { kind: 'forward', frame }];
    }
    if (frame.type === 'response.done') {
      const response = object(frame.response);
      const responseId = id(response.id);
      if (!state.active || state.responseId !== responseId) invalid('Unmatched terminal response');
      if (!['completed', 'cancelled', 'failed', 'incomplete'].includes(String(response.status))) invalid('Unsupported response status');
      if (Array.isArray(response.output)) for (const raw of response.output) {
        const item = object(raw); if (item.type === 'function_call') this.toolCalls.add(id(item.call_id));
      }
      return [{ kind: 'finalize', responseId, usage: response.usage == null ? null : openAIUsage(response.usage), status: response.status as 'completed' | 'cancelled' | 'failed' | 'incomplete', frame }];
    }
    if (typeof frame.type === 'string' && frame.type.startsWith('response.') && (!state.active || (frame.response_id !== undefined && frame.response_id !== state.responseId))) invalid('Unadmitted provider output');
    if (frame.type === 'error') invalid('Provider rejected a realtime event');
    return [{ kind: 'forward', frame }];
  }
}

/** OpenAI reports total prompt tokens including cached tokens and per-modality cached details. */
export function openAIUsage(value: unknown): UsageObservation {
  const usage = object(value);
  const total = count(usage.input_tokens); const output = count(usage.output_tokens);
  const input = object(usage.input_token_details); const out = object(usage.output_token_details);
  const cached = count(input.cached_tokens);
  const cachedDetails = input.cached_tokens_details === undefined && cached === 0 ? { audio_tokens: 0, text_tokens: 0 } : object(input.cached_tokens_details);
  const audio = count(input.audio_tokens); const text = count(input.text_tokens);
  const cachedAudio = count(cachedDetails.audio_tokens); const cachedText = count(cachedDetails.text_tokens);
  const outputAudio = count(out.audio_tokens); const outputText = count(out.text_tokens);
  if (audio + text !== total || cachedAudio + cachedText !== cached || cachedAudio > audio || cachedText > text || cached > total || outputAudio + outputText !== output) invalid('Inconsistent realtime modality usage');
  return { inputTokens: total - cached, cachedInputTokens: cached, cacheWriteTokens: 0, outputTokens: output,
    modalityTokens: { input: { audio: audio - cachedAudio }, cachedInput: { audio: cachedAudio }, output: { audio: outputAudio } } };
}
