// Opt-in release checks. No prompts, output audio, or credentials are logged.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import WebSocket from 'ws';
import { liveRealtimeConnection } from './realtime-connection.mjs';

if (process.argv[2] !== '--live' || process.argv[3] !== 'openai' || !process.argv[4] || !process.env.REALTIME_PCM_FILE) {
  console.error('Usage: REALTIME_PCM_FILE=<24kHz mono signed 16-bit PCM fixture> node scripts/realtime-modes.mjs --live openai MODEL. Explicitly spends provider credits.');
  process.exit(2);
}
const model = process.argv[4];
const { url, headers, transport } = await liveRealtimeConnection('openai', model);
const pcm = await readFile(process.env.REALTIME_PCM_FILE);
assert.ok(pcm.length >= 4800 && pcm.length <= 48000 * 10 && pcm.length % 2 === 0, 'Use a 0.1–10 second PCM fixture');
const socket = new WebSocket(url, { headers, handshakeTimeout: 10_000, maxPayload: 1024 * 1024 });
const queue = []; const waits = [];
let failure; let audioBytes = 0; let complete = false; let phase = 'setup'; let gatewayErrorCode;
function fail() {
  if (complete || failure) return;
  failure = new Error('Realtime mode check failed');
  for (const waiter of waits.splice(0)) { clearTimeout(waiter.timer); waiter.reject(failure); }
}
socket.on('message', raw => {
  try {
    const frame = JSON.parse(String(raw));
    if (frame.error || frame.type === 'gateway.error' || frame.type === 'error') {
      if (frame.type === 'gateway.error' && /^[a-z_]{1,80}$/u.test(frame.error?.code)) gatewayErrorCode = frame.error.code;
      return fail();
    }
    if (frame.type === 'response.output_audio.delta') audioBytes += frame.delta.length;
    if (!['session.created', 'session.updated', 'input_audio_buffer.committed', 'response.created', 'response.done'].includes(frame.type)) return;
    const index = waits.findIndex(waiter => waiter.type === frame.type);
    if (index < 0) { if (queue.length >= 100) return fail(); queue.push(frame); }
    else { const waiter = waits.splice(index, 1)[0]; clearTimeout(waiter.timer); waiter.resolve(frame); }
  } catch { fail(); }
});
socket.on('error', fail); socket.on('close', fail);
function next(type) {
  if (failure) return Promise.reject(failure);
  const index = queue.findIndex(frame => frame.type === type);
  if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
  return new Promise((resolve, reject) => {
    const waiter = { type, resolve, reject, timer: setTimeout(() => { fail(); socket.terminate(); }, 20_000) };
    waits.push(waiter);
  });
}
function send(frame) { socket.send(JSON.stringify(frame)); }
async function configure(session) {
  send({ type: 'session.update', session: { type: 'realtime', max_output_tokens: 256, tools: [], tool_choice: 'auto', audio: { input: { turn_detection: null, transcription: null } }, ...session } });
  const ack = (await next('session.updated')).session;
  assert.equal(ack.model, model); assert.ok(ack.max_output_tokens <= 256);
  assert.equal(ack.audio.input.transcription, null);
  if (session.tools) assert.deepEqual(ack.tools, session.tools);
  if (session.tool_choice) assert.deepEqual(ack.tool_choice, session.tool_choice);
  if (ack.audio.input.turn_detection) {
    assert.equal(ack.audio.input.turn_detection.create_response, transport === 'gateway' ? false : session.audio.input.turn_detection.create_response);
    assert.equal(ack.audio.input.turn_detection.interrupt_response, transport === 'gateway' ? false : session.audio.input.turn_detection.interrupt_response);
  }
}
const results = [];
function terminal(label, frame, statuses = ['completed']) {
  const response = frame.response; const usage = response.usage;
  assert.ok(statuses.includes(response.status));
  assert.ok(Number.isSafeInteger(usage.input_tokens) && usage.input_tokens >= 0);
  assert.ok(Number.isSafeInteger(usage.output_tokens) && usage.output_tokens >= 0 && usage.output_tokens <= 256);
  assert.ok(usage.input_token_details && usage.output_token_details);
  results.push({ mode: label, status: response.status, usage });
  return response;
}
async function audio(realtime = false) {
  const bytes = Buffer.concat([pcm, Buffer.alloc(48000)]);
  for (let offset = 0; offset < bytes.length; offset += 4800) {
    send({ type: 'input_audio_buffer.append', audio: bytes.subarray(offset, offset + 4800).toString('base64') });
    if (realtime) await new Promise(resolve => setTimeout(resolve, 100));
  }
}
try {
  if (transport === 'gateway') await next('session.updated');
  else await next('session.created');

  phase = 'manual_audio';
  await configure({ output_modalities: ['audio'], instructions: 'Reply only with hello, very briefly.' });
  await audio(); send({ type: 'input_audio_buffer.commit' }); await next('input_audio_buffer.committed');
  send({ type: 'response.create' }); await next('response.created');
  const spoken = terminal('manual_audio', await next('response.done'), ['completed', 'incomplete']);
  assert.ok(spoken.usage.input_token_details.audio_tokens > 0 && spoken.usage.output_token_details.audio_tokens > 0 && audioBytes > 0);

  phase = 'function_call';
  await configure({ output_modalities: ['audio'], instructions: 'You must call get_hello to fetch the greeting in English. Do not invent the greeting.', tools: [{ type: 'function', name: 'get_hello', description: 'Fetches a greeting in the requested language.', parameters: { type: 'object', properties: { language: { type: 'string', enum: ['en'] } }, required: ['language'], additionalProperties: false } }], tool_choice: 'required' });
  send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fetch the English greeting using get_hello.' }] } });
  send({ type: 'response.create' }); await next('response.created');
  const toolResponse = terminal('function_call_audio', await next('response.done'));
  const tool = toolResponse.output.find(item => item.type === 'function_call');
  if (!tool?.call_id) console.error(JSON.stringify({ diagnostic: 'missing_function_call', outputItems: toolResponse.output.map(item => ({ type: ['function_call', 'message'].includes(item.type) ? item.type : 'other', hasCallId: typeof item.call_id === 'string' })) }));
  assert.ok(tool?.call_id);
  phase = 'function_result_followup';
  send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: tool.call_id, output: '{"greeting":"hello"}' } });
  await configure({ output_modalities: ['text'], tool_choice: 'none' });
  send({ type: 'response.create', response: { instructions: 'Say hello briefly.' } }); await next('response.created');
  terminal('function_result_followup', await next('response.done'));

  phase = 'managed_vad';
  await configure({ output_modalities: ['text'], instructions: 'Say hello briefly.', audio: { input: { transcription: null, turn_detection: { type: 'server_vad', silence_duration_ms: 200, create_response: true, interrupt_response: true } } } });
  await audio(true); await next('input_audio_buffer.committed'); await next('response.created');
  const vad = terminal(transport === 'gateway' ? 'managed_vad' : 'provider_vad', await next('response.done'));
  // VAD admission follows the committed item. Bill the provider's reported
  // modality counters; it can report cached/text context after audio input.
  assert.ok(vad.usage.input_tokens > 0);

  phase = 'cancel';
  await configure({ output_modalities: ['audio'] });
  send({ type: 'response.create', response: { instructions: 'Count from one to one hundred slowly.' } }); await next('response.created');
  send({ type: 'response.cancel' });
  terminal('cancel', await next('response.done'), ['cancelled']);
  complete = true;
  console.log(JSON.stringify({ provider: 'openai', model, transport, modes: results, audioBytes }));
  socket.close(1000);
} catch {
  complete = true; socket.terminate(); process.exitCode = 1;
  console.error(JSON.stringify({ failure: 'realtime_mode_conformance', phase, completedModes: results.map(result => result.mode), gatewayErrorCode }));
}
