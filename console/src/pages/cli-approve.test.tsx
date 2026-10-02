import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CliApprovePage } from "./cli-approve";
import { renderPublic, stubApi } from "@/test/render";

const OPERATION_ID = "cli-operation:abc123";
const ENCODED = encodeURIComponent(OPERATION_ID);
const PATH = `/cli/approve/${ENCODED}`;
const TOKEN = "a".repeat(48);
const DETAILS_URL = `/v1/cli/browser/${ENCODED}/details`;
const SUBMIT_URL = `/v1/cli/browser/${ENCODED}/submit`;
const REGISTER_URL = `/v1/cli/browser/${ENCODED}/register`;
const GOOGLE_URL = `/v1/cli/browser/${ENCODED}/google`;
const SIGN_OUT_URL = "/v1/auth/sign-out";

const account = {
  id: "org-abcdef-0123456789",
  name: "Acme",
  createdAt: "2026-01-01T00:00:00.000Z",
  claimed: false,
  expiresAt: null,
};

function details(overrides: Record<string, unknown> = {}) {
  return {
    body: {
      kind: "claim",
      payload: {},
      account,
      viewer: null,
      blockedBy: "registration_required",
      googleEnabled: false,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      ...overrides,
    },
  };
}

/** The two endings the gateway answers an approval with. */
const CONSOLE_OUTCOME = {
  body: {
    state: "completed",
    message: "This account is yours.",
    continueTo: "console",
  },
};
const CLI_OUTCOME = {
  body: {
    state: "completed",
    message: "You can close this tab and return to the CLI or agent that asked.",
    continueTo: "cli",
  },
};

/** Every case starts on the link the CLI printed: path plus proof fragment. */
function renderApprove(route = `${PATH}#${TOKEN}`) {
  return renderPublic(<CliApprovePage />, { route, path: "/cli/approve/:id" });
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe("CliApprovePage proof handling", () => {
  it("reads the proof from the fragment, sends it, and strips it from the URL", async () => {
    const fetchMock = stubApi({ [DETAILS_URL]: details() });

    const { router } = renderApprove();

    await screen.findByText(/claim your account/i);
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes("/details"));
    expect(JSON.parse(String(call![1]!.body))).toEqual({ submissionToken: TOKEN });
    await waitFor(() => expect(router.location.hash).toBe(""));
    expect(router.location.pathname).toBe(PATH);
    expect(router.location.search).toBe("");
  });

  it("recovers the proof from session storage when the fragment is gone", async () => {
    sessionStorage.setItem(
      `app-ai-gateway:cli-approve:${PATH}`,
      JSON.stringify({ token: TOKEN, expiresAt: Date.now() + 600_000 }),
    );
    const fetchMock = stubApi({ [DETAILS_URL]: details() });

    renderApprove(PATH);

    await screen.findByText(/claim your account/i);
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes("/details"));
    expect(JSON.parse(String(call![1]!.body))).toEqual({ submissionToken: TOKEN });
  });

  it("refuses a stored proof that has already expired", async () => {
    sessionStorage.setItem(
      `app-ai-gateway:cli-approve:${PATH}`,
      JSON.stringify({ token: TOKEN, expiresAt: Date.now() - 1 }),
    );
    stubApi({ [DETAILS_URL]: details() });

    renderApprove(PATH);

    expect((await screen.findByRole("alert")).textContent).toMatch(/missing its proof/i);
  });

  it("explains an expired operation instead of showing a form", async () => {
    stubApi({
      [DETAILS_URL]: {
        status: 410,
        body: { error: { code: "invalid_request", message: "Operation has expired" } },
      },
    });

    renderApprove();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/can no longer be approved/i);
    expect(alert.textContent).toMatch(/start the request again/i);
    // The id identifies the request even when nothing about it could load.
    const footnote = screen.getByText(OPERATION_ID);
    expect(footnote).toBeTruthy();
    expect(alert.contains(footnote)).toBe(false);
  });
});

