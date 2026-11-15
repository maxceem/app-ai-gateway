import type { RealtimeProtocol } from "../contract";
import type { ProtocolAdapter } from "../types";
import { OpenAIAdapter } from "./openai";
import { GeminiAdapter } from "./gemini";

/** The frame rules for a session's protocol. */
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
