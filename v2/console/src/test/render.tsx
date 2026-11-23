import { act, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Route, RouterProvider, Routes, useLocation } from "react-router-dom";
import { render } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConsoleSessionProvider } from "@/lib/console-session";
import type { AccountMembership, AccountRole, Capabilities, Session } from "@/lib/types";

export interface StubRoute {
  status?: number;
  body: unknown;
}

/**
 * Routes fetches by URL prefix so a test states only the responses it cares
 * about. Anything unmatched 404s loudly rather than silently resolving.
 */
export function stubApi(routes: Record<string, StubRoute>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const match = Object.keys(routes).find((key) => url.startsWith(key));
    if (!match) return new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 });
    const route = routes[match]!;
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

export const CAPABILITIES_URL = "/v2/console/capabilities";

export function capabilities(overrides: Partial<Capabilities> = {}): StubRoute {
  return { body: { billing: false, registrationOpen: true, googleAuth: false, oauth: true, ...overrides } };
}

/**
 * Waits until nothing is loading or saving, then lets React finish its
 * updates. A test that checks something did not happen calls this instead of
 * sleeping: once the client is idle and React has settled, anything that
 * was going to change already has.
 */
export async function settled(client: QueryClient): Promise<void> {
  await waitFor(() => expect(client.isFetching() + client.isMutating()).toBe(0));
  await act(async () => undefined);
}

export function testQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
}

export interface RouterProbe {
  location: { pathname: string; search: string; hash: string };
}

/** Mirrors the router's location out of the tree so assertions can read it. */
function LocationProbe({ probe }: { probe: RouterProbe }) {
  const location = useLocation();
  probe.location = {
    pathname: location.pathname,
    search: location.search,
    hash: location.hash,
  };
  return null;
}

/**
 * Renders a tree with routing and query context but no session.
 *
 * `path` mounts the tree behind a route pattern, for a screen that reads its
 * own `useParams`; without one the tree is rendered directly, which is what
 * every screen driven purely by its props needs.
 */
/**
 * The same kind of router the console runs on: a data router around a tree of
 * plain `<Routes>`. It is what `useBlocker` needs, and a screen that blocks a
 * navigation would throw under a plain `MemoryRouter`.
 */
const memoryRouter = (route: string, element: ReactNode, basename?: string) =>
  createMemoryRouter([{ path: "*", element }], { initialEntries: [route], ...(basename === undefined ? {} : { basename }) });

export function renderPublic(
  ui: ReactNode,
  { route = "/", path }: { route?: string; path?: string } = {},
) {
  const client = testQueryClient();
  const router: RouterProbe = { location: { pathname: route, search: "", hash: "" } };
  return {
    client,
    router,
    ...render(
      <QueryClientProvider client={client}>
        <RouterProvider
          router={memoryRouter(
            route,
            <>
              <TooltipProvider>
                {path === undefined ? ui : <Routes><Route path={path} element={ui} /></Routes>}
              </TooltipProvider>
              <LocationProbe probe={router} />
            </>,
          )}
        />
      </QueryClientProvider>,
    ),
  };
}

export function membership(id: string, name: string, role: AccountRole = "owner"): AccountMembership {
  return { id, name, role };
}

export function testSession(overrides: Partial<Session> = {}): Session {
  const role = overrides.role ?? "owner";
  return {
    user: { id: "user-1", name: "Ada Lovelace", email: "ada@example.test", emailVerified: true },
    account: { id: "acct-1", name: "Acme" },
    role,
    grant: "manage",
    credentialType: "session",
    accounts: [membership("acct-1", "Acme", role)],
    ...overrides,
  };
}

export const CAPABILITIES: Capabilities = {
  billing: false,
  registrationOpen: true,
  googleAuth: false,
  oauth: true,
};

/** Renders a tree inside an authenticated console session. */
export function renderAuthenticated(
  ui: ReactNode,
  options: {
    session?: Partial<Session>;
    capabilities?: Partial<Capabilities>;
    route?: string;
    /** Mounts the tree behind this route pattern only, for a screen that redirects away. */
    path?: string;
    /** The router's base, as production runs it (`/v2`); `route` then starts with it. */
    basename?: string;
  } = {},
) {
  const client = testQueryClient();
  const router: RouterProbe = {
    location: { pathname: options.route ?? "/", search: "", hash: "" },
  };
  return {
    client,
    router,
    ...render(
      <QueryClientProvider client={client}>
        <RouterProvider
          router={memoryRouter(
            options.route ?? "/",
            <>
              <LocationProbe probe={router} />
              <TooltipProvider>
                <ConsoleSessionProvider
                  session={testSession(options.session)}
                  capabilities={{ ...CAPABILITIES, ...options.capabilities }}
                >
                  {options.path === undefined ? ui : <Routes><Route path={options.path} element={ui} /></Routes>}
                </ConsoleSessionProvider>
              </TooltipProvider>
            </>,
            options.basename,
          )}
        />
      </QueryClientProvider>,
    ),
  };
}

/** The elements whose hint, the console's own tooltip, matches `pattern`. */
function allByHint(pattern: RegExp): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[aria-description]")]
    .filter((element) => pattern.test(element.getAttribute("aria-description") ?? ""));
}

/** The one element whose hint matches `pattern`; fails when there is not exactly one. */
export function getByHint(pattern: RegExp): HTMLElement {
  const found = allByHint(pattern);
  if (found.length !== 1) throw new Error(`Expected one element with a hint matching ${pattern}, found ${found.length}`);
  return found[0]!;
}

export function queryByHint(pattern: RegExp): HTMLElement | null {
  return allByHint(pattern)[0] ?? null;
}

/** {@link getByHint}, once the page has rendered it. */
export function findByHint(pattern: RegExp): Promise<HTMLElement> {
  return waitFor(() => getByHint(pattern));
}
