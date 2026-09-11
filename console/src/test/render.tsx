import type { ReactNode } from "react";
import { vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { render } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConsoleSessionProvider } from "@/lib/console-session";
import type {
  BillingAccess,
  Capabilities,
  OrganizationMembership,
  OrganizationQuota,
  OrganizationRole,
  Session,
} from "@/lib/types";

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

export const CAPABILITIES_URL = "/v1/console/capabilities";

export function capabilities(overrides: Partial<Capabilities> = {}): StubRoute {
  return { body: { billing: false, registrationOpen: true, googleAuth: false, ...overrides } };
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
  location: { pathname: string; search: string };
}

/** Mirrors the router's location out of the tree so assertions can read it. */
function LocationProbe({ probe }: { probe: RouterProbe }) {
  const location = useLocation();
  probe.location = { pathname: location.pathname, search: location.search };
  return null;
}

/** Renders a tree with routing and query context but no session. */
export function renderPublic(ui: ReactNode, { route = "/" }: { route?: string } = {}) {
  const client = testQueryClient();
  const router: RouterProbe = { location: { pathname: route, search: "" } };
  return {
    client,
    router,
    ...render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[route]}>
          <TooltipProvider>{ui}</TooltipProvider>
          <LocationProbe probe={router} />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

export function membership(
  id: string,
  name: string,
  role: OrganizationRole = "owner",
): OrganizationMembership {
  return {
    organization: { id, name, createdAt: "2026-01-01T00:00:00.000Z" },
    role,
    status: "active",
    joinedAt: "2026-01-01T00:00:00.000Z",
  };
}

export function testSession(overrides: Partial<Session> = {}): Session {
  const role = overrides.role ?? "owner";
  return {
    user: {
      id: "user-1",
      name: "Ada Lovelace",
      email: "ada@example.test",
      emailVerified: true,
      image: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    organization: { id: "org-1", name: "Acme", createdAt: "2026-01-01T00:00:00.000Z" },
    role,
    memberships: [membership("org-1", "Acme", role)],
    credentialType: "session",
    ...overrides,
  };
}

export const CAPABILITIES: Capabilities = {
  billing: false,
  registrationOpen: true,
  googleAuth: false,
};

/** Renders a tree inside an authenticated console session. */
export function renderAuthenticated(
  ui: ReactNode,
  options: {
    session?: Partial<Session>;
    capabilities?: Partial<Capabilities>;
    billing?: BillingAccess;
    quota?: OrganizationQuota | null;
    route?: string;
  } = {},
) {
  const client = testQueryClient();
  const router: RouterProbe = { location: { pathname: options.route ?? "/", search: "" } };
  return {
    client,
    router,
    ...render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[options.route ?? "/"]}>
          <LocationProbe probe={router} />
          <TooltipProvider>
            <ConsoleSessionProvider
              session={testSession(options.session)}
              capabilities={{ ...CAPABILITIES, ...options.capabilities }}
              billing={options.billing}
              quota={options.quota}
            >
              {ui}
            </ConsoleSessionProvider>
          </TooltipProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}
