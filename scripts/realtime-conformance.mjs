// Explicit opt-in only. Reads credentials from the environment, never arguments or stdout.
import WebSocket from 'ws';
import { performance } from 'node:perf_hooks';
import { liveRealtimeConnection } from './realtime-connection.mjs';

if (process.argv[2] !== '--live' || !['openai', 'gemini'].includes(process.argv[3])) {
  console.error('Usage: node scripts/realtime-conformance.mjs --live openai|gemini MODEL\nThis explicitly spends provider credits. Set REALTIME_PROVIDER_KEY, REALTIME_GATEWAY_URL/TOKEN, or CF_ACCOUNT_ID/CF_GATEWAY_NAME/CF_GATEWAY_API_KEY (stored provider keys).');
  process.exit(2);
}
const provider = process.argv[3];
const model = process.argv[4];
if (!model) throw new Error('Specify an exact model profile');
const { url, headers, transport } = await liveRealtimeConnection(provider, model);
const gateway = transport === 'gateway';
const socket = new WebSocket(url, { headers, maxPayload: 1024 * 1024, handshakeTimeout: 10_000 });
const started = performance.now();
const cap = 32;
let phase = gateway && provider === 'openai' ? 'gateway_initial' : 'setup'; let turns = 0; let responseId = null; let latestUsage = null;
let finished = false;
let sentAt = 0; const latencies = []; const snapshots = [];
const timer = setTimeout(() => fail('timeout'), 30_000);
function fail(reason = 'protocol_validation') {
  if (finished) return; finished = true; clearTimeout(timer); socket.terminate(); process.exitCode = 1;
  console.error(`Realtime conformance failed: ${reason} (no payloads or credentials logged).`);
}
function rejection(error) {
  const message = String(error?.message ?? '').toLowerCase();
  if (/api.?key|credential|unauth|permission/u.test(message)) return 'upstream_authentication';
  if (/model.*(not found|unsupported|not supported|does not exist)/u.test(message)) return 'upstream_model_unavailable';
  if (/max.?output.?tokens|output.?token/u.test(message)) return 'upstream_output_cap_rejected';
  return 'upstream_rejected_configuration';
}
function send(value) { socket.send(JSON.stringify(value)); }
function nextTurn() {
  if (turns === 2) {
    finished = true; clearTimeout(timer); socket.close(1000);
    console.log(JSON.stringify({ provider, model, scope: 'manual_text_only', transport, turns, outputCap: cap, elapsedMs: Math.round(performance.now() - started), terminalLatencyMs: latencies, usageSnapshots: snapshots })); return;
  }
  turns++; latestUsage = null; responseId = null; phase = 'response'; sentAt = performance.now();
  if (provider === 'openai') {
    send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hello briefly.' }] } });
    send({ type: 'response.create', response: { max_output_tokens: cap, output_modalities: ['text'] } });
  } else send({ clientContent: { turns: [{ role: 'user', parts: [{ text: 'Say hello briefly.' }] }], turnComplete: true } });
}
socket.on('open', () => {
  if (provider === 'openai' && !gateway) send({ type: 'session.update', session: { type: 'realtime', max_output_tokens: cap, output_modalities: ['text'], audio: { input: { turn_detection: null, transcription: null } }, tools: [] } });
  else if (provider === 'gemini') send({ setup: { model: `models/${model}`, generationConfig: { maxOutputTokens: cap, responseModalities: ['AUDIO'] }, realtimeInputConfig: { automaticActivityDetection: { disabled: true }, activityHandling: 'NO_INTERRUPTION' } } });
});
socket.on('message', data => {
  try {
    const event = JSON.parse(String(data));
    if (event.error || event.type === 'error' || event.type === 'gateway.error') return fail(rejection(event.error));
    if (event.toolCall || event.goAway) return fail('unsupported_server_feature');
    if (provider === 'openai') {
      if (event.type === 'session.updated' && phase === 'gateway_initial') {
        phase = 'setup';
        send({ type: 'session.update', session: { type: 'realtime', max_output_tokens: cap, output_modalities: ['text'], audio: { input: { turn_detection: null, transcription: null } }, tools: [] } });
      } else if (event.type === 'session.updated' && phase === 'setup') {
        if (event.session.model !== model) {
          if (/^gpt-[a-z0-9._-]{1,100}$/u.test(event.session.model)) console.error(JSON.stringify({ requestedModel: model, acknowledgedModel: event.session.model }));
          return fail('acknowledged_model_mismatch');
        }
        if (!Number.isSafeInteger(event.session.max_output_tokens) || event.session.max_output_tokens <= 0 || event.session.max_output_tokens > cap || event.session.audio.input.turn_detection !== null || event.session.audio.input.transcription != null) return fail('unsafe_configuration_acknowledgement');
        nextTurn();
      } else if (event.type === 'response.created') {
        if (phase !== 'response' || responseId !== null) return fail(); responseId = event.response.id;
      } else if (event.type === 'response.done') {
        const response = event.response; const usage = response.usage;
        if (response.status !== 'completed') return fail('response_not_completed');
        if (!responseId || response.id !== responseId || !usage || !Number.isSafeInteger(usage.input_tokens) || usage.input_tokens < 0 || !Number.isSafeInteger(usage.output_tokens) || usage.output_tokens < 0 || usage.output_tokens > cap || !usage.input_token_details || !usage.output_token_details) return fail();
        snapshots.push(usage); latencies.push(Math.round(performance.now() - sentAt)); phase = 'between'; nextTurn();
      }
    } else {
      if (event.setupComplete && phase === 'setup') return nextTurn();
      if (event.usageMetadata) {
        if (phase !== 'response') return fail('gemini_unattributed_usage'); latestUsage = event.usageMetadata;
        if (!Number.isSafeInteger(latestUsage.promptTokenCount) || latestUsage.promptTokenCount < 0 || !Number.isSafeInteger(latestUsage.responseTokenCount) || latestUsage.responseTokenCount < 0) return fail('gemini_usage_counters_missing');
        if (latestUsage.responseTokenCount > cap) return fail('gemini_output_cap_violated');
        if (latestUsage.thoughtsTokenCount > 0) return fail('gemini_thinking_tokens_unsupported');
      }
      if (event.serverContent?.turnComplete) {
        // Deliberately fail when usage arrives too late or cannot be attributed to this turn.
        if (!latestUsage || phase !== 'response') return fail('gemini_terminal_before_usage');
        snapshots.push(latestUsage); latencies.push(Math.round(performance.now() - sentAt)); phase = 'between'; nextTurn();
      }
    }
  } catch { fail(); }
});
socket.on('unexpected-response', (_request, response) => { response.resume(); fail(`http_${response.statusCode}`); });
socket.on('error', () => fail('transport_error'));
socket.on('close', (code, reason) => { if (!finished) fail(`close_${code}_${rejection({ message: String(reason) })}`); });
