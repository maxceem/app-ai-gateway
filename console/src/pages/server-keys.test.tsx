import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ServerKeys } from "./server-keys";
import { renderAuthenticated } from "@/test/render";

const APP_ID = "my-app";

const CREATED = {
  id: "key_1",
  name: "Production Worker",
  key: "sk_live_the_only_copy",
  key_prefix: "sk_live",
  created_at: "2026-01-01T00:00:00.000Z",
};

/**
 * Routes by method as well as path: creating a key and listing them share a
 * URL, and this flow is exactly about what each one returns.
 */
function stubKeyApi() {
  const rows: unknown[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes(`/apps/${APP_ID}/keys`)) {
      return new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 });
    }
    if (init?.method === "POST") {
      rows.push({ ...CREATED, status: "active", last_used_at: null });
      return new Response(JSON.stringify(CREATED), { status: 200 });
    }
    return new Response(JSON.stringify({ app_id: APP_ID, keys: rows }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const dialog = () => screen.findByRole("dialog");

afterEach(() => vi.unstubAllGlobals());

describe("ServerKeys", () => {
  it("asks for the name in a modal and reveals the key once it exists", async () => {
    const fetchMock = stubKeyApi();
    renderAuthenticated(<ServerKeys appId={APP_ID} />, { route: `/apps/${APP_ID}/auth/identity` });

    expect(await screen.findByText(/no api keys yet/i)).toBeTruthy();
    // Nothing about the key is asked for until the modal is open.
    expect(screen.queryByLabelText(/key name/i)).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /new key/i }));
    await userEvent.type(within(await dialog()).getByLabelText(/key name/i), CREATED.name);
    await userEvent.click(within(await dialog()).getByRole("button", { name: /create key/i }));

    const reveal = await dialog();
    expect((within(reveal).getByLabelText(/api key/i) as HTMLInputElement).value).toBe(CREATED.key);
    expect(within(reveal).getByText(/only time the plaintext/i)).toBeTruthy();

    const posted = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(posted?.[1]?.body))).toEqual({ name: CREATED.name });

    await userEvent.click(within(reveal).getByRole("button", { name: /saved this key/i }));

    // The plaintext is gone from the screen, and the key is in the list.
    expect(screen.queryByDisplayValue(CREATED.key)).toBeNull();
    expect(await screen.findByText(CREATED.name)).toBeTruthy();
  });

  it("does not offer key creation to a read-only member", async () => {
    stubKeyApi();
    renderAuthenticated(<ServerKeys appId={APP_ID} />, { session: { role: "member" } });

    expect(await screen.findByText(/no api keys yet/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /new key/i })).toHaveProperty("disabled", true);
  });
});
