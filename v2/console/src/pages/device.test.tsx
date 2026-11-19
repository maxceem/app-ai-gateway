import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DevicePage, normalizeUserCode } from "./device";
import { capabilities, CAPABILITIES_URL, renderPublic, stubApi, testSession } from "@/test/render";

const ID = "device-0123abcd";
const CODE = "ABCD-EFGH";
const GET_SESSION_URL = "/v2/auth/get-session";
const SESSION_URL = "/v2/admin/session";
const LOOKUP_URL = "/v2/console/device/lookup";
const DETAILS_URL = `/v2/console/device/${ID}`;
const APPROVE_URL = `/v2/console/device/${ID}/approve`;
const DENY_URL = `/v2/console/device/${ID}/deny`;

const SIGNED_IN = {
  [GET_SESSION_URL]: { body: { session: { id: "s" }, user: { id: "user-1" } } },
  [SESSION_URL]: { body: { session: testSession() } },
};

function details(overrides: Record<string, unknown> = {}) {
  return {
    body: {
      id: ID,
      state: "pending",
      client: { id: "agw-cli", name: "App AI Gateway CLI", domain: null, source: "registered" },
      requestedGrant: "manage",
      userCode: CODE,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      accounts: [
        { id: "acct-1", name: "Acme", role: "owner" },
        { id: "acct-2", name: "Globex", role: "member" },
      ],
      ...overrides,
    },
  };
}

/**
 * The stub matches by prefix, and the details path is a prefix of the approve
 * and deny paths, so those are listed first.
 */
function stubDevice(extra: Record<string, { status?: number; body: unknown }> = {}) {
  return stubApi({
    ...extra,
    ...SIGNED_IN,
    [LOOKUP_URL]: { body: { id: ID, expiresAt: new Date(Date.now() + 600_000).toISOString() } },
    [DETAILS_URL]: details(),
  });
}

function renderDevice(route = "/device") {
  return renderPublic(<DevicePage />, { route, path: "/device" });
}

function bodyOf(fetchMock: ReturnType<typeof stubApi>, url: string) {
  const call = fetchMock.mock.calls.find(([input]) => String(input) === url);
  return call ? JSON.parse(String(call[1]!.body)) : undefined;
}

async function enterCode(code = CODE) {
  await userEvent.type(await screen.findByLabelText(/^code$/i), code);
  await userEvent.click(screen.getByRole("button", { name: /continue/i }));
}

afterEach(() => vi.unstubAllGlobals());

describe("normalizeUserCode", () => {
  it("ignores case and separators, and refuses anything that is not eight letters and digits", () => {
    expect(normalizeUserCode("abcd efgh")).toBe(CODE);
    expect(normalizeUserCode("ABCDEFGH")).toBe(CODE);
    expect(normalizeUserCode("ABC-DEF")).toBeNull();
  });
});

describe("DevicePage", () => {
  it("asks a signed-out person to sign in, coming back with the code still in the address", async () => {
    stubApi({ [GET_SESSION_URL]: { body: null }, [CAPABILITIES_URL]: capabilities() });
    renderDevice(`/device?user_code=${CODE}`);

    const signIn = await screen.findByRole("link", { name: /^sign in$/i });
    expect(signIn.getAttribute("href")).toBe(`/login?from=${encodeURIComponent(`/device?user_code=${CODE}`)}`);
  });

  it("finds the sign-in by its code and allows it with the chosen account and grant", async () => {
    const fetchMock = stubDevice({ [APPROVE_URL]: { body: { state: "completed" } } });
    renderDevice();

    await enterCode("abcd efgh");
    expect(bodyOf(fetchMock, LOOKUP_URL)).toEqual({ userCode: CODE });
    expect(await screen.findByText(CODE)).toBeTruthy();
    expect(bodyOf(fetchMock, DETAILS_URL)).toEqual({ userCode: CODE });

    // Nothing is allowed until the person says the code matches and picks an account.
    const allow = screen.getByRole("button", { name: /^allow$/i });
    expect(allow).toHaveProperty("disabled", true);
    await userEvent.click(screen.getByRole("radio", { name: /globex/i }));
    expect(allow).toHaveProperty("disabled", true);
    await userEvent.click(screen.getByRole("checkbox", { name: /code on my terminal/i }));
    await userEvent.click(screen.getByRole("radio", { name: /read only/i }));
    await userEvent.click(allow);

    expect(await screen.findByText(/cli signed in/i)).toBeTruthy();
    expect(bodyOf(fetchMock, APPROVE_URL)).toEqual({ userCode: CODE, accountId: "acct-2", grant: "read" });
  });

  it("only fills in a code from the link, and sends nothing until the person continues", async () => {
    const fetchMock = stubDevice();
    renderDevice(`/device?user_code=${CODE}`);

    const input = await screen.findByLabelText(/^code$/i);
    expect((input as HTMLInputElement).value).toBe(CODE);
    expect(fetchMock.mock.calls.some(([url]) => String(url) === LOOKUP_URL)).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(await screen.findByRole("button", { name: /^allow$/i })).toBeTruthy();
  });

  it("denies the sign-in", async () => {
    const fetchMock = stubDevice({ [DENY_URL]: { body: { state: "denied" } } });
    renderDevice();

    await enterCode();
    await userEvent.click(await screen.findByRole("button", { name: /^deny$/i }));

    expect(await screen.findByText(/sign-in declined/i)).toBeTruthy();
    expect(bodyOf(fetchMock, DENY_URL)).toEqual({ userCode: CODE });
  });

  it("says plainly when no sign-in matches the code", async () => {
    stubApi({
      ...SIGNED_IN,
      [LOOKUP_URL]: { status: 404, body: { error: { code: "not_found", message: "No sign-in is waiting for this code." } } },
    });
    renderDevice();

    await enterCode();
    expect((await screen.findByRole("alert")).textContent).toMatch(/no sign-in matches that code/i);
  });

  it("refuses a code of the wrong shape before asking the gateway", async () => {
    const fetchMock = stubDevice();
    renderDevice();

    await enterCode("ABC");
    expect((await screen.findByRole("alert")).textContent).toMatch(/eight letters and digits/i);
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url) === LOOKUP_URL)).toBe(false));
  });
});
