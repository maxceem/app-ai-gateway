/**
 * Stand-ins for the relay's session core (`relay/src/start.js`), shared by its
 * tests: storage that can freeze on a chosen write, a well-formed ticket, and a
 * way to let pending steps run without a real timer.
 */
import { base64url, type Ticket } from "../relay/src/ticket.js";

export const never = <T>() => new Promise<T>(() => undefined);

/** Lets pending promise steps run until `done` holds: no real timer, only the microtask queue. */
export async function until(done: () => boolean): Promise<void> {
  for (let step = 0; step < 1_000 && !done(); step += 1) await Promise.resolve();
  if (!done()) throw new Error("the condition never held");
}

/** Storage that keeps what was written, applies each `put` whole, and can freeze on a chosen write. */
export class MemoryStore {
  readonly data = new Map<string, unknown>();
  alarm: number | null = null;
  freezeWhen: ((entries: Record<string, unknown>) => boolean) | null = null;
  /** Runs before a write is applied: a test's way to land an event during that write. */
  beforePut: ((entries: Record<string, unknown>) => void) | null = null;
  /** Throws on the chosen read: a test's way to make storage fail. */
  failGet: ((keys: string[]) => boolean) | null = null;
  /** Whether a write froze: the instance that made it never goes on. */
  frozen = false;

  async get(keys: string[]): Promise<Map<string, unknown>> {
    if (this.failGet?.(keys)) throw new Error("storage failed");
    return new Map(keys.filter((key) => this.data.has(key)).map((key) => [key, structuredClone(this.data.get(key))]));
  }

  put(entries: Record<string, unknown>, alarmAt: number | null): Promise<void> {
    this.beforePut?.(entries);
    if (this.freezeWhen?.(entries)) {
      this.frozen = true;
      return never();
    }
    for (const [key, value] of Object.entries(entries)) this.data.set(key, structuredClone(value));
    if (alarmAt !== null) this.alarm = alarmAt;
    return Promise.resolve();
  }

  /** The journal's own write: one key, no alarm. */
  putJournal(journal: unknown): Promise<void> {
    return this.put({ journal }, null);
  }

  async deleteAll(): Promise<void> {
    this.data.clear();
    this.alarm = null;
  }
}

export function ticketFor(now: number, overrides: Partial<Ticket> = {}): { text: string; ticket: Ticket } {
  const ticket: Ticket = {
    v: 1,
    sid: "ses_1",
    account: "acc",
    app: "app",
    endUser: "user",
    install: null,
    appleAccount: null,
    appKey: null,
    providerType: "openai",
    connection: "conn",
    operation: "openai.realtime",
    model: "gpt-realtime",
    mode: "relayed",
    slot: "conversational",
    sessionTotal: false,
    url: "https://api.openai.com/v1/realtime",
    start: now,
    cap: 30 * 60_000,
    exp: now + 60_000,
    seal: {},
    ...overrides,
  };
  // The core never checks the signature (the entry did); a well-formed one is enough here.
  return { ticket, text: `${base64url(new TextEncoder().encode(JSON.stringify(ticket)))}.${base64url(new Uint8Array(64))}` };
}
