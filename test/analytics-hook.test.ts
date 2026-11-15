import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  accountNotifier,
  readCountry,
  readFirstTouch,
  type AccountCreated,
  type AnalyticsHook,
} from "../src/analytics/hook";
import worker from "../src/index";

vi.setConfig({ testTimeout: 30_000 });

const ORIGIN = "https://example.test";
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
      "agw_identity_session=secret-session-token; ",
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
    expect(readFirstTouch("agw_identity_session=secret", NOW)).toBeNull();
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
      cookieHeader: () => cookie({ r: "github.com", p: "/" }, "agw_identity_session=secret-session-token; "),
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
    const notify = accountNotifier({ ...env, ANALYTICS: { accountCreated: async (event) => void received.push(event) } } as Env, {
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
  function runtime(hook: AnalyticsHook | undefined): Env {
    return new Proxy(env, {
      get(target, property, receiver) {
        if (property === "ANALYTICS") return hook;
        if (property === "BILLING") return undefined;
        // A self-host registers only listed addresses.
        if (property === "ALLOWED_REGISTRATION_EMAILS") {
          return "analytics-hook@example.test, analytics-unbound@example.test";
        }
        if (property === "OAUTH_RELAY_URL") return undefined;
        return Reflect.get(target, property, receiver);
      },
    }) as Env;
  }

  async function signUp(testEnv: Env, email: string, cookieHeader?: string) {
    return worker.request(
      `${ORIGIN}/v1/auth/sign-up/email`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ORIGIN,
          ...(cookieHeader ? { cookie: cookieHeader } : {}),
        },
        body: JSON.stringify({ name: "Analytics", email, password: "correct-horse-42" }),
      },
      testEnv,
    );
  }

  it("tells the bound Worker about the new account, with where the visitor came from", async () => {
    const received: AccountCreated[] = [];
    const testEnv = runtime({ accountCreated: async (event) => void received.push(event) });
    const response = await signUp(
      testEnv,
      "analytics-hook@example.test",
      cookie({ r: "free-for.dev", p: "/", t: String(Date.now() - 60_000) }),
    );
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(received).toHaveLength(1));

    const [event] = received;
    expect(event).toMatchObject({ kind: "created", firstTouch: { referrerHost: "free-for.dev", landingPath: "/" } });
    const membership = await env.DB.prepare(
      "SELECT organization_id FROM mgmt_organization_user WHERE user_id = ?",
    )
      .bind(event!.userId)
      .first<{ organization_id: string }>();
    expect(membership?.organization_id).toBe(event!.accountId);
  });

  it("calls nothing when no Worker is bound", async () => {
    const response = await signUp(runtime(undefined), "analytics-unbound@example.test", cookie({ r: "github.com" }));
    expect(response.status).toBe(200);
  });
});
