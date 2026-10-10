import type { RealtimeProtocol } from '../shared/capabilities';
import type { ProtocolAdapter } from './types';
import { OpenAIAdapter } from './protocols/openai';
import { GeminiAdapter } from './protocols/gemini';

/** Official origins only. These requests never contain client-controlled headers. */
export function upstreamRequest(protocol: RealtimeProtocol, model: string, secret: string): Request {
  if (protocol === 'openai_realtime') {
    const url = new URL('https://api.openai.com/v1/realtime');
    url.searchParams.set('model', model);
    return new Request(url, { headers: { Upgrade: 'websocket', Authorization: `Bearer ${secret}` }, redirect: 'manual' });
  }
  return new Request('https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent', {
    headers: { Upgrade: 'websocket', 'x-goog-api-key': secret }, redirect: 'manual',
  });
}

export function protocolAdapter(protocol: RealtimeProtocol, model: string, outputCap: number): ProtocolAdapter {
  return protocol === 'openai_realtime' ? new OpenAIAdapter(model, outputCap) : new GeminiAdapter(model, outputCap);
}
