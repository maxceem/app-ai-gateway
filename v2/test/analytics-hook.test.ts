/**
 * The optional `ANALYTICS` sign-up hook (v1's `analytics-hook.test.ts`,
 * ported): the first-visit cookie and country it reads, exactly what it sends,
 * and the call on a real sign-up. The bound Worker is always a fake here:
 * nothing is sent anywhere.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  accountNotifier,
  readCountry,
  readFirstTouch,
  type AccountCreated,
  type AnalyticsHook,
} from "../src/analytics/hook.ts";
import worker from "../src/index.ts";
import { LOAD_MANAGEMENT_TIMEOUT_MS, loadManagement } from "./helpers.ts";

beforeAll(loadManagement, LOAD_MANAGEMENT_TIMEOUT_MS);

const CONSOLE = "https://console.gateway.test";
const NOW = Date.UTC(2026, 9, 31, 12);
const FIRST_SEEN = Date.UTC(2026, 9, 30, 8);

function cookie(fields: Record<string, string>, extra = ""): string {
  return `${extra}first_touch=${encodeURIComponent(new URLSearchParams(fields).toString())}`;
}

describe("readFirstTouch", () => {
  it("reads every field of a well-formed cookie", () => {
    const header = cookie(
      {
        r: "GitHub.com",
        p: "/learn/protect-openai-api-key-ios/",
        us: "newsletter",
        um: "email",
        uc: "launch week",
        t: String(FIRST_SEEN),
        v: "019a3c5e-7b1f-7c2d-9e4f-0a1b2c3d4e5f",
      },
      "agw2_identity_auth.session_token=secret-session-token; ",
    );
    expect(readFirstTouch(header, NOW)).toEqual({
      referrerHost: "github.com",
      landingPath: "/learn/protect-openai-api-key-ios/",
      utmSource: "newsletter",
      utmMedium: "email",
      utmCampaign: "launch week",
      firstSeenAt: new Date(FIRST_SEEN).toISOString(),
      visitorId: "019a3c5e-7b1f-7c2d-9e4f-0a1b2c3d4e5f",
    });
  });

  it("drops each field that is malformed, too long or implausible, and keeps the rest", () => {
    const header = cookie({
      r: "evil.com/path?x=1",
      p: "/pricing?token=abc",
      us: "x".repeat(101),
      um: "line\nbreak",
      uc: "ok",
      t: String(NOW + 2 * 86_400_000),
      v: "not a visitor id!",
    });
    expect(readFirstTouch(header, NOW)).toEqual({
      referrerHost: null,
      landingPath: null,
      utmSource: null,
      utmMedium: null,
      utmCampaign: "ok",
      firstSeenAt: null,
      visitorId: null,
    });
  });

  it("is null without the cookie, with an empty one, with an oversized one, or with nothing valid", () => {
    expect(readFirstTouch(undefined, NOW)).toBeNull();
    expect(readFirstTouch("agw2_identity_auth.session_token=secret", NOW)).toBeNull();
    expect(readFirstTouch("first_touch=", NOW)).toBeNull();
    expect(readFirstTouch(`first_touch=${"a".repeat(1025)}`, NOW)).toBeNull();
    expect(readFirstTouch("first_touch=%E0%A4%A", NOW)).toBeNull();
    expect(readFirstTouch(cookie({ r: "bad host!" }), NOW)).toBeNull();
  });

  it("reads only its own cookie, not one whose name merely ends the same", () => {
    expect(readFirstTouch(`not_first_touch=${encodeURIComponent("r=github.com")}`, NOW)).toBeNull();
  });
});

describe("readCountry", () => {
  it("keeps a two-letter code and drops unknown or malformed ones", () => {
    expect(readCountry("US")).toBe("US");
    expect(readCountry("T1")).toBe("T1");
    expect(readCountry("XX")).toBeNull();
    expect(readCountry("us")).toBeNull();
    expect(readCountry("USA")).toBeNull();
    expect(readCountry(undefined)).toBeNull();
  });
});

describe("accountNotifier", () => {
  it("is null without an ANALYTICS binding, and then reads no cookie", () => {
    const cookieHeader = vi.fn(() => cookie({ r: "github.com" }));
    const notifier = accountNotifier({ ...env, ANALYTICS: undefined } as Env, {
      cookieHeader,
      doNotTrackHeader: () => undefined,
      country: () => "TZ",
      waitUntil: () => {},
    });
    expect(notifier).toBeNull();
    expect(cookieHeader).not.toHaveBeenCalled();
  });

  it("sends exactly the fields of AccountCreated, and nothing else", async () => {
    const received: AccountCreated[] = [];
    const hook: AnalyticsHook = { accountCreated: async (event) => void received.push(event) };
    const pending: Promise<unknown>[] = [];
    const notify = accountNotifier({ ...env, ANALYTICS: hook } as Env, {
      cookieHeader: () => cookie({ r: "github.com", p: "/" }, "agw2_identity_auth.session_token=secret-session-token; "),
      doNotTrackHeader: () => undefined,
      country: () => "TZ",
      waitUntil: (promise) => void pending.push(promise),
    });
    notify!({ accountId: "account-1", userId: "user-1", kind: "created" });
    await Promise.all(pending);

    expect(received).toHaveLength(1);
    const [event] = received;
    // The whole payload, key by key: a new field fails this test on purpose.
    expect(Object.keys(event!).sort()).toEqual(["accountId", "country", "firstTouch", "kind", "occurredAt", "userId"]);
    expect(Object.keys(event!.firstTouch!).sort()).toEqual([
      "firstSeenAt",
      "landingPath",
      "referrerHost",
      "utmCampaign",
      "utmMedium",
      "utmSource",
      "visitorId",
    ]);
    expect(event!.country).toBe("TZ");
    expect(JSON.stringify(event)).not.toContain("secret-session-token");
  });

  it("sends no source for a browser that sends Do Not Track, whatever cookie it still holds", async () => {
    const received: AccountCreated[] = [];
    const pending: Promise<unknown>[] = [];
    const cookieHeader = vi.fn(() => cookie({ r: "github.com" }));
    const notify = accountNotifier({ ...env, ANALYTICS: { accountCreated: async (event: AccountCreated) => void received.push(event) } } as Env, {
      cookieHeader,
      doNotTrackHeader: () => "1",
      country: () => "TZ",
      waitUntil: (promise) => void pending.push(promise),
    });
    notify!({ accountId: "account-1", userId: "user-1", kind: "created" });
    await Promise.all(pending);
    expect(received[0]?.firstTouch).toBeNull();
    expect(received[0]?.country).toBeNull();
    expect(cookieHeader).not.toHaveBeenCalled();
  });

  it("only logs a hook that fails, and never throws into the caller", async () => {
    const hook: AnalyticsHook = {
      accountCreated: () => {
        throw new Error("down");
      },
    };
    const pending: Promise<unknown>[] = [];
    const notify = accountNotifier({ ...env, ANALYTICS: hook } as Env, {
      cookieHeader: () => undefined,
      doNotTrackHeader: () => undefined,
      country: () => "TZ",
      waitUntil: (promise) => void pending.push(promise),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => notify!({ accountId: "account-1", userId: "user-1", kind: "created" })).not.toThrow();
    await expect(Promise.all(pending)).resolves.toBeDefined();
    warn.mockRestore();
  });
});

describe("the ANALYTICS binding on sign-up", () => {
  it("tells the bound Worker about the new account, with where the visitor came from and its country", async () => {
    const received: AccountCreated[] = [];
    const email = `analytics-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const testEnv = { ...env, ALLOWED_REGISTRATION_EMAILS: email, ANALYTICS: { accountCreated: async (event: AccountCreated) => void received.push(event) } } as Env;
    const request = new Request(`${CONSOLE}/v2/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: CONSOLE, cookie: cookie({ r: "free-for.dev", p: "/", t: String(Date.now() - 60_000) }) },
      body: JSON.stringify({ name: "Analytics", email, password: "correct horse battery staple" }),
      cf: { country: "TZ" },
    } as RequestInit);
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, testEnv, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(received).toHaveLength(1);

    const [event] = received;
    expect(event).toMatchObject({ kind: "created", country: "TZ", firstTouch: { referrerHost: "free-for.dev", landingPath: "/" } });
    const membership = await env.DB.prepare("SELECT organization_id FROM mgmt_organization_user WHERE user_id = ?")
      .bind(event!.userId)
      .first<{ organization_id: string }>();
    expect(membership?.organization_id).toBe(event!.accountId);
  });
});
