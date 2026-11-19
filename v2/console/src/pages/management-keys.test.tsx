import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ManagementKeysPage } from "./management-keys";
import { renderAuthenticated } from "@/test/render";

const PLAINTEXT = "agw_mgmt_abcdefghijklmnopqrstuvwxyz0123456789";

const EXISTING = {
  id: "key-1",
  organizationId: "org-1",
  name: "CI deploy",
  tokenHint: "6789",
  enabled: true,
  createdAt: "2026-02-01T00:00:00.000Z",
  revokedAt: null,
  source: "console",
  credentialType: "apiKey",
  label: null,
  grant: "manage",
  clientId: null,
  expiresAt: null,
};

/** An OAuth connection an MCP client holds, as the gateway lists it beside the keys. */
const CONNECTION = {
  ...EXISTING,
  id: "connection-1",
  // The client's own claim for itself: untrusted text the page must show as text.
  name: "<img src=x onerror=alert(1)> Agent",
  tokenHint: "zzzz",
  source: "oauth",
  credentialType: "oauth",
  label: "<img src=x onerror=alert(1)> Agent",
  grant: "read",
  clientId: "https://agent.example/oauth/client.json",
  expiresAt: "2026-03-03T00:00:00.000Z",
};

function stubKeys(created?: unknown, keys: unknown[] = [EXISTING]) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/v1/admin/keys") && init?.method === "POST") {
      return new Response(JSON.stringify(created ?? { key: { ...EXISTING, plaintext: PLAINTEXT } }), {
        status: 201,
      });
    }
    return new Response(JSON.stringify({ keys }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Row actions live behind the row's menu, so a test has to open it first. */
async function openRowActions(label: string) {
  await userEvent.click(await screen.findByRole("button", { name: `Actions for ${label}` }));
  return await screen.findByRole("menu");
}

/** Walks the modal flow: open it, name the key, submit. */
async function createKey(name: string) {
  await userEvent.click(await screen.findByRole("button", { name: /new key/i }));
  await userEvent.type(await screen.findByLabelText(/key name/i), name);
  await userEvent.click(screen.getByRole("button", { name: /create key/i }));
}

/** The Kind cell as it reads, e.g. `CLI: …1234` or `MCP: agent.example`. */
function kindOf(row: HTMLElement) {
  return row.querySelectorAll("td")[1]!.textContent;
}

afterEach(() => vi.unstubAllGlobals());

describe("ManagementKeysPage", () => {
  it("lists existing keys with their metadata", async () => {
    stubKeys();
    renderAuthenticated(<ManagementKeysPage />);

    expect(await screen.findByText("CI deploy")).toBeTruthy();
    expect(screen.getByText("…6789")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
  });

  it("tells a CLI's key from a console key by its source and label", async () => {
    stubKeys(undefined, [
      EXISTING,
      {
        ...EXISTING,
        id: "key-2",
        name: "agw login",
        tokenHint: "1234",
        source: "cli",
        label: "CLI on mac-studio",
      },
      { ...EXISTING, id: "key-3", name: "agw init", tokenHint: "5678", source: "bootstrap" },
    ]);
    renderAuthenticated(<ManagementKeysPage />);

    const cliRow = (await screen.findByText("agw login")).closest("tr")!;
    expect(within(cliRow).getByText("CLI on mac-studio")).toBeTruthy();
    expect(kindOf(cliRow)).toBe("CLI: …1234");

    const consoleRow = screen.getByText("CI deploy").closest("tr")!;
    expect(kindOf(consoleRow)).toBe("API: …6789");

    const bootstrapRow = screen.getByText("agw init").closest("tr")!;
    expect(kindOf(bootstrapRow)).toBe("CLI: …5678");
  });

  it("lists OAuth connections beside the keys, by kind, client and domain", async () => {
    stubKeys(undefined, [
      EXISTING,
      CONNECTION,
      { ...CONNECTION, id: "connection-2", name: "Registered tool", label: "Registered tool", clientId: "test-client", grant: "manage" },
    ]);
    const { container } = renderAuthenticated(<ManagementKeysPage />);

    expect(await screen.findByRole("heading", { name: "Access" })).toBeTruthy();
    const keyRow = (await screen.findByText("CI deploy")).closest("tr")!;
    expect(kindOf(keyRow)).toBe("API: …6789");
    expect(within(keyRow).getByText("Never")).toBeTruthy();

    // The declared name is text, never markup, and its domain says who vouched for it;
    // a connection's token is replaced on every refresh, so it shows no hint.
    const connectionRow = screen.getByText(CONNECTION.name).closest("tr")!;
    expect(container.querySelector("img")).toBeNull();
    expect(kindOf(connectionRow)).toBe("MCP: agent.example");
    expect(within(connectionRow).getByText("Read only")).toBeTruthy();
    expect(within(connectionRow).queryByText("…zzzz")).toBeNull();
    expect(within(connectionRow).queryByText("Never")).toBeNull();

    const registeredRow = screen.getByText("Registered tool").closest("tr")!;
    expect(kindOf(registeredRow)).toBe("MCP");
  });

  it("revokes a connection with the same operation as a key", async () => {
    const fetchMock = stubKeys(undefined, [CONNECTION]);
    renderAuthenticated(<ManagementKeysPage />);

    const menu = await openRowActions(CONNECTION.name);
    await userEvent.click(within(menu).getByRole("menuitem", { name: /revoke connection/i }));
    expect(await screen.findByText(/has to be connected again/i)).toBeTruthy();
    await userEvent.click(await screen.findByRole("button", { name: /revoke connection/i }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).includes("/v1/admin/keys/connection-1/revoke")),
      ).toBe(true);
    });
  });

  it("names each key's grant", async () => {
    stubKeys(undefined, [
      EXISTING,
      { ...EXISTING, id: "key-2", name: "Dashboards", tokenHint: "1234", grant: "read" },
    ]);
    renderAuthenticated(<ManagementKeysPage />);

    const manageRow = (await screen.findByText("CI deploy")).closest("tr")!;
    expect(within(manageRow).getByText("Manage")).toBeTruthy();
    const readRow = screen.getByText("Dashboards").closest("tr")!;
    expect(within(readRow).getByText("Read only")).toBeTruthy();
  });

  it("does not call a key that has not been handed over active", async () => {
    stubKeys(undefined, [{ ...EXISTING, enabled: false }]);
    renderAuthenticated(<ManagementKeysPage />);

    await screen.findByText("CI deploy");
    expect(screen.getByText("Not yet active")).toBeTruthy();
    expect(screen.queryByText("Active")).toBeNull();
  });

  it("shows only the kind for keys created before hints were recorded", async () => {
    stubKeys(undefined, [{ ...EXISTING, tokenHint: null }]);
    renderAuthenticated(<ManagementKeysPage />);

    const row = (await screen.findByText("CI deploy")).closest("tr")!;
    expect(kindOf(row)).toBe("API");
  });

  it("names the key in a modal and sends it", async () => {
    const fetchMock = stubKeys();
    renderAuthenticated(<ManagementKeysPage />);

    await createKey("Automation");

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
      // Nothing chosen, so the key may do everything the role allows.
      expect(post && JSON.parse(String(post[1]?.body))).toEqual({ name: "Automation", grant: "manage" });
    });
  });

  it("offers the two grants, manage first and chosen, each explained", async () => {
    stubKeys();
    renderAuthenticated(<ManagementKeysPage />);

    await userEvent.click(await screen.findByRole("button", { name: /new key/i }));
    const group = await screen.findByRole("radiogroup", { name: /key grant/i });
    const [manage, read] = within(group).getAllByRole("radio");
    expect(manage!.textContent).toMatch(/^Manage.*everything your role allows/i);
    expect(manage!.getAttribute("aria-checked")).toBe("true");
    expect(read!.textContent).toMatch(/^Read only.*cannot change them/i);
    expect(read!.getAttribute("aria-checked")).toBe("false");
  });

  it("creates a read-only key when that grant is chosen, and says what it can do", async () => {
    const fetchMock = stubKeys({ key: { ...EXISTING, grant: "read", plaintext: PLAINTEXT } });
    renderAuthenticated(<ManagementKeysPage />);

    await userEvent.click(await screen.findByRole("button", { name: /new key/i }));
    await userEvent.type(await screen.findByLabelText(/key name/i), "Dashboards");
    await userEvent.click(screen.getByRole("radio", { name: /read only/i }));
    await userEvent.click(screen.getByRole("button", { name: /create key/i }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
      expect(post && JSON.parse(String(post[1]?.body))).toEqual({ name: "Dashboards", grant: "read" });
    });
    expect(await screen.findByText(/can read every app and provider here, but cannot change them/i)).toBeTruthy();
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
    const menu = await openRowActions("CI deploy");
    expect(
      within(menu).getByRole("menuitem", { name: /revoke key/i }).getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("lets an owner revoke a key after confirming", async () => {
    const fetchMock = stubKeys();
    renderAuthenticated(<ManagementKeysPage />);

    const menu = await openRowActions("CI deploy");
    await userEvent.click(within(menu).getByRole("menuitem", { name: /revoke key/i }));
    await userEvent.click(await screen.findByRole("button", { name: /revoke key/i }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).includes("/v1/admin/keys/key-1/revoke")),
      ).toBe(true);
    });
  });
});
