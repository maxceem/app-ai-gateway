import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApprovePage } from "./approve";
import { renderPublic, stubApi } from "@/test/render";

const ID = "5ee48248-54f1-4fa5-9bf1-b69d702bceb5";
const PROOF = "p".repeat(43);
const DETAILS_URL = `/v2/console/handoffs/${ID}`;
const SUBMIT_URL = `/v2/console/handoffs/${ID}/submit`;
const DENY_URL = `/v2/console/handoffs/${ID}/deny`;
const KEY = "sk-entered-on-the-page-0123456789";

function details(overrides: Record<string, unknown> = {}) {
  return {
    body: {
      id: ID,
      kind: "provider.add",
      state: "pending",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      account: { id: "acc_1234", name: "Acme" },
      review: { type: "openai", name: "OpenAI production", slug: "openai-prod", baseUrl: null, destinations: ["https://api.openai.com/"] },
      ...overrides,
    },
  };
}

function renderApprove(route = `/approve/${ID}#${PROOF}`) {
  return renderPublic(<ApprovePage />, { route, path: "/approve/:id" });
}

function calls(fetchMock: ReturnType<typeof stubApi>, url: string) {
  return fetchMock.mock.calls.filter(([called]) => String(called) === url);
}

beforeEach(() => sessionStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("ApprovePage", () => {
  it("shows what is asked, sends the key with the link's proof, and keeps no copy", async () => {
    // Submit and deny are listed before details: their URLs start with it.
    const fetchMock = stubApi({ [SUBMIT_URL]: { body: { state: "completed" } }, [DETAILS_URL]: details() });
    const { router } = renderApprove();

    expect(await screen.findByText("OpenAI production")).toBeTruthy();
    expect(screen.getByText("openai-prod")).toBeTruthy();
    // The proof leaves the address bar on arrival.
    await waitFor(() => expect(router.location.hash).toBe(""));
    const [, init] = calls(fetchMock, DETAILS_URL)[0]!;
    expect(JSON.parse(String(init!.body))).toEqual({ proof: PROOF });

    // Pasted, as a person enters a key, and much faster than typing it.
    await userEvent.click(screen.getByLabelText(/provider key/i));
    await userEvent.paste(KEY);
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));

    expect(await screen.findByText(/provider connection added/i)).toBeTruthy();
    const [, sent] = calls(fetchMock, SUBMIT_URL)[0]!;
    expect(JSON.parse(String(sent!.body))).toEqual({ proof: PROOF, secret: KEY });
    expect(screen.queryByDisplayValue(KEY)).toBeNull();
  });

  it("names the account the key goes into and where it is sent", async () => {
    stubApi({ [DETAILS_URL]: details() });
    renderApprove();

    expect(await screen.findByText("Acme")).toBeTruthy();
    expect(screen.getByText("acc_1234")).toBeTruthy();
    expect(screen.getByText("https://api.openai.com/")).toBeTruthy();
    expect(screen.getByText(/sends it only to the provider/i)).toBeTruthy();
  });

  it("warns that a custom address receives the key, and promises nothing", async () => {
    stubApi({
      [DETAILS_URL]: details({
        review: { type: "openai", name: "Self-hosted", slug: "own", baseUrl: "https://llm.example.net/", destinations: ["https://llm.example.net/"] },
      }),
    });
    renderApprove();

    expect(await screen.findByText(/names its own address/i)).toBeTruthy();
    expect(screen.getByText(/whoever controls that address receives the key/i)).toBeTruthy();
    expect(screen.queryByText(/sends it only to the provider/i)).toBeNull();
  });

  it("locks the key field while the approval is sent", async () => {
    let answer!: (response: Response) => void;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === SUBMIT_URL) return new Promise<Response>((resolve) => (answer = resolve));
      return new Response(JSON.stringify(details().body), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderApprove();

    const field = await screen.findByLabelText(/provider key/i);
    await userEvent.click(field);
    await userEvent.paste(KEY);
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));
    await waitFor(() => expect(field.closest("fieldset")!.disabled).toBe(true));
    answer(new Response(JSON.stringify({ state: "completed" }), { status: 200 }));
    expect(await screen.findByText(/provider connection added/i)).toBeTruthy();
  });

  it("declines without a key", async () => {
    const fetchMock = stubApi({ [DENY_URL]: { body: { state: "denied" } }, [DETAILS_URL]: details() });
    renderApprove();

    await userEvent.click(await screen.findByRole("button", { name: /decline/i }));
    expect(await screen.findByText(/nothing was changed/i)).toBeTruthy();
    expect(calls(fetchMock, SUBMIT_URL)).toHaveLength(0);
    const [, sent] = calls(fetchMock, DENY_URL)[0]!;
    expect(JSON.parse(String(sent!.body))).toEqual({ proof: PROOF });
  });

  it("shows the key it replaces for a key replacement", async () => {
    stubApi({ [DETAILS_URL]: details({ kind: "provider.rotate-key", review: { type: "openai", name: "Prod", slug: "openai", baseUrl: null, destinations: ["https://api.openai.com/"], secretHint: "wxyz" } }) });
    renderApprove();

    expect(await screen.findByText(/replace a provider key/i)).toBeTruthy();
    expect(screen.getByText("…wxyz")).toBeTruthy();
    expect(screen.getByLabelText(/new provider key/i)).toBeTruthy();
  });

  it("says why the request cannot be answered", async () => {
    stubApi({ [DETAILS_URL]: { status: 410, body: { error: { code: "operation_expired", message: "Expired" } } } });
    renderApprove();

    expect(await screen.findByText(/this link has expired\. ask for a new one/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
  });

  it("keeps the proof for a reload before the details have loaded", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    const { router } = renderApprove();
    await waitFor(() => expect(router.location.hash).toBe(""));
    expect(sessionStorage.getItem(`app-ai-gateway:approve:${ID}`)).toContain(PROOF);
  });

  it("asks for nothing without the link's proof", async () => {
    const fetchMock = stubApi({ [DETAILS_URL]: details() });
    renderApprove(`/approve/${ID}`);

    expect(await screen.findByText(/missing its proof/i)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("tells a person the step was already approved", async () => {
    stubApi({ [DETAILS_URL]: details({ state: "completed" }) });
    renderApprove();

    expect(await screen.findByText(/provider connection added/i)).toBeTruthy();
    expect(screen.queryByLabelText(/provider key/i)).toBeNull();
  });
});