describe("CliApprovePage claim", () => {
  it("offers creating a sign-in and no way at all to use an existing one", async () => {
    stubApi({ [DETAILS_URL]: details() });

    renderApprove();

    await screen.findByText(/claim your account/i);
    expect(screen.getByRole("button", { name: /create account/i })).toBeTruthy();
    expect(screen.getByLabelText(/^name$/i)).toBeTruthy();
    // Signing in would arrive with an account, which is what a claim refuses,
    // so the page never puts that door on screen unprompted.
    expect(screen.queryByRole("button", { name: /^sign in$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /sign in to it instead/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /approve request/i })).toBeNull();
  });

  it("answers a taken email with the one sign-in door, reached by failing", async () => {
    const fetchMock = stubApi({
      [DETAILS_URL]: details(),
      [REGISTER_URL]: { status: 422, body: { error: { code: "USER_ALREADY_EXISTS" } } },
      "/v1/auth/sign-in": { body: { token: "session" } },
    });

    renderApprove();

    await screen.findByText(/claim your account/i);
    await userEvent.type(screen.getByLabelText(/^name$/i), "Ada Lovelace");
    await userEvent.type(screen.getByLabelText(/^email$/i), "ada@example.test");
    await userEvent.type(screen.getByLabelText(/^password$/i), "correct-horse-42");
    await userEvent.click(screen.getByRole("button", { name: /create account/i }));

    const recover = await screen.findByRole("button", { name: /sign in to it instead/i });
    await userEvent.click(recover);

    // The recovery form asks only what signing in needs, and keeps the email.
    expect(screen.queryByLabelText(/^name$/i)).toBeNull();
    expect((screen.getByLabelText(/^email$/i) as HTMLInputElement).value).toBe("ada@example.test");
    await userEvent.type(screen.getByLabelText(/^password$/i), "correct-horse-42");
    await userEvent.click(screen.getByRole("button", { name: /^sign in$/i }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/auth/sign-in"))).toBe(true),
    );
  });

  it("sends a human who already has an account to sign out, then back to creating one", async () => {
    const routes: Record<string, { status?: number; body: unknown }> = {
      [DETAILS_URL]: details({
        blockedBy: "sign_out_required",
        viewer: { name: "Ada Lovelace", email: "ada@example.test" },
      }),
      [SIGN_OUT_URL]: { body: { success: true } },
    };
    const fetchMock = stubApi(routes);

    renderApprove();

    const signOut = await screen.findByRole("button", { name: /^sign out$/i });
    // The person being asked to leave is named, since it may not be who they expect.
    expect(screen.getAllByText("Ada Lovelace").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /approve request/i })).toBeNull();

    routes[DETAILS_URL] = details();
    await userEvent.click(signOut);

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/auth/sign-out"))).toBe(
        true,
      ),
    );
    // The refetch is what moves the page on: no navigation, so the proof stays.
    expect(await screen.findByRole("button", { name: /create account/i })).toBeTruthy();
    expect(screen.queryByText(/missing its proof/i)).toBeNull();
  });

  it("registers through the handoff endpoint rather than public sign-up", async () => {
    const fetchMock = stubApi({
      [DETAILS_URL]: details(),
      [REGISTER_URL]: { body: { token: "t" } },
    });

    renderApprove();

    await screen.findByText(/claim your account/i);
    await userEvent.type(screen.getByLabelText(/^name$/i), "Ada Lovelace");
    await userEvent.type(screen.getByLabelText(/^email$/i), "ada@example.test");
    await userEvent.type(screen.getByLabelText(/^password$/i), "correct-horse-42");
    await userEvent.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).includes("/register"));
      expect(call).toBeDefined();
      expect(JSON.parse(String(call![1]!.body))).toEqual({
        submissionToken: TOKEN,
        name: "Ada Lovelace",
        email: "ada@example.test",
        password: "correct-horse-42",
      });
    });
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/auth/sign-up")),
    ).toBe(false);
  });

  it("starts Google consent through the claim endpoint", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const fetchMock = stubApi({
      [DETAILS_URL]: details({ googleEnabled: true }),
      [GOOGLE_URL]: { body: { url: "https://accounts.example.test/consent" } },
    });

    renderApprove();

    await userEvent.click(await screen.findByRole("button", { name: /sign up with google/i }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://accounts.example.test/consent"));
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/auth/sign-in/social")),
    ).toBe(false);
  });

  it("explains a refused Google sign-in and leaves the claim finishable", async () => {
    // The gateway returns the browser here with no session and no response
    // body, so the query string is the only account of what happened.
    stubApi({ [DETAILS_URL]: details({ googleEnabled: true }) });

    renderApprove(`${PATH}?error=account_not_linked#${TOKEN}`);

    const notice = await screen.findByRole("alert");
    expect(notice.textContent).toMatch(/already signs in with a password/i);
    expect(notice.textContent).toMatch(/sign in with your password instead/i);
    // The password form is still there to finish the claim with.
    expect(screen.getByRole("button", { name: /create account/i })).toBeTruthy();
  });

  it("names the signed-in human beside the account and approves on one click", async () => {
    const fetchMock = stubApi({
      [DETAILS_URL]: details({
        viewer: { name: "Ada Lovelace", email: "ada@example.test" },
        blockedBy: null,
      }),
      [SUBMIT_URL]: CONSOLE_OUTCOME,
    });

    renderApprove();

    const approve = await screen.findByRole("button", { name: /approve request/i });
    // Which account is claimed, and which person is claiming it.
    expect(screen.getByText("Acme")).toBeTruthy();
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    expect(screen.getByText("ada@example.test")).toBeTruthy();
    expect((approve as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("checkbox")).toBeNull();
    await userEvent.click(approve);

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).includes("/submit"));
      expect(call).toBeDefined();
      expect(JSON.parse(String(call![1]!.body))).toEqual({
        submissionToken: TOKEN,
        approve: true,
      });
    });
    // A claim ends in the console the approver just gained, not back in the
    // terminal, and the gateway is what says so.
    expect(await screen.findByText(/this account is yours/i)).toBeTruthy();
    const onwards = screen.getByRole("link", { name: /go to your console/i });
    expect(onwards.getAttribute("href")).toBe("/apps");
    expect(screen.queryByText(/return to the cli or agent/i)).toBeNull();
    expect(sessionStorage.getItem(`app-ai-gateway:cli-approve:${PATH}`)).toBeNull();
  });
});

