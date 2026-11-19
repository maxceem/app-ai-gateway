import { createContext, use, type ReactNode } from "react";
import { canManage as roleCanManage } from "./permissions";
import type { AccountMembership, AccountRole, Capabilities, Session } from "./types";

/**
 * The authenticated console's ambient state.
 *
 * Role and capability checks are read from here rather than refetched per
 * component, so a single source decides what the UI offers. The server remains
 * authoritative: this only prevents pointless 401 and 403 round-trips.
 */
export interface ConsoleSessionValue {
  session: Session;
  capabilities: Capabilities;
  /** The account the console acts in. */
  account: Session["account"];
  /** Every account the person may switch to. */
  accounts: AccountMembership[];
  role: AccountRole;
  /** Owner or admin: may change gateway resources. */
  canManage: boolean;
  /** A member: every change control is disabled with an explanation. */
  readOnly: boolean;
}

const ConsoleSessionContext = createContext<ConsoleSessionValue | null>(null);

export function ConsoleSessionProvider({
  session,
  capabilities,
  children,
}: {
  session: Session;
  capabilities: Capabilities;
  children: ReactNode;
}) {
  const canManage = roleCanManage(session.role);
  const value: ConsoleSessionValue = {
    session,
    capabilities,
    account: session.account,
    accounts: session.accounts,
    role: session.role,
    canManage,
    readOnly: !canManage,
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
