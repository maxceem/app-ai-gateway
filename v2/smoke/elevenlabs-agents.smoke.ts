/**
 * ElevenLabs agents on a live v2 deployment (step 11a), against the mock in `smoke/mock/`, so nothing is
 * billed:
 *
 * - an app lists an agent only when its own auth is on (the gateway reads the agent from ElevenLabs);
 * - an agent call connects through the signed URL the gateway asked for, the first message's greeting
 *   override goes on, and the call is billed by its time at the base rate a minute, as an estimate;
 * - a duration override in the client's first message ends the call with 1008.
 *
 * The two call checks need `V2_MOCK_REACHABLE=1`, set only when the mock has an address the gateway can
 * reach outside an app request: the signed URL is asked for when the relay calls `open`, and Cloudflare
 * refuses that call to the mock's workers.dev address (error 1042, answered as a 404), as it refuses the
 * sweep's. For the same reason the conversation lookup after the call is not checked here. The tests cover
 * both (`test/elevenlabs-agents.test.ts`).
 *
 *   V2_BASE_URL=https://gateway.example.com \
 *   V2_MANAGEMENT_KEY=agw_mgmt_… \
 *   V2_MOCK_URL=https://agw-test-v2-mock.<subdomain>.workers.dev/ \
 *   V2_RELAY_URL=https://agw-test-v2-relay.<subdomain>.workers.dev \
 *   pnpm --filter @app-ai-gateway/gateway-v2 smoke
 *
 * Everything is made through the management API and removed afterwards. Skipped when any of these is not set.
 */
import { after, test } from "node:test";
import { admin, check, checkId, exchangeFrames, expectResponse, readJson, same, send, uniqueSlug } from "./support.ts";
import { USER_AGENT } from "./user-agent.ts";

const base = process.env.V2_BASE_URL ?? "";
const mockUrl = process.env.V2_MOCK_URL ?? "";
const relay = process.env.V2_RELAY_URL ?? "";
const skip =
  base === "" || mockUrl === "" || relay === "" || (process.env.V2_MANAGEMENT_KEY ?? "") === ""
    ? "V2_BASE_URL, V2_MANAGEMENT_KEY, V2_MOCK_URL and V2_RELAY_URL are needed"
    : false;

/** The call checks: they need the gateway to reach the mock from `open` (see above). */
const callSkip = skip !== false ? skip : process.env.V2_MOCK_REACHABLE === "1" ? false : "V2_MOCK_REACHABLE=1 is needed: the mock's workers.dev address can't be reached from open (error 1042)";

const AGENT = "agent_smoke";
const made = { provider: "", apps: [] as string[] };

after(async () => {
  if (skip !== false) return;
  for (const app of made.apps) await admin("DELETE", `/v2/admin/apps/${app}?confirm=${app}`);
  if (made.provider !== "") await admin("DELETE", `/v2/admin/providers/${made.provider}`);
});

/** One ElevenLabs connection on the mock for every check here: its slug. */
let slug = "";
async function connection(): Promise<string> {
  if (slug !== "") return slug;
  slug = uniqueSlug("smoke-elevenlabs-agents");
  const provider = await admin("POST", "/v2/admin/providers", { type: "elevenlabs", name: `Smoke ${slug}`, slug, secret: "elevenlabs-mock-smoke-key", baseUrl: mockUrl });
  same(provider.status, 201, "the agents' connection could not be made");
  made.provider = checkId(provider.body?.provider?.id, "the agents' connection id");
  return slug;
}

/** Saves an app that may start `agents`: the answer. */
async function saveApp(agents: string[]): Promise<{ status: number; body: any }> {
  const route = await connection();
  const app = await admin("POST", "/v2/admin/apps", {
    name: `Smoke ${route}`,
    config: {
      authentication: { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } },
      routing: { providers: { [route]: { operations: ["elevenlabs.agent"], models: agents } } },
    },
  });
  if (app.status === 201) made.apps.push(checkId(app.body?.app?.id, "the agents' app id"));
  return app;
}

/** A new agent session's ticket, from the gateway. */
async function ticketFor(app: string, key: string): Promise<{ ticket: string; sessionId: string }> {
  const response = await send(`/v2/apps/${app}/sessions/${slug}`, base, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-end-user-id": "smoke-agent-user" },
    body: JSON.stringify({ path: `v1/convai/conversation?agent_id=${AGENT}` }),
  });
  await expectResponse(response, 201, "starting an agent call");
  const body = await readJson(response);
  return { ticket: String(body?.ticket), sessionId: checkId(body?.session_id, "the agent call's id") };
}

