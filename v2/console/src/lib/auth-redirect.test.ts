import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import {
  consoleUrl,
  isRetryableError,
  isSafeReturnPath,
  loginUrlFor,
  oauthErrorNotice,
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
    expect(returnPathFrom("")).toBe("/access");
    expect(returnPathFrom("?from=https%3A%2F%2Fevil.example")).toBe("/access");
    expect(returnPathFrom("?from=%2F%2Fevil.example")).toBe("/access");
  });
});

describe("loginUrlFor", () => {
  it("remembers a deep link", () => {
    expect(loginUrlFor("/apps/my-app/usage")).toBe("/login?from=%2Fapps%2Fmy-app%2Fusage");
  });

  it("stays bare for the landing page and unsafe input", () => {
    expect(loginUrlFor("/access")).toBe("/login");
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
