/** Default time-to-first-byte budget for the whole execution plan. */
export const PROVIDER_TTFB_TIMEOUT_MS = 120_000;

export function providerTtfbTimeoutMs(env: Env): number {
  const seconds = Number(env.PROVIDER_TTFB_TIMEOUT_SECONDS);
  return Number.isFinite(seconds) && seconds > 0
    ? Math.round(seconds * 1_000)
    : PROVIDER_TTFB_TIMEOUT_MS;
}

export class ProviderTtfbTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Provider sent no response headers within ${timeoutMs} ms`);
    this.name = "ProviderTtfbTimeoutError";
  }
}

/** The timer ends when headers arrive; response streaming has no body deadline. */
export async function fetchWithTtfbTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new ProviderTtfbTimeoutError(timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
