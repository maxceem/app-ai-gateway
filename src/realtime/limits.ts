/** Finite application bounds; these are not provider/platform limits. */
export const REALTIME_LIMITS = {
  clientFrameBytes: 256 * 1024, providerFrameBytes: 1024 * 1024,
  queuedBytes: 1024 * 1024, queuedEvents: 256,
  turnInputBytes: 4 * 1024 * 1024, generationOutputBytes: 16 * 1024 * 1024,
  setupMs: 10_000, idleMs: 120_000, inputMs: 60_000, responseMs: 120_000,
  generations: 1000, outputTokens: 4096, revalidateMs: 30_000,
  leaseMs: 90_000, leaseSafetyMs: 10_000, drainMs: 2000,
  outboxRetentionMs: 7 * 86_400_000,
} as const;
