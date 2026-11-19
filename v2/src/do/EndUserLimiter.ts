/**
 * The end user's limiter object (plan section 4.2, admission step 1).
 *
 * One per end user: per install on an App Attest app
 * (`<app>:install:<key id>`), per `<app>:user:<user>` on a server app. It
 * holds the App Attest assertion counter of an install, and the end user's
 * request windows and monthly budget (shared with the app limiter, see
 * `./request-limits.ts`). The session lease comes with live sessions.
 *
 * Each assertion counter is accepted once. Requests are signed in one order
 * and can arrive in another, so a counter up to COUNTER_WINDOW behind the
 * highest one seen is still accepted once; one further behind never is.
 */
import { RequestLimitObject } from "./request-limits.ts";

export const COUNTER_WINDOW = 64;

const MASK_64 = (1n << 64n) - 1n;

export class EndUserLimiter extends RequestLimitObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      // The highest counter used, and which of the COUNTER_WINDOW below it
      // have been, as a 64-bit mask in sixteen hex digits (bit n is
      // counter_high - n). Absent until the first assertion, which is
      // accepted whatever its counter.
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS assertion_counter (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          counter_high INTEGER NOT NULL,
          counter_seen TEXT NOT NULL
        );
      `);
    });
  }

  /** Accepts one assertion counter, or refuses it as a replay. */
  useCounter(counter: number): { accepted: boolean } {
    return { accepted: this.accept(counter) };
  }

  /** No `await` between the read and the write, so two requests with one counter cannot both pass. */
  private accept(counter: number): boolean {
    if (!Number.isSafeInteger(counter) || counter < 0) return false;
    const stored = this.ctx.storage.sql
      .exec<{ counter_high: number; counter_seen: string }>(
        "SELECT counter_high, counter_seen FROM assertion_counter WHERE singleton = 1",
      )
      .toArray()[0];
    let high: number;
    let seen: bigint;
    if (stored === undefined) {
      high = counter;
      seen = 1n;
    } else if (counter > stored.counter_high) {
      const shift = counter - stored.counter_high;
      seen = shift >= COUNTER_WINDOW ? 1n : ((BigInt(`0x${stored.counter_seen}`) << BigInt(shift)) & MASK_64) | 1n;
      high = counter;
    } else {
      const behind = stored.counter_high - counter;
      if (behind >= COUNTER_WINDOW) return false;
      const bit = 1n << BigInt(behind);
      const mask = BigInt(`0x${stored.counter_seen}`);
      if ((mask & bit) !== 0n) return false;
      high = stored.counter_high;
      seen = mask | bit;
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO assertion_counter(singleton, counter_high, counter_seen) VALUES (1, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         counter_high = excluded.counter_high,
         counter_seen = excluded.counter_seen`,
      high,
      seen.toString(16).padStart(16, "0"),
    );
    return true;
  }
}
