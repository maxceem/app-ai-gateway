import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { AuthPolicyTab } from "./auth-policy";
import { renderAuthenticated, stubApi } from "@/test/render";
import type { AppDraft } from "@/hooks/use-app-draft";

const APP_ID = "my-app";

/**
 * The tab only reads a slice of the draft, so the fixture supplies that slice
 * rather than reproducing the whole `useAppDraft` surface.
 */
function appleDraft(): AppDraft {
  return {
    draft: {
      name: "My app",
      status: "active",
      config: {
        authentication: {
          type: "apple_app_attest",
          issuer: { required_claims: [] },
          app_attest: {
            team_id: "AAAAAAAAAA",
            bundle_id: "com.example.test",
            environments: ["production"],
          },
          development_access: true,
        },
      },
    },
    dirty: false,
    save: vi.fn(),
    updateIssuer: vi.fn(),
    updateAuthentication: vi.fn(),
  } as unknown as AppDraft;
}

function stubCredential() {
  return stubApi({
    "/v1/admin/apps": { body: { enabled: true, secret_prefix: "devsec_abc" } },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("AuthPolicyTab development access for a read-only member", () => {
  it("disables the development-access switch", async () => {
    stubCredential();
    renderAuthenticated(<AuthPolicyTab appId={APP_ID} state={appleDraft()} />, {
      session: { role: "member" },
    });

    const toggle = await screen.findByRole("switch", { name: /simulator development access/i });
    expect(toggle).toHaveProperty("disabled", true);
  });

  it("disables rotating the stored credential", async () => {
    stubCredential();
    renderAuthenticated(<AuthPolicyTab appId={APP_ID} state={appleDraft()} />, {
      session: { role: "member" },
    });

    const rotate = await screen.findByRole("button", { name: /rotate/i });
    expect(rotate).toHaveProperty("disabled", true);
  });

  it("leaves both controls usable for an admin", async () => {
    stubCredential();
    renderAuthenticated(<AuthPolicyTab appId={APP_ID} state={appleDraft()} />, {
      session: { role: "admin" },
    });

    // The switch is also disabled while the credential query is in flight.
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: /simulator development access/i }))
        .toHaveProperty("disabled", false));
    expect(await screen.findByRole("button", { name: /rotate/i })).toHaveProperty("disabled", false);
  });
});
