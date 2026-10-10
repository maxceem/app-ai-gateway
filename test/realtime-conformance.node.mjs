import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { realtimeConnection, liveRealtimeConnection } from '../scripts/realtime-connection.mjs';

async function fixture(fail = false, status = 'completed') {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port;
  const events = [];
  server.on('connection', socket => {
    const ack = max => ({ type: 'session.updated', session: { model: 'gpt-realtime', max_output_tokens: max, audio: { input: { turn_detection: null, transcription: null } } } });
    socket.send(JSON.stringify(ack(4096)));
    let turns = 0;
    socket.on('message', raw => {
      const event = JSON.parse(String(raw)); events.push(event.type);
      if (fail) { socket.send(JSON.stringify({ type: 'error', error: { message: 'do-not-print-fixture-secret' } })); return; }
      if (event.type === 'session.update') socket.send(JSON.stringify(ack(event.session.max_output_tokens)));
      if (event.type === 'response.create') {
        const id = `r-${++turns}`;
        socket.send(JSON.stringify({ type: 'response.created', response: { id } }));
        socket.send(JSON.stringify({ type: 'response.done', response: { id, status, usage: { input_tokens: 1, output_tokens: 1, input_token_details: { audio_tokens: 0, text_tokens: 1, cached_tokens: 0 }, output_token_details: { audio_tokens: 0, text_tokens: 1 } } } }));
      }
    });
  });
  const child = spawn(process.execPath, ['scripts/realtime-conformance.mjs', '--live', 'openai', 'gpt-realtime'], {
    cwd: new URL('..', import.meta.url),
    env: { PATH: process.env.PATH, REALTIME_GATEWAY_URL: `ws://127.0.0.1:${port}/realtime`, REALTIME_GATEWAY_TOKEN: 'do-not-print-fixture-secret' },
  });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const code = await new Promise(resolve => child.once('exit', resolve));
  await new Promise(resolve => server.close(resolve));
  assert.ok(!stdout.includes('do-not-print-fixture-secret')); assert.ok(!stderr.includes('do-not-print-fixture-secret'));
  return { code, stdout, stderr, events };
}

test('live conformance script waits for gateway initial ack before its own config and two turns', async () => {
  const result = await fixture(); assert.equal(result.code, 0); assert.equal(JSON.parse(result.stdout).turns, 2);
  assert.deepEqual(result.events, ['session.update', 'conversation.item.create', 'response.create', 'conversation.item.create', 'response.create']);
});
test('live conformance failure never repeats provider payloads or credentials', async () => {
  const result = await fixture(true); assert.equal(result.code, 1); assert.match(result.stderr, /conformance failed/u);
});

for (const status of ['failed', 'cancelled', 'incomplete']) test(`live conformance refuses ${status} terminals even with numeric usage`, async () => {
  const result = await fixture(false, status); assert.equal(result.code, 1); assert.equal(result.stdout, '');
});

test('Cloudflare test harness uses official endpoints, stored keys and header-only auth', () => {
  const env = { CF_ACCOUNT_ID: 'a'.repeat(32), CF_GATEWAY_NAME: 'fixture', CF_GATEWAY_API_KEY: 'fixture-secret' };
  for (const provider of ['openai', 'gemini']) {
    const connection = realtimeConnection(provider, 'candidate', env);
    assert.equal(connection.transport, 'cloudflare'); assert.equal(connection.url.hostname, 'gateway.ai.cloudflare.com');
    assert.equal(connection.headers['cf-aig-authorization'], 'Bearer fixture-secret'); assert.equal(connection.headers.Authorization, undefined);
    assert.ok(!connection.url.href.includes('fixture-secret')); assert.equal(connection.url.searchParams.has('api_key'), false);
  }
  assert.throws(() => realtimeConnection('openai', 'candidate', { ...env, CF_ACCOUNT_ID: '../invalid' }), /invalid/u);
});

test('Cloudflare live probes mint private short-lived credentials and connect directly', async () => {
  const env = { CF_ACCOUNT_ID: 'a'.repeat(32), CF_GATEWAY_NAME: 'fixture', CF_GATEWAY_API_KEY: 'fixture-secret' };
  for (const provider of ['openai', 'gemini']) {
    let requestUrl; let requestOptions;
    const connection = await liveRealtimeConnection(provider, 'candidate', env, async (url, options) => {
      requestUrl = url; requestOptions = options;
      return new Response(JSON.stringify({ value: 'short-lived-fixture', name: 'auth_tokens/fixture' }));
    });
    assert.equal(connection.transport, 'cloudflare_ephemeral');
    assert.ok(requestUrl.startsWith('https://gateway.ai.cloudflare.com/v1/'));
    assert.equal(requestOptions.headers['cf-aig-authorization'], 'Bearer fixture-secret');
    assert.equal(requestOptions.redirect, 'error');
    assert.equal(connection.url.hostname, provider === 'openai' ? 'api.openai.com' : 'generativelanguage.googleapis.com');
    assert.equal(connection.headers.Authorization, provider === 'openai' ? 'Bearer short-lived-fixture' : 'Token auth_tokens/fixture');
    assert.ok(!connection.url.href.includes('fixture-secret') && !connection.url.href.includes('auth_tokens'));
  }
  await assert.rejects(liveRealtimeConnection('openai', 'candidate', env, async () => new Response('{"value":"fixture-secret"', { status: 403 })), /issuance failed/u);
  await assert.rejects(liveRealtimeConnection('openai', 'candidate', env, async () => new Response('x'.repeat(65537))), /oversized/u);
});

test('live conformance terminates a stalled upgrade without logging credentials', { timeout: 20_000 }, async () => {
  const server = createServer();
  const connections = new Set();
  server.on('connection', socket => { connections.add(socket); socket.on('close', () => connections.delete(socket)); });
  server.on('upgrade', () => {}); // Keep TCP open without answering the WebSocket handshake.
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, ['scripts/realtime-conformance.mjs', '--live', 'openai', 'gpt-realtime'], {
    cwd: new URL('..', import.meta.url),
    env: { PATH: process.env.PATH, REALTIME_GATEWAY_URL: `ws://127.0.0.1:${server.address().port}/realtime`, REALTIME_GATEWAY_TOKEN: 'do-not-print-fixture-secret' },
  });
  const killTimer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  try {
    const code = await new Promise(resolve => child.once('exit', resolve));
    assert.equal(code, 1);
    assert.match(stderr, /conformance failed: transport_error/u);
    assert.ok(!stderr.includes('do-not-print-fixture-secret'));
  } finally {
    clearTimeout(killTimer); child.kill();
    for (const socket of connections) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});
