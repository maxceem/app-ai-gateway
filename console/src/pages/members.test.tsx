import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { MembersPage } from "./members";
import { renderAuthenticated } from "@/test/render";

function member(overrides: Partial<{ id: string; email: string; role: string }> = {}) {
  return {
    id: "user-2",
    name: null,
    email: "grace@example.test",
    emailVerified: true,
    image: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    role: "member",
    status: "active",
    joinedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

const SELF_OWNER = member({ id: "user-1", email: "ada@example.test", role: "owner" });

function stubMembers(members: unknown[], mutation?: { status: number; body: unknown }) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method !== "GET" && mutation) {
      return new Response(JSON.stringify(mutation.body), { status: mutation.status });
    }
    if (method !== "GET") return new Response(JSON.stringify({ ok: true }), { status: 200 });
    return new Response(JSON.stringify({ members }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The table row for a member, so assertions do not collide across rows. */
async function rowFor(email: string) {
  const cell = await screen.findByText(email);
  return cell.closest("tr")!;
}

afterEach(() => vi.unstubAllGlobals());

describe("MembersPage access", () => {
  it("tells a read-only member the list is not theirs to see and does not fetch it", async () => {
    const fetchMock = stubMembers([]);
    renderAuthenticated(<MembersPage />, { session: { role: "member" } });

    expect(await screen.findByText(/read-only access/i)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    // The server would 403; asking anyway would only produce a console error.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("MembersPage last-owner protection", () => {
  it("blocks the sole owner from leaving and explains why", async () => {
    stubMembers([SELF_OWNER]);
    renderAuthenticated(<MembersPage />);

    const row = await rowFor("ada@example.test");
    expect(within(row).getByRole("button", { name: /^leave$/i })).toHaveProperty("disabled", true);
    // The guard wrapper carries the explanation as its accessible name.
    expect(within(row).getByRole("button", { name: /last owner/i })).toBeTruthy();
  });

  it("lets an owner leave once another owner exists", async () => {
    const fetchMock = stubMembers([SELF_OWNER, member({ id: "user-2", role: "owner" })]);
    renderAuthenticated(<MembersPage />);

    const row = await rowFor("ada@example.test");
    await userEvent.click(within(row).getByRole("button", { name: /^leave$/i }));

    expect(await screen.findByText(/you will lose access to/i)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /leave organization/i }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => init?.method === "DELETE");
      expect(call).toBeDefined();
      expect(String(call![0])).toContain("/v1/admin/members/user-1");
    });
  });

  it("surfaces the server's last-owner conflict when it wins the race", async () => {
    stubMembers([SELF_OWNER, member({ id: "user-2", role: "owner" })], {
      status: 409,
      body: { error: { code: "last_owner", message: "An organization must keep an owner" } },
    });
    const errorToast = vi.spyOn(toast, "error");
    renderAuthenticated(<MembersPage />);

    const row = await rowFor("ada@example.test");
    await userEvent.click(within(row).getByRole("button", { name: /^leave$/i }));
    await userEvent.click(screen.getByRole("button", { name: /leave organization/i }));

    // The client-side guard is advisory; the server is authoritative.
    await waitFor(() =>
      expect(errorToast).toHaveBeenCalledWith(expect.stringMatching(/must keep an owner/i)));
  });
});

describe("MembersPage role changes", () => {
  it("stops an admin granting the owner role", async () => {
    stubMembers([member({ id: "user-1", email: "ada@example.test", role: "admin" }), member()]);
    renderAuthenticated(<MembersPage />, { session: { role: "admin" } });

    const row = await rowFor("grace@example.test");
    await userEvent.click(within(row).getByRole("combobox"));

    expect(await screen.findByRole("option", { name: /owner/i }))
      .toHaveProperty("ariaDisabled", "true");
  });

  it("changes a role and reports it", async () => {
    const fetchMock = stubMembers([SELF_OWNER, member()]);
    renderAuthenticated(<MembersPage />);

    const row = await rowFor("grace@example.test");
    await userEvent.click(within(row).getByRole("combobox"));
    await userEvent.click(await screen.findByRole("option", { name: /admin/i }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
      expect(call).toBeDefined();
      expect(JSON.parse(String(call![1]!.body))).toEqual({ role: "admin" });
    });
  });
});