type Charge = { kind: string; cost_nano: number | null; price_source: string; unit: string | null; units: number | null };

test("an app lists an ElevenLabs agent only when its own auth is on, checked with ElevenLabs (step 11a)", { skip, timeout: 60_000 }, async () => {
  const refused = await saveApp(["agent_mock_auth_off"]);
  same(refused.status, 400, "an agent with its own auth off was listed");
  const saved = await saveApp([AGENT]);
  same(saved.status, 201, "an agent with its own auth on could not be listed");
});

test("an agent call goes through its signed URL and is billed by its time at the base rate a minute (step 11a)", { skip: callSkip, timeout: 120_000 }, async () => {
  const saved = await saveApp([AGENT]);
  same(saved.status, 201, "the agent's app could not be made");
  const app = checkId(saved.body?.app?.id, "the agent's app id");
  const { ticket, sessionId } = await ticketFor(app, String(saved.body?.api_key?.key ?? ""));
  const first = JSON.stringify({ type: "conversation_initiation_client_data", conversation_config_override: { agent: { first_message: "I am back." } } });
  // The conversation's metadata at once, then the mock's audio for the chunk: through the signed URL.
  const got = await exchangeFrames("/v2/relay/session", relay, [first, JSON.stringify({ user_audio_chunk: "AAAA" })], 2, { authorization: `Bearer ${ticket}` }, 1000, 2_000);
  same((JSON.parse(typeof got[0] === "string" ? got[0] : "{}") as { type?: string }).type, "conversation_initiation_metadata", "the agent call's first frame");
  let charges: Charge[] = [];
  for (let attempt = 0; attempt < 30 && !charges.some((charge) => (charge.cost_nano ?? 0) > 0); attempt += 1) {
    const listed = await admin("GET", `/v2/admin/apps/${app}/charges?owner=${encodeURIComponent(sessionId)}`);
    same(listed.status, 200, "listing the agent call's charges");
    charges = (listed.body?.charges ?? []) as Charge[];
    if (!charges.some((charge) => (charge.cost_nano ?? 0) > 0)) await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  const billed = charges.filter((charge) => charge.kind === "slice" && (charge.cost_nano ?? 0) > 0);
  check(billed.length > 0 && billed.every((charge) => charge.unit === "session_seconds" && charge.price_source === "list_rate"), "the agent call was not billed by its time at the list price");
  // At the base rate, $0.08 a minute: within a nano-dollar a millisecond's share.
  const ms = billed.reduce((sum, charge) => sum + (charge.units ?? 0), 0);
  const cost = billed.reduce((sum, charge) => sum + (charge.cost_nano ?? 0), 0);
  check(ms >= 2_000, "the agent call billed less than the time it was open");
  check(Math.abs(cost - (ms * 80_000_000) / 60_000) <= billed.length + 1, "the agent call was not billed at $0.08 a minute");
});

test("a duration override in an agent call's first message ends the call with 1008 (step 11a)", { skip: callSkip, timeout: 60_000 }, async () => {
  const saved = await saveApp([AGENT]);
  same(saved.status, 201, "the agent's app could not be made");
  const app = checkId(saved.body?.app?.id, "the agent's app id");
  const { ticket } = await ticketFor(app, String(saved.body?.api_key?.key ?? ""));
  const url = new URL("/v2/relay/session", relay);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  const socket = new WebSocket(url, { headers: { "user-agent": USER_AGENT, authorization: `Bearer ${ticket}` } } as unknown as string[]);
  const closed = await new Promise<{ code: number; reason: string }>((resolve) => {
    const timer = setTimeout(() => resolve({ code: 0, reason: "timeout" }), 30_000);
    socket.addEventListener("message", (event) => {
      // Sent once the call is up: the metadata came through.
      if (typeof event.data === "string" && event.data.includes("conversation_initiation_metadata")) {
        socket.send(JSON.stringify({ type: "conversation_initiation_client_data", conversation_config_override: { conversation: { max_duration_seconds: 7200 } } }));
      }
    });
    socket.addEventListener("close", (event) => {
      clearTimeout(timer);
      resolve({ code: event.code, reason: event.reason });
    });
  });
  same(closed.code, 1008, "a duration override did not end the agent call with 1008");
  same(closed.reason, "override_not_allowed", "the agent call's close reason");
});
