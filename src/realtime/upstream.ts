import { GatewayError } from "../core/errors";
import type { RealtimeProtocol } from "../shared/capabilities";
import { CF_AI_GATEWAY_BASE_URL } from "../providers/gateway-adapters";
import { DIRECT_ROUTE, type ResolvedRoute } from "../providers/route-adapters";
import type { ProtocolAdapter } from "./types";
import { OpenAIAdapter } from "./protocols/openai";
import { GeminiAdapter } from "./protocols/gemini";

const GEMINI_LIVE_URL =
  "https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/** Who a session is, as a gateway route records it beside the call. */
export interface UpstreamCaller {
  appId: string;
  userId: string | null;
}

/** The `cf-aig-metadata` header naming the caller, where there is one to name. */
function gatewayMetadata(caller: UpstreamCaller | undefined): Record<string, string> {
  if (!caller) return {};
  const metadata = { app_id: caller.appId, ...(caller.userId === null ? {} : { user_id: caller.userId }) };
  return { "cf-aig-metadata": JSON.stringify(metadata) };
}

/** Official origins only. These requests never contain client-controlled headers. */
export function upstreamRequest(
  protocol: RealtimeProtocol,
  model: string,
  secret: string,
  route: Pick<ResolvedRoute, "kind" | "gateway"> = DIRECT_ROUTE,
  caller?: UpstreamCaller,
): Request {
  if (route.kind === "cf_aig") {
    if (protocol !== "openai_realtime" || route.gateway?.type !== "cf_aig") {
      throw new GatewayError(400, "realtime_not_supported", "This gateway route has no realtime profile");
    }
    // Cloudflare's realtime endpoint holds the provider key in the gateway's own
    // store, so only the gateway token travels. OpenAI refuses a socket with no
    // subprotocol of its own beside the one Cloudflare adds for the key.
    const { accountId, gatewayId } = route.gateway.config;
    const url = new URL(
      `${CF_AI_GATEWAY_BASE_URL}/${encodeURIComponent(accountId)}/${encodeURIComponent(gatewayId)}/openai`,
    );
    url.searchParams.set("model", model);
    return new Request(url, {
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": "realtime",
        "cf-aig-authorization": `Bearer ${secret}`,
        ...gatewayMetadata(caller),
      },
      redirect: "manual",
    });
  }
  if (protocol === "openai_realtime") {
    const url = new URL("https://api.openai.com/v1/realtime");
    url.searchParams.set("model", model);
    return new Request(url, {
      headers: { Upgrade: "websocket", Authorization: `Bearer ${secret}` },
      redirect: "manual",
    });
  }
  return new Request(GEMINI_LIVE_URL, {
    headers: { Upgrade: "websocket", "x-goog-api-key": secret },
    redirect: "manual",
  });
}

export function protocolAdapter(
  protocol: RealtimeProtocol,
  model: string,
  outputCap: number,
  requestedModel = model,
): ProtocolAdapter {
  return protocol === "openai_realtime"
    ? new OpenAIAdapter(model, outputCap, requestedModel)
    : new GeminiAdapter(model, outputCap);
}
