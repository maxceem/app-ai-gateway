/** Test harness only: production realtime routing remains official-provider-only. */
export function realtimeConnection(provider, model, env = process.env) {
  const appGateway = env.REALTIME_GATEWAY_URL;
  const cloudflare = !appGateway && [env.CF_ACCOUNT_ID, env.CF_GATEWAY_NAME, env.CF_GATEWAY_API_KEY].some(Boolean);
  let url; let headers; let transport;
  if (appGateway) {
    if (!env.REALTIME_GATEWAY_TOKEN) throw new Error('Missing gateway environment credential');
    url = new URL(appGateway); headers = { Authorization: `Bearer ${env.REALTIME_GATEWAY_TOKEN}`, 'X-App-Version': 'realtime-conformance' }; transport = 'gateway';
    if (env.REALTIME_END_USER_ID) headers[env.REALTIME_END_USER_HEADER ?? 'X-End-User-ID'] = env.REALTIME_END_USER_ID;
  } else if (cloudflare) {
    if (!/^[a-f0-9]{32}$/iu.test(env.CF_ACCOUNT_ID ?? '') || !env.CF_GATEWAY_NAME || !env.CF_GATEWAY_API_KEY) throw new Error('Incomplete or invalid Cloudflare gateway environment configuration');
    url = new URL(`wss://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${encodeURIComponent(env.CF_GATEWAY_NAME)}/${provider === 'openai' ? 'openai' : 'google'}`);
    const token = env.CF_GATEWAY_API_KEY;
    headers = { 'cf-aig-authorization': token.startsWith('Bearer ') ? token : `Bearer ${token}` }; transport = 'cloudflare';
  } else {
    if (!env.REALTIME_PROVIDER_KEY) throw new Error('Missing provider environment credential');
    url = new URL(provider === 'openai' ? 'wss://api.openai.com/v1/realtime' : 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent');
    headers = provider === 'openai' ? { Authorization: `Bearer ${env.REALTIME_PROVIDER_KEY}` } : { 'x-goog-api-key': env.REALTIME_PROVIDER_KEY }; transport = 'direct';
  }
  if (appGateway || provider === 'openai') url.searchParams.set('model', model);
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && (url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname === '127.0.0.1'))) throw new Error('Use a secure WebSocket origin');
  return { url, headers, transport };
}

/** Stored Cloudflare keys can mint short-lived credentials over HTTP even when
 * its WebSocket proxy does not apply BYOK. The live probe then uses the official
 * provider socket. Credentials stay in memory and are never returned to stdout. */
export async function liveRealtimeConnection(provider, model, env = process.env, request = fetch) {
  const connection = realtimeConnection(provider, model, env);
  if (connection.transport !== 'cloudflare') return connection;
  const base = connection.url.href.replace(/^wss:/u, 'https:').split('?')[0].replace(/\/(openai|google)$/u, '');
  const endpoint = provider === 'openai' ? '/openai/realtime/client_secrets' : '/google-ai-studio/v1beta/auth_tokens';
  const body = provider === 'openai'
    ? { expires_after: { anchor: 'created_at', seconds: 300 }, session: { type: 'realtime', model } }
    : { uses: 1, expireTime: new Date(Date.now() + 300_000).toISOString(), newSessionExpireTime: new Date(Date.now() + 60_000).toISOString() };
  const response = await request(base + endpoint, { method: 'POST', headers: { ...connection.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10_000), redirect: 'error' });
  if (!response.ok) throw new Error('Provider realtime credential issuance failed');
  // Provider responses are tiny. Bound the read so an unexpected proxy response
  // cannot retain an unbounded body or leak its contents through an exception.
  const reader = response.body?.getReader(); let length = 0; const chunks = [];
  if (!reader) throw new Error('Provider realtime credential response is missing');
  for (;;) { const { done, value } = await reader.read(); if (done) break;
    length += value.byteLength; if (length > 64 * 1024) { await reader.cancel(); throw new Error('Provider realtime credential response is oversized'); } chunks.push(value); }
  let data; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Provider realtime credential response is invalid'); }
  const secret = provider === 'openai' ? data.value : data.name;
  if (typeof secret !== 'string' || !secret || secret.length > 4096) throw new Error('Provider realtime credential response is invalid');
  const url = new URL(provider === 'openai' ? 'wss://api.openai.com/v1/realtime' : 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained');
  if (provider === 'openai') url.searchParams.set('model', model);
  return { url, transport: 'cloudflare_ephemeral', headers: { Authorization: `${provider === 'openai' ? 'Bearer' : 'Token'} ${secret}` } };
}
