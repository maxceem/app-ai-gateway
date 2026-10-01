import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RevealPage } from "./reveal";
import { renderPublic, stubApi } from "@/test/render";

const OPERATION_ID = "5ee48248-54f1-4fa5-9bf1-b69d702bceb5";
const STATUS_URL = `/v1/admin/operations/${OPERATION_ID}`;
const REVEAL_URL = `/v1/admin/operations/${OPERATION_ID}/reveal`;
const PLAINTEXT = "agw_revealed_once_0123456789";

function status(overrides: Record<string, unknown> = {}) {
  return {
    body: {
      id: OPERATION_ID,
      kind: "app.add.reserved",
      state: "completed",
      createdAt: "2026-10-01T10:00:00.000Z",
      expiresAt: "2026-10-01T10:15:00.000Z",
      result: {
        app: { id: "weather-k3j9", name: "Weather", revision: 1, status: "active" },
        api_key: { id: "key_1", name: "Default key", key_prefix: "agw_reve", created_at: "2026-10-01T10:00:00.000Z" },
      },
      reveal_url: `https://console.example.test/reveal/${OPERATION_ID}`,
      ...overrides,
    },
  };
}

const REVEALED = {
  body: {
    id: OPERATION_ID,
    kind: "app.add.reserved",
    result: { api_key: { id: "key_1", name: "Default key", key: PLAINTEXT, key_prefix: "agw_reve", created_at: "2026-10-01T10:00:00.000Z" } },
  },
};

function renderReveal() {
  return renderPublic(<RevealPage />, { route: `/reveal/${OPERATION_ID}`, path: "/reveal/:id" });
}

/** Whether the page has asked the gateway to hand the key over. */
function revealed(fetchMock: ReturnType<typeof stubApi>): boolean {
  return fetchMock.mock.calls.some(([url]) => String(url).startsWith(REVEAL_URL));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RevealPage", () => {
  it("shows what would be revealed and reveals nothing until the person asks", async () => {
    // The reveal route is listed first: its URL starts with the status URL.
    const fetchMock = stubApi({ [REVEAL_URL]: REVEALED, [STATUS_URL]: status() });
    renderReveal();

    expect(await screen.findByText(/the key of the new app "weather"/i)).toBeTruthy();
    expect(screen.getByText("weather-k3j9")).toBeTruthy();
    expect(screen.queryByDisplayValue(PLAINTEXT)).toBeNull();
    expect(revealed(fetchMock)).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: /reveal the key/i }));
    expect(await screen.findByDisplayValue(PLAINTEXT)).toBeTruthy();
    const call = fetchMock.mock.calls.find(([url]) => String(url).startsWith(REVEAL_URL));
    expect(call![1]!.method).toBe("POST");

    await userEvent.click(screen.getByRole("button", { name: /saved this key/i }));
    expect(await screen.findByText(/key revealed/i)).toBeTruthy();
    expect(screen.queryByDisplayValue(PLAINTEXT)).toBeNull();
  });

  it("says why the key was not revealed", async () => {
    stubApi({
      [REVEAL_URL]: { status: 409, body: { error: { code: "already_revealed", message: "This key was already revealed" } } },
      [STATUS_URL]: status(),
    });
    renderReveal();

    await userEvent.click(await screen.findByRole("button", { name: /reveal the key/i }));
    expect(await screen.findByText(/already revealed\. it is shown only once/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: /reveal the key/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("refuses a person without the role in the gateway's words", async () => {
    stubApi({
      [REVEAL_URL]: { status: 403, body: { error: { code: "forbidden", message: "Forbidden" } } },
      [STATUS_URL]: status(),
    });
    renderReveal();

    await userEvent.click(await screen.findByRole("button", { name: /reveal the key/i }));
    expect(await screen.findByText(/only an owner or admin/i)).toBeTruthy();
  });

  it("offers no button once nothing is left to reveal", async () => {
    const fetchMock = stubApi({ [STATUS_URL]: status({ reveal_url: undefined, state: "pending", result: undefined }) });
    renderReveal();

    expect(await screen.findByText(/nothing to reveal/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /reveal the key/i })).toBeNull();
    await waitFor(() => expect(revealed(fetchMock)).toBe(false));
  });

  it("calls a key whose window passed unrevealed unavailable, not revealed", async () => {
    // Completed with a key that nobody revealed before its window closed: the
    // status holds no reveal_url, exactly as after a reveal.
    const fetchMock = stubApi({ [REVEAL_URL]: REVEALED, [STATUS_URL]: status({ reveal_url: undefined }) });
    renderReveal();

    expect(await screen.findByText(/no longer available/i)).toBeTruthy();
    expect(screen.getByText(/can no longer be revealed here/i)).toBeTruthy();
    expect(screen.queryByText(/already revealed/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /reveal the key/i })).toBeNull();
    expect(revealed(fetchMock)).toBe(false);
  });

  it("explains an operation this account does not have", async () => {
    stubApi({
      [STATUS_URL]: { status: 404, body: { error: { code: "operation_not_found", message: "No operation of your account has this id" } } },
    });
    renderReveal();

    expect(await screen.findByText(/cannot be revealed/i)).toBeTruthy();
    expect(screen.getByText(/signed in to the account the key was created in/i)).toBeTruthy();
  });
});
