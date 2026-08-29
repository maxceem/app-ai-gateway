import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ManagementKeysPage } from "./management-keys";
import { renderAuthenticated } from "@/test/render";

const PLAINTEXT = "agw_mgmt_abcdefghijklmnopqrstuvwxyz0123456789";

const EXISTING = {
  id: "key-1",
  organizationId: "org-1",
  name: "CI deploy",
  createdAt: "2026-02-01T00:00:00.000Z",
  revokedAt: null,
};

function stubKeys(created?: unknown) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/v1/admin/keys") && init?.method === "POST") {
      return new Response(JSON.stringify(created ?? { key: { ...EXISTING, plaintext: PLAINTEXT } }), {
        status: 201,
      });
    }
    return new Response(JSON.stringify({ keys: [EXISTING] }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Walks the modal flow: open it, name the key, submit. */
async function createKey(name: string) {
  await userEvent.click(await screen.findByRole("button", { name: /new key/i }));
  await userEvent.type(await screen.findByLabelText(/key name/i), name);
  await userEvent.click(screen.getByRole("button", { name: /create key/i }));
}

afterEach(() => vi.unstubAllGlobals());

describe("ManagementKeysPage", () => {
  it("lists existing keys with their metadata", async () => {
    stubKeys();
    renderAuthenticated(<ManagementKeysPage />);

    expect(await screen.findByText("CI deploy")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
  });

  it("names the key in a modal and sends it", async () => {
    const fetchMock = stubKeys();
    renderAuthenticated(<ManagementKeysPage />);

    await createKey("Automation");

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
      expect(post && JSON.parse(String(post[1]?.body)).name).toBe("Automation");
    });
  });

  it("reveals the plaintext exactly once and warns it will not reappear", async () => {
    stubKeys();
    renderAuthenticated(<ManagementKeysPage />);

    await createKey("Automation");

    expect(await screen.findByDisplayValue(PLAINTEXT)).toBeTruthy();
    expect(screen.getByText(/you will not see it again/i)).toBeTruthy();
  });

  it("removes the plaintext from the screen once acknowledged", async () => {
    stubKeys();
    renderAuthenticated(<ManagementKeysPage />);

    await createKey("Automation");
    await screen.findByDisplayValue(PLAINTEXT);

    await userEvent.click(screen.getByRole("button", { name: /saved this key/i }));

    // The credential must not survive anywhere the operator can read it again.
    await waitFor(() => expect(screen.queryByDisplayValue(PLAINTEXT)).toBeNull());
  });

  it("stops a read-only member creating or revoking keys", async () => {
    stubKeys();
    renderAuthenticated(<ManagementKeysPage />, { session: { role: "member" } });

    await screen.findByText("CI deploy");
    expect(screen.getByRole("button", { name: /new key/i })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: /revoke/i })).toHaveProperty("disabled", true);
  });

  it("lets an owner revoke a key after confirming", async () => {
    const fetchMock = stubKeys();
    renderAuthenticated(<ManagementKeysPage />);

    await userEvent.click(await screen.findByRole("button", { name: /revoke/i }));
    await userEvent.click(await screen.findByRole("button", { name: /revoke key/i }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).includes("/v1/admin/keys/key-1/revoke")),
      ).toBe(true);
    });
  });
});
