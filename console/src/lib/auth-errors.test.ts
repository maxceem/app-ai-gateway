import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { authErrorMessage, isRegistrationDisabled } from "./auth-errors";

describe("authErrorMessage", () => {
  it("translates Better Auth's SCREAMING_SNAKE codes into operator-facing copy", () => {
    const error = new ApiError(401, "INVALID_EMAIL_OR_PASSWORD", "Invalid email or password");
    expect(authErrorMessage(error)).toBe("That email and password combination is not correct.");
  });

  it("translates the gateway's registration_disabled code", () => {
    const error = new ApiError(403, "registration_disabled", "Public registration is disabled");
    expect(authErrorMessage(error)).toMatch(/registration is disabled/i);
  });

  it("keeps an unmapped but human-readable server message", () => {
    const error = new ApiError(400, "SOMETHING_NEW", "Your password is on a breach list.");
    expect(authErrorMessage(error)).toBe("Your password is on a breach list.");
  });

  it("falls back rather than showing the generic status text", () => {
    const error = new ApiError(500, "unknown", "Request failed with status 500");
    expect(authErrorMessage(error, "Sign-in failed")).toBe("Sign-in failed");
  });

  it("handles non-ApiError failures", () => {
    expect(authErrorMessage(new Error("network down"))).toBe("network down");
    expect(authErrorMessage("nonsense", "Fallback")).toBe("Fallback");
  });
});

describe("isRegistrationDisabled", () => {
  it("identifies only the gateway's registration_disabled error", () => {
    expect(isRegistrationDisabled(new ApiError(403, "registration_disabled", ""))).toBe(true);
    expect(isRegistrationDisabled(new ApiError(403, "forbidden", ""))).toBe(false);
    expect(isRegistrationDisabled(new Error("boom"))).toBe(false);
  });
});
