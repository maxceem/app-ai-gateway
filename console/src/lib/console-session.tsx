import { createContext, use, type ReactNode } from "react";
import { canManage as roleCanManage } from "./permissions";
import type {
  BillingAccess,
  Capabilities,
  OrganizationMembership,
  OrganizationRole,
  OrganizationQuota,
  OrganizationSummary,
  Session,
} from "./types";

/**
 * The authenticated console's ambient state.
 *
 * Role and capability checks are read from here rather than refetched per
 * component, so a single source decides what the UI offers. The server remains
 * authoritative: this only prevents pointless 401/402/403 round-trips.
 */
export interface ConsoleSessionValue {
  session: Session;
  capabilities: Capabilities;
  organization: OrganizationSummary | null;
  memberships: OrganizationMembership[];
  role: OrganizationRole;
  /** Owner or admin: may mutate gateway resources. */
  canManage: boolean;
  /** A member: every mutation control is disabled with an explanation. */
  readOnly: boolean;
  /** Present only when the deployment has billing enabled. */
  billing: BillingAccess | undefined;
  /**
   * The organization's month against its plan's request allowance. Read at the
   * shell level so the allowance can be warned about from any page, not only
   * from the billing one. `null` where there is no allowance to report.
   */
  quota: OrganizationQuota | null | undefined;
}

const ConsoleSessionContext = createContext<ConsoleSessionValue | null>(null);

export function ConsoleSessionProvider({
  session,
  capabilities,
  billing,
  quota,
  children,
}: {
  session: Session;
  capabilities: Capabilities;
  billing: BillingAccess | undefined;
  quota: OrganizationQuota | null | undefined;
  children: ReactNode;
}) {
  const canManage = roleCanManage(session.role);
  const value: ConsoleSessionValue = {
    session,
    capabilities,
    organization: session.organization,
    memberships: session.memberships,
    role: session.role,
    canManage,
    readOnly: !canManage,
    billing,
    quota,
  };

  return <ConsoleSessionContext value={value}>{children}</ConsoleSessionContext>;
}

export function useConsoleSession(): ConsoleSessionValue {
  const value = use(ConsoleSessionContext);
  if (!value) {
    throw new Error("useConsoleSession must be used inside the authenticated console shell");
  }
  return value;
}
