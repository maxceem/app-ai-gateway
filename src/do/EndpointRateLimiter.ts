import { DurableObject } from "cloudflare:workers";

export interface EndpointRateLimitPolicy {
  limit: number;
  windowMs: number;
}

export type EndpointRateLimitResult =
  | { allowed: true; count: number }
  | { allowed: false; retryAfterSeconds: number };

interface CounterState {
  windowStart: number;
  windowMs: number;
  count: number;
}

const COUNTER_KEY = "counter";

function validatedPolicy(policy: EndpointRateLimitPolicy): EndpointRateLimitPolicy {
  if (!Number.isSafeInteger(policy.limit) || policy.limit <= 0)
    throw new RangeError("Rate limit must be a positive safe integer");
  if (!Number.isSafeInteger(policy.windowMs) || policy.windowMs <= 0)
    throw new RangeError("Rate limit window must be a positive safe integer");
  return policy;
}

/**
 * A fixed-window abuse counter for one endpoint subject.
 *
 * The Worker chooses a stable object from a SHA-256 digest of the subject, so
 * raw IP addresses and account identifiers never become Durable Object names.
 * One object survives across windows and overwrites its single counter instead
 * of leaving one object behind for every window.
 */
export class EndpointRateLimiter extends DurableObject<Env> {
  async check(policyInput: EndpointRateLimitPolicy): Promise<EndpointRateLimitResult> {
    const policy = validatedPolicy(policyInput);
    return this.ctx.storage.transaction(async (transaction) => {
      const stored = await transaction.get<CounterState>(COUNTER_KEY);
      const now = Date.now();
      const windowStart = Math.floor(now / policy.windowMs) * policy.windowMs;
      const expiresAt = windowStart + policy.windowMs;
      if (!Number.isSafeInteger(expiresAt))
        throw new RangeError("Rate limit window is outside the supported clock range");
      const current =
        stored?.windowStart === windowStart && stored.windowMs === policy.windowMs
          ? stored
          : undefined;
      const count = current?.count ?? 0;
      if (count >= policy.limit) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((expiresAt - now) / 1_000)),
        };
      }

      const next: CounterState = {
        windowStart,
        windowMs: policy.windowMs,
        count: count + 1,
      };
      await transaction.put(COUNTER_KEY, next);
      if (!current) await transaction.setAlarm(expiresAt);
      return { allowed: true, count: next.count };
    });
  }

  override async alarm(): Promise<void> {
    // deleteAll cannot run in a storage transaction. Block only this cleanup
    // handler so its expiry check and deletion cannot interleave with a request
    // opening a new window.
    await this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<CounterState>(COUNTER_KEY);
      const now = Date.now();
      if (!stored) {
        await this.ctx.storage.deleteAll();
        return;
      }
      const expiresAt = stored.windowStart + stored.windowMs;
      if (expiresAt <= now) {
        // deleteAll also removes SQLite's internal KV metadata and, at this
        // Worker's compatibility date, the alarm itself. Dormant subjects then
        // retain no billable storage.
        await this.ctx.storage.deleteAll();
        return;
      }

      // An old alarm can be delivered after a request has opened a newer
      // window. Keep that new counter and restore its actual cleanup deadline.
      await this.ctx.storage.setAlarm(expiresAt);
    });
  }
}
