import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { render } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConsoleSessionProvider } from "@/lib/console-session";
import type {
  BillingAccess,
  Capabilities,
  OrganizationMembership,
  OrganizationRole,
  Session,
} from "@/lib/types";

export function testQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
}

/** Renders a tree with routing and query context but no session. */
export function renderPublic(ui: ReactNode, { route = "/" }: { route?: string } = {}) {
  const client = testQueryClient();
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[route]}>
          <TooltipProvider>{ui}</TooltipProvider>
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
    route?: string;
  } = {},
) {
  const client = testQueryClient();
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[options.route ?? "/"]}>
          <TooltipProvider>
            <ConsoleSessionProvider
              session={testSession(options.session)}
              capabilities={{ ...CAPABILITIES, ...options.capabilities }}
              billing={options.billing}
            >
              {ui}
            </ConsoleSessionProvider>
          </TooltipProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}
