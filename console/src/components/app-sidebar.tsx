import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  ChevronsUpDown,
  CreditCard,
  Eye,
  KeyRound,
  LayoutGrid,
  LogOut,
  User,
  Users,
  Waypoints,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Brand } from "@/components/brand";
import { OrganizationSwitcher } from "@/components/org-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import { useConsoleSession } from "@/lib/console-session";
import { READ_ONLY_REASON } from "@/lib/permissions";
import { useSignOut } from "@/lib/queries";
import { cn } from "@/lib/utils";

interface NavItem {
  to: string;
  label: string;
  icon: typeof Users;
}

/**
 * The console has exactly two places to be. Everything else is account or
 * organization administration, which lives in the user menu at the foot of the
 * sidebar rather than competing with them here.
 */
const NAV_ITEMS: NavItem[] = [
  { to: "/apps", label: "Apps", icon: LayoutGrid },
  { to: "/providers", label: "Providers", icon: Waypoints },
];

/** Read-only members see why the console looks restricted, once, above their account. */
function ReadOnlyBadge() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="secondary" className="w-full justify-start gap-1.5 py-1">
          <Eye className="size-3" />
          Read-only
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="top">{READ_ONLY_REASON}</TooltipContent>
    </Tooltip>
  );
}

/** Two letters from the operator's name, or their email as a fallback. */
function initialsFor(name: string | null | undefined, email: string): string {
  const source = name?.trim() || email;
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0]![0]}${parts[1]![0]}` : source.slice(0, 2);
  return letters.toUpperCase();
}

/**
 * The account block. Shows who is signed in; opening it reveals the
 * account-scoped and organization-scoped screens plus sign-out.
 */
function UserMenu({ onNavigate }: { onNavigate?: () => void }) {
  const navigate = useNavigate();
  const { session, capabilities, canManage } = useConsoleSession();
  const signOut = useSignOut();

  const logout = async () => {
    await signOut.mutateAsync().catch(() => undefined);
    await navigate("/login", { replace: true });
  };

  const email = session.user?.email ?? "Operator";
  const name = session.user?.name?.trim() || email;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors",
          "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          "data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground",
          "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        )}
      >
        <span
          aria-hidden
          className="grid size-8 shrink-0 place-items-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground"
        >
          {initialsFor(session.user?.name, email)}
        </span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-sm font-medium">{name}</span>
          <span className="block truncate text-xs text-muted-foreground">{email}</span>
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
      >
        <DropdownMenuItem asChild>
          <Link to="/profile" onClick={onNavigate}>
            <User className="size-4" />
            Profile
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/keys" onClick={onNavigate}>
            <KeyRound className="size-4" />
            Management keys
          </Link>
        </DropdownMenuItem>
        {/* Listing members is owner/admin-only on the server. */}
        {canManage ? (
          <DropdownMenuItem asChild>
            <Link to="/members" onClick={onNavigate}>
              <Users className="size-4" />
              Members
            </Link>
          </DropdownMenuItem>
        ) : null}
        {capabilities.billing ? (
          <DropdownMenuItem asChild>
            <Link to="/billing" onClick={onNavigate}>
              <CreditCard className="size-4" />
              Billing
            </Link>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={signOut.isPending} onSelect={() => void logout()}>
          <LogOut className="size-4" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Sidebar body, shared by the fixed desktop rail and the mobile drawer.
 * `onNavigate` lets the drawer close itself once a destination is chosen.
 */
export function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const location = useLocation();
  const { readOnly } = useConsoleSession();

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-14 items-center justify-between gap-2 px-3">
        <Brand className="px-1" onClick={onNavigate} />
        <ThemeToggle />
      </div>

      <nav className="flex flex-1 flex-col gap-1 p-3">
        {NAV_ITEMS.map((item) => {
          const active = location.pathname.startsWith(item.to);
          return (
            <Link
              key={item.to}
              to={item.to}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex h-10 items-center gap-2.5 rounded-lg px-3 text-sm font-medium transition-colors",
                "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
              )}
            >
              <item.icon className="size-4 shrink-0" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="flex flex-col gap-1 border-t border-sidebar-border p-3">
        {readOnly ? (
          <div className="px-1 pb-1.5">
            <ReadOnlyBadge />
          </div>
        ) : null}
        <OrganizationSwitcher />
        <UserMenu onNavigate={onNavigate} />
      </div>
    </div>
  );
}
