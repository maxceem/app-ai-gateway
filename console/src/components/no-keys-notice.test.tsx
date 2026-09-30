import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { NoKeysNotice } from "./no-keys-notice";
import { renderAuthenticated, stubApi } from "@/test/render";

const APP_ID = "my-app";

function renderNotice(keys: Array<{ status: string }>) {
  stubApi({ [`/v1/admin/apps/${APP_ID}/keys`]: { body: { app_id: APP_ID, keys } } });
  return renderAuthenticated(<NoKeysNotice appId={APP_ID} />);
}

afterEach(() => vi.unstubAllGlobals());

describe("NoKeysNotice", () => {
  it("says when a server app has no key anything could call it with", async () => {
    renderNotice([{ status: "revoked" }]);

    expect(await screen.findByText(/no active API key/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /create an API key/i }).getAttribute("href"))
      .toBe(`/apps/${APP_ID}/auth/identity`);
  });

  it("stays quiet while a key is active", async () => {
    const { container } = renderNotice([{ status: "active" }]);

    // Nothing to wait for on screen, so wait for the request to have answered.
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(0));
    expect(screen.queryByText(/no active API key/i)).toBeNull();
    expect(container.textContent).toBe("");
  });
});
