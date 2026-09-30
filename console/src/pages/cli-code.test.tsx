import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { CliApprovePage } from "./cli-approve";
import { CliCodePage } from "./cli-code";
import { stubApi, testQueryClient } from "@/test/render";

const OPERATION_ID = "cli-operation:login1";
const ENCODED = encodeURIComponent(OPERATION_ID);
const LOOKUP_URL = "/v1/cli/browser/lookup";
const DETAILS_URL = `/v1/cli/browser/${ENCODED}/details`;

const LOGIN_DETAILS = {
  body: {
    kind: "login",
    payload: {},
    account: null,
    viewer: { name: "Ada Lovelace", email: "ada@example.test" },
    blockedBy: null,
    googleEnabled: false,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    userCode: "ABCD-EFGH",
    client: { label: "CLI on mac-studio", os: null, ip: null, requestedAt: "2026-09-29T10:00:00.000Z" },
    hasLoopbackRedirect: false,
    organizations: [{ id: "org-1", name: "Acme", role: "owner" }],
  },
};

/** Both pages, so a found code can be followed onto the approval screen. */
function renderCodeEntry() {
  return render(
    <QueryClientProvider client={testQueryClient()}>
      <MemoryRouter initialEntries={["/cli"]}>
        <Routes>
          <Route path="/cli" element={<CliCodePage />} />
          <Route path="/cli/approve/:id" element={<CliApprovePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function bodyOf(fetchMock: ReturnType<typeof stubApi>, fragment: string) {
  const call = fetchMock.mock.calls.find(([url]) => String(url).includes(fragment));
  return call ? (JSON.parse(String(call[1]!.body)) as unknown) : undefined;
}

beforeEach(() => sessionStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe("CliCodePage", () => {
  it("finds the request by its code and carries the code to the approval page", async () => {
    const fetchMock = stubApi({
      [LOOKUP_URL]: {
        body: { found: true, id: OPERATION_ID, kind: "login", expiresAt: LOGIN_DETAILS.body.expiresAt },
      },
      [DETAILS_URL]: LOGIN_DETAILS,
    });

    renderCodeEntry();

    await userEvent.type(screen.getByLabelText(/pairing code/i), "abcdefgh");
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));

    // Typed however it was, it is looked up as the terminal prints it.
    await waitFor(() => expect(bodyOf(fetchMock, "/lookup")).toEqual({ userCode: "ABCD-EFGH" }));
    expect(await screen.findByText(/connect the agw cli/i)).toBeTruthy();
    // With no link, the code itself is the submission token.
    expect(bodyOf(fetchMock, "/details")).toEqual({ submissionToken: "ABCD-EFGH" });
    expect(screen.getByText("ABCD-EFGH")).toBeTruthy();
    expect(screen.queryByText(/missing its proof/i)).toBeNull();
  });

  it("accepts the dashed form as printed", async () => {
    const fetchMock = stubApi({ [LOOKUP_URL]: { body: { found: false } } });

    renderCodeEntry();

    await userEvent.type(screen.getByLabelText(/pairing code/i), "WDJB-MJHT");
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => expect(bodyOf(fetchMock, "/lookup")).toEqual({ userCode: "WDJB-MJHT" }));
  });

  it("says plainly when no request matches the code", async () => {
    stubApi({ [LOOKUP_URL]: { body: { found: false } } });

    renderCodeEntry();

    await userEvent.type(screen.getByLabelText(/pairing code/i), "ABCD-EFGH");
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/no request matches that code/i);
    // Still on the entry page, ready for another try.
    expect(screen.getByLabelText(/pairing code/i)).toBeTruthy();
  });

  it("refuses something that cannot be a code without asking the gateway", async () => {
    const fetchMock = stubApi({ [LOOKUP_URL]: { body: { found: false } } });

    renderCodeEntry();

    await userEvent.type(screen.getByLabelText(/pairing code/i), "ABC");
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/eight letters and digits/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
