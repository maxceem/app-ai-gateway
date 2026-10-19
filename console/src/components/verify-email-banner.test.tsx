import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VerifyEmailBanner } from "./verify-email-banner";
import { renderAuthenticated, stubApi, testSession } from "@/test/render";

const SEND_URL = "/v1/console/email-verification/send";

function unverified() {
  const session = testSession();
  return {
    ...session,
    user: { ...session.user!, email: "person@example.test", emailVerified: false },
    verificationPending: true,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("VerifyEmailBanner", () => {
  it("asks an unverified person to verify, and sends a new link when asked", async () => {
    const fetchMock = stubApi({ [SEND_URL]: { body: { status: "sent", email: "person@example.test" } } });
    renderAuthenticated(<VerifyEmailBanner />, {
      session: unverified(),
      capabilities: { emailVerification: true },
    });

    expect(screen.getByText(/verify your email address to start serving requests/i)).toBeTruthy();
    expect(screen.getByText(/answer requests with/i)).toBeTruthy();
    expect(screen.getByText(/link sent to person@example.test/i)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /send a new link/i }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith(SEND_URL))).toBe(true),
    );
  });

  it("only reminds the owner of an account that is served anyway", () => {
    stubApi({});
    renderAuthenticated(<VerifyEmailBanner />, {
      session: { ...unverified(), verificationPending: false },
      capabilities: { emailVerification: true },
    });
    expect(screen.getByText(/^verify your email address$/i)).toBeTruthy();
    expect(screen.queryByText(/answer requests with/i)).toBeNull();
    expect(screen.getByText(/send yourself a verification link to confirm person@example.test/i)).toBeTruthy();
  });

  it("stays away where the deployment verifies nothing, and once the address is verified", () => {
    const { unmount } = renderAuthenticated(<VerifyEmailBanner />, {
      session: unverified(),
      capabilities: { emailVerification: false },
    });
    expect(screen.queryByText(/verify your email address/i)).toBeNull();
    unmount();

    renderAuthenticated(<VerifyEmailBanner />, { capabilities: { emailVerification: true } });
    expect(screen.queryByText(/verify your email address/i)).toBeNull();
  });
});
