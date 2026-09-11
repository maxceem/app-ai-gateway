import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import {
  authPathWithPlan,
  CHECKOUT_RETURN_PATH,
  checkoutSucceeded,
  pathWithoutCheckout,
  isRetryableError,
  isSafeReturnPath,
  loginUrlFor,
  oauthErrorNotice,
  planKeyFrom,
  postAuthPath,
  returnPathFrom,
} from "./auth-redirect";

describe("isRetryableError", () => {
  it("does not retry deterministic client errors", () => {
    for (const status of [400, 401, 402, 403, 404, 409, 422]) {
      expect(isRetryableError(new ApiError(status, "code", "")), String(status)).toBe(false);
    }
  });

  it("retries server errors and transport failures", () => {
    expect(isRetryableError(new ApiError(500, "internal_error", ""))).toBe(true);
    expect(isRetryableError(new ApiError(502, "billing_unavailable", ""))).toBe(true);
    expect(isRetryableError(new TypeError("network down"))).toBe(true);
  });
});

describe("isSafeReturnPath", () => {
  it("accepts same-origin absolute paths", () => {
    expect(isSafeReturnPath("/apps/my-app/usage")).toBe(true);
  });

  it("rejects anything that could leave the origin", () => {
    // A return path comes from the URL, so an attacker controls it.
    expect(isSafeReturnPath("//evil.example/phish")).toBe(false);
    expect(isSafeReturnPath("/\\evil.example")).toBe(false);
    expect(isSafeReturnPath("https://evil.example")).toBe(false);
    expect(isSafeReturnPath("apps")).toBe(false);
    expect(isSafeReturnPath(null)).toBe(false);
    expect(isSafeReturnPath("")).toBe(false);
  });

  it("rejects the auth screens so re-auth cannot loop", () => {
    expect(isSafeReturnPath("/login")).toBe(false);
    expect(isSafeReturnPath("/signup")).toBe(false);
  });
});

describe("returnPathFrom", () => {
  it("recovers the requested destination", () => {
    expect(returnPathFrom("?from=%2Fapps%2Fmy-app%2Fusage")).toBe("/apps/my-app/usage");
  });

  it("falls back to the landing page for missing or unsafe values", () => {
    expect(returnPathFrom("")).toBe("/apps");
    expect(returnPathFrom("?from=https%3A%2F%2Fevil.example")).toBe("/apps");
    expect(returnPathFrom("?from=%2F%2Fevil.example")).toBe("/apps");
  });
});

describe("loginUrlFor", () => {
  it("remembers a deep link", () => {
    expect(loginUrlFor("/apps/my-app/usage")).toBe("/login?from=%2Fapps%2Fmy-app%2Fusage");
  });

  it("stays bare for the landing page and unsafe input", () => {
    expect(loginUrlFor("/apps")).toBe("/login");
    expect(loginUrlFor("//evil.example")).toBe("/login");
    expect(loginUrlFor(null)).toBe("/login");
  });

  it("round-trips with returnPathFrom", () => {
    const url = loginUrlFor("/apps/a b/usage?tab=1");
    expect(returnPathFrom(url.slice(url.indexOf("?")))).toBe("/apps/a b/usage?tab=1");
  });
});

describe("oauthErrorNotice", () => {
  it("reports nothing without an error param", () => {
    expect(oauthErrorNotice("")).toBeNull();
    expect(oauthErrorNotice("?from=%2Fapps")).toBeNull();
  });

  it("explains a cancelled consent without alarming the operator", () => {
    const notice = oauthErrorNotice("?error=access_denied");
    expect(notice?.tone).toBe("default");
    expect(notice?.title).toMatch(/cancelled/i);
  });

  it("explains both spellings of a closed-registration rejection", () => {
    for (const code of ["registration_disabled", "signup_disabled"]) {
      const notice = oauthErrorNotice(`?error=${code}`);
      expect(notice?.tone, code).toBe("destructive");
      expect(notice?.description, code).toMatch(/not registered/i);
    }
  });

  it("normalizes provider spelling variants", () => {
    expect(oauthErrorNotice("?error=Access%20Denied")?.title).toMatch(/cancelled/i);
    expect(oauthErrorNotice("?error=access-denied")?.title).toMatch(/cancelled/i);
  });

  it("falls back to generic copy for an unknown code", () => {
    const notice = oauthErrorNotice("?error=server_exploded");
    expect(notice?.tone).toBe("destructive");
    expect(notice?.title).toMatch(/sign-in failed/i);
  });
});