describe("CliApprovePage provider handoffs", () => {
  it("asks for the credential and never for a sign-in", async () => {
    const fetchMock = stubApi({
      [DETAILS_URL]: details({
        kind: "provider.add",
        payload: { type: "openai", name: "OpenAI" },
        blockedBy: null,
      }),
      [SUBMIT_URL]: CLI_OUTCOME,
    });

    renderApprove();

    expect(await screen.findByText(/add a provider/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^sign in$/i })).toBeNull();
    // The configuration is shown so it can be compared with the terminal.
    expect(screen.getByText(/"type": "openai"/)).toBeTruthy();

    const secret = screen.getByLabelText(/provider credential/i);
    expect(secret.getAttribute("type")).toBe("password");
    await userEvent.type(secret, "sk-test-value");
    // The one screen that still explains where a secret goes.
    expect(screen.getByText(/submitted directly to your gateway/i)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /approve request/i }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).includes("/submit"));
      expect(call).toBeDefined();
      expect(JSON.parse(String(call![1]!.body))).toEqual({
        submissionToken: TOKEN,
        approve: true,
        secret: "sk-test-value",
      });
    });
    // The command is still running, so this tab offers no way onwards.
    expect(await screen.findByText(/return to the cli or agent/i)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /console/i })).toBeNull();
  });

  it("omits the credential field when the provider is routed through a gateway", async () => {
    stubApi({
      [DETAILS_URL]: details({
        kind: "provider.add",
        payload: { type: "openai", providerGatewayId: "pg-1" },
        blockedBy: null,
      }),
    });

    renderApprove();

    await screen.findByText(/add a provider/i);
    expect(screen.queryByLabelText(/provider credential/i)).toBeNull();
    expect(screen.queryByText(/submitted directly to your gateway/i)).toBeNull();
  });
});

