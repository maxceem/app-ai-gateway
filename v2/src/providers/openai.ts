/**
 * OpenAI.
 *
 * Step 1a declares chat completions, the first call of part 3, and the
 * realtime WebSocket, one of the hardest shapes: a relayed session with its
 * model in the query, measured from the provider's usage events. Steps 3 and
 * 9 complete them.
 */
import { defineOperation, defineProvider } from "./operation.ts";

export const openai = defineProvider({
  type: "openai",
  hosts: { main: "api.openai.com" },
  auth: { header: "authorization", format: "Bearer {key}" },
  // The admin API (keys, projects, users, usage and costs) lives under `v1/organization`.
  refused: ["v1/organization/*"],
  operations: [
    defineOperation({
      name: "openai.chat",
      match: { method: "POST", path: "v1/chat/completions" },
      lifecycle: "call",
      transport: "stream",
      style: "openai-chat",
      model: { in: "body", field: "model" },
      // Usage in a stream needs `stream_options.include_usage`, but OpenAI refuses
      // `stream_options` on a request that does not stream. Step 3 adds it only
      // when `stream` is true, as v1 does.
      policy: { lockable: ["model", "max_completion_tokens"] },
      meter: { kind: "response_json", style: "openai-chat" },
    }),
    defineOperation({
      name: "openai.realtime",
      match: { method: "GET", path: "v1/realtime" },
      lifecycle: "session",
      transport: "websocket",
      model: { in: "query", name: "model" },
      meter: { kind: "provider_event", adapter: "openai-realtime" },
      session: { slot: "conversational", mode: "relayed" },
    }),
  ],
});
