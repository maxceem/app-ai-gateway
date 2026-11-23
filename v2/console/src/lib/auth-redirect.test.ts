import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import {
  AUTH_PATHS,
  checkoutReturnAccount,
  consoleUrl,
  isRetryableError,
  isSafeReturnPath,
  loginUrlFor,
  oauthErrorNotice,
  returnPathFrom,
  routerPath,
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

  it("rejects a path that does not parse, or that the browser would read as another origin, without throwing (Sol 7b-8)", () => {
    // `from=%2F%09%2F`: a tab is dropped from URLs, leaving "//", which does not parse.
    expect(() => isSafeReturnPath("/\t/")).not.toThrow();
    expect(isSafeReturnPath("/\t/")).toBe(false);
    expect(isSafeReturnPath("/\t/evil.example")).toBe(false);
    expect(isSafeReturnPath("/\n/evil.example")).toBe(false);
    expect(returnPathFrom("?from=%2F%09%2F")).toBe("/apps");
    expect(checkoutReturnAccount("?from=%2F%09%2F")).toBeNull();
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
      expect(notice?.description, code).toMatch(/not allowed to create an account/i);
    }
  });

  it("normalizes provider spelling variants", () => {
    expect(oauthErrorNotice("?error=Access%20Denied")?.title).toMatch(/cancelled/i);
    expect(oauthErrorNotice("?error=access-denied")?.title).toMatch(/cancelled/i);
  });

  it("sends a refused Google link back to the password it already has", () => {
    const notice = oauthErrorNotice("?error=account_not_linked");
    expect(notice?.tone).toBe("destructive");
    expect(notice?.description).toMatch(/sign in with your password/i);
  });

  it("falls back to generic copy for an unknown code", () => {
    const notice = oauthErrorNotice("?error=server_exploded");
    expect(notice?.tone).toBe("destructive");
    expect(notice?.title).toMatch(/sign-in failed/i);
  });
});

describe("consoleUrl", () => {
  it("puts the console's /v2 base in front of a router path", () => {
    expect(consoleUrl("/access")).toBe("/v2/access");
    expect(consoleUrl("/login?from=%2Faccess")).toBe("/v2/login?from=%2Faccess");
  });
});

describe("routerPath", () => {
  it("takes off the console's /v2 base, and one trailing slash", () => {
    expect(routerPath("/v2/access")).toBe("/access");
    expect(routerPath("/v2")).toBe("/");
    expect(routerPath("/v2/")).toBe("/");
    // The sign-in page with a trailing slash is still an auth page, so a 401 there is not a redirect.
    expect(AUTH_PATHS.has(routerPath("/v2/login/"))).toBe(true);
  });
});