describe("CliApprovePage login", () => {
  const DENY_URL = `/v1/cli/browser/${ENCODED}/deny`;
  const VIEWER = { name: "Ada Lovelace", email: "ada@example.test" };
  const ACME = { id: "org-acme", name: "Acme", role: "owner" };
  const GLOBEX = { id: "org-globex", name: "Globex", role: "member" };

  function login(overrides: Record<string, unknown> = {}) {
    return details({
      kind: "login",
      account: null,
      viewer: VIEWER,
      blockedBy: null,
      userCode: "WDJB-MJHT",
      client: {
        label: "CLI on mac-studio",
        os: "darwin arm64",
        ip: "203.0.113.7",
        requestedAt: "2026-09-29T10:00:00.000Z",
      },
      hasLoopbackRedirect: false,
      organizations: [ACME],
      ...overrides,
    });
  }

  const LOGIN_OUTCOME = {
    body: { state: "completed", message: "Your CLI is signed in.", continueTo: "cli" },
  };

  function submitted(fetchMock: ReturnType<typeof stubApi>) {
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes("/submit"));
    return call ? (JSON.parse(String(call[1]!.body)) as unknown) : undefined;
  }

  it("shows the pairing code and the requester, and names a single account without asking", async () => {
    const fetchMock = stubApi({ [DETAILS_URL]: login(), [SUBMIT_URL]: LOGIN_OUTCOME });

    renderApprove();

    expect(await screen.findByText(/connect the agw cli/i)).toBeTruthy();
    expect(screen.getByText("WDJB-MJHT")).toBeTruthy();
    expect(screen.getByText(/matches the code in your terminal/i)).toBeTruthy();
    expect(screen.getByText("CLI on mac-studio")).toBeTruthy();
    expect(screen.getByText("darwin arm64")).toBeTruthy();
    expect(screen.getByText("203.0.113.7")).toBeTruthy();
    expect(screen.getByText("Acme")).toBeTruthy();
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    // One account is a fact, not a question.
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByRole("button", { name: /^sign out$/i })).toBeNull();
    expect(screen.getByRole("button", { name: /^deny$/i })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /^approve$/i }));

    await waitFor(() =>
      expect(submitted(fetchMock)).toEqual({
        submissionToken: TOKEN,
        approve: true,
        organizationId: "org-acme",
      }),
    );
    // No local listener: the terminal finishes on its own.
    expect(await screen.findByText(/return to your terminal/i)).toBeTruthy();
    expect(screen.getByText("Your CLI is signed in.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /console/i })).toBeNull();
  });

  it("asks which account when there are several, and approves none by default", async () => {
    const fetchMock = stubApi({
      [DETAILS_URL]: login({ organizations: [ACME, GLOBEX] }),
      [SUBMIT_URL]: LOGIN_OUTCOME,
    });

    renderApprove();

    const picker = await screen.findByRole("radiogroup", { name: /account for this cli/i });
    expect(picker).toBeTruthy();
    const approve = screen.getByRole("button", { name: /^approve$/i }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);

    await userEvent.click(screen.getByRole("radio", { name: /globex/i }));
    expect(approve.disabled).toBe(false);
    await userEvent.click(approve);

    await waitFor(() =>
      expect(submitted(fetchMock)).toEqual({
        submissionToken: TOKEN,
        approve: true,
        organizationId: "org-globex",
      }),
    );
  });

  it("hands the browser to the CLI's local listener by navigating, not fetching", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const redirectUrl = "http://127.0.0.1:53682/callback?code=xyz&state=abc";
    const fetchMock = stubApi({
      [DETAILS_URL]: login({ hasLoopbackRedirect: true }),
      [SUBMIT_URL]: { body: { ...LOGIN_OUTCOME.body, redirectUrl } },
    });

    renderApprove();

    await userEvent.click(await screen.findByRole("button", { name: /^approve$/i }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith(redirectUrl));
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("http://127.0.0.1"))).toBe(
      false,
    );
    expect(screen.getByRole("link", { name: /back to the cli/i }).getAttribute("href")).toBe(
      redirectUrl,
    );
    expect(screen.queryByText(/return to your terminal/i)).toBeNull();
  });

  it("declines the request and says so", async () => {
    const fetchMock = stubApi({
      [DETAILS_URL]: login(),
      [DENY_URL]: { body: { state: "denied", message: "Declined. Your CLI has been told." } },
    });

    renderApprove();

    await userEvent.click(await screen.findByRole("button", { name: /^deny$/i }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).includes("/deny"));
      expect(call).toBeDefined();
      expect(JSON.parse(String(call![1]!.body))).toEqual({ submissionToken: TOKEN });
    });
    expect(await screen.findByText(/request declined/i)).toBeTruthy();
    expect(screen.getByText("Declined. Your CLI has been told.")).toBeTruthy();
    expect(submitted(fetchMock)).toBeUndefined();
    expect(sessionStorage.getItem(`app-ai-gateway:cli-approve:${PATH}`)).toBeNull();
  });

  it("offers signing in before registering, and declining to someone signed out", async () => {
    stubApi({
      [DETAILS_URL]: login({ viewer: null, blockedBy: "registration_required", organizations: [] }),
    });

    renderApprove();

    expect(await screen.findByRole("button", { name: /^sign in$/i })).toBeTruthy();
    expect(screen.queryByLabelText(/^name$/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /^approve$/i })).toBeNull();
    expect(screen.getByRole("button", { name: /^deny$/i })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /create one/i }));
    expect(screen.getByLabelText(/^name$/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /create account/i })).toBeTruthy();
  });

  it("explains a signed-in person with no account to connect", async () => {
    stubApi({
      [DETAILS_URL]: login({ blockedBy: "no_eligible_organization", organizations: [] }),
    });

    renderApprove();

    const block = await screen.findByRole("alert");
    expect(block.textContent).toMatch(/no account to connect/i);
    expect(block.textContent).toMatch(/Ada Lovelace is not a member/);
    expect(screen.getByRole("button", { name: /sign in as someone else/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^approve$/i })).toBeNull();
    expect(screen.getByRole("button", { name: /^deny$/i })).toBeTruthy();
  });
});