describe("plan intent carried in the query string", () => {
  it("accepts the catalog's own plan keys", () => {
    for (const key of ["free", "starter", "growth", "scale", "growth_v2", "pro-plus"]) {
      expect(planKeyFrom(`?plan=${key}`), key).toBe(key);
    }
  });

  it("refuses anything that is not a plain slug", () => {
    // It arrives from a link anyone can write, and ends up in a URL and on screen.
    for (const raw of [
      "",
      "Growth",
      "growth plan",
      "../../etc",
      "%3Cscript%3E",
      "a".repeat(33),
    ]) {
      expect(planKeyFrom(`?plan=${raw}`), raw).toBeNull();
    }
    expect(planKeyFrom("")).toBeNull();
    expect(planKeyFrom("?from=%2Fapps")).toBeNull();
  });

  it("sends a paid plan to checkout once the operator is authenticated", () => {
    expect(postAuthPath("?plan=growth")).toBe("/checkout?plan=growth");
  });

  it("treats the free plan as no intent at all, since it is what they already have", () => {
    expect(postAuthPath("?plan=free")).toBe("/apps");
  });

  it("outranks a return path, which only this console's own 401 handling writes", () => {
    expect(postAuthPath("?from=%2Fproviders&plan=growth")).toBe("/checkout?plan=growth");
    expect(postAuthPath("?from=%2Fproviders")).toBe("/providers");
  });

  it("survives a round trip through the sign-in screen", () => {
    const url = loginUrlFor(postAuthPath("?plan=growth"));
    expect(url).toBe("/login?from=%2Fcheckout%3Fplan%3Dgrowth");
    // The query is the whole point: a checkout path without it buys nothing.
    expect(returnPathFrom(url.slice(url.indexOf("?")))).toBe("/checkout?plan=growth");
  });

  it("carries the plan onto the other auth screen, and nothing when there is none", () => {
    expect(authPathWithPlan("/login", "growth")).toBe("/login?plan=growth");
    expect(authPathWithPlan("/login", null)).toBe("/login");
  });
});

describe("checkout return", () => {
  it("recognises only the completed-checkout marker", () => {
    expect(checkoutSucceeded("?checkout=success")).toBe(true);
    expect(checkoutSucceeded("?checkout=cancelled")).toBe(false);
    expect(checkoutSucceeded("?checkout=")).toBe(false);
    expect(checkoutSucceeded("")).toBe(false);
    // Anyone may write this onto a URL; it only ever announces, so the worst a
    // crafted link achieves is a toast and a re-read of the plan.
    expect(checkoutSucceeded("?plan=growth")).toBe(false);
  });

  it("spends the marker without disturbing the rest of the query", () => {
    expect(pathWithoutCheckout("/apps", "?checkout=success")).toBe("/apps");
    expect(pathWithoutCheckout("/apps", "?checkout=success&month=2026-09")).toBe(
      "/apps?month=2026-09",
    );
    expect(pathWithoutCheckout("/apps", "")).toBe("/apps");
  });

  it("returns to the landing page carrying the marker", () => {
    expect(CHECKOUT_RETURN_PATH).toBe("/apps?checkout=success");
    expect(checkoutSucceeded(CHECKOUT_RETURN_PATH.slice(CHECKOUT_RETURN_PATH.indexOf("?")))).toBe(
      true,
    );
  });
});
