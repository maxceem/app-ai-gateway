import { Link, useLocation, useNavigate } from "react-router-dom";
import { ChevronsUpDown, Eye, KeyRound, LayoutGrid, LogOut, Plug, Settings, Tag } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AccountMenuItems } from "@/components/account-switcher";
import { Brand } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-toggle";
import { useConsoleSession } from "@/lib/console-session";
import { READ_ONLY_REASON } from "@/lib/permissions";
import { useSignOut } from "@/lib/queries";
import { cn } from "@/lib/utils";

interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutGrid;
  /** Lists the destination holds besides its own, revealed once inside it. */
  sections?: { to: string; label: string; icon: typeof LayoutGrid }[];
}

/**
 * The console's places to be. Account administration lives in the user menu
 * at the foot of the sidebar rather than competing with them here.
 */
const NAV_ITEMS: NavItem[] = [
  { to: "/apps", label: "Apps", icon: LayoutGrid },
  { to: "/providers", label: "Providers", icon: Plug },
  { to: "/prices", label: "Prices", icon: Tag },
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
 * The account block. Names the operator and nothing else; opening it reveals
 * the settings and access screens, the accounts they can act in, and
 * sign-out.
 */
function UserMenu({ onNavigate }: { onNavigate?: () => void }) {
  const navigate = useNavigate();
  const { session } = useConsoleSession();
  const signOut = useSignOut();

  const logout = async () => {
    await signOut.mutateAsync().catch(() => undefined);
    await navigate("/login", { replace: true });
  };

  const email = session.user.email ?? "Operator";
  const name = session.user.name?.trim() || email;

  return (
    <>
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
            {initialsFor(session.user.name, email)}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="start"
          sideOffset={8}
          className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
        >
          <DropdownMenuItem asChild>
            <Link to="/settings" onClick={onNavigate}>
              <Settings className="size-4" />
              Settings
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to="/access" onClick={onNavigate}>
              <KeyRound className="size-4" />
              Access
            </Link>
          </DropdownMenuItem>
          <AccountMenuItems />
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={signOut.isPending} onSelect={() => void logout()}>
            <LogOut className="size-4" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

/** A row of the rail, whether it names a destination or a section of one. */
function RailLink({
  to,
  label,
  icon: Icon,
  current,
  onNavigate,
  className,
}: {
  to: string;
  label: string;
  icon?: typeof LayoutGrid;
  current: boolean;
  onNavigate?: () => void;
  className?: string;
}) {
  return (
    <Link
      to={to}
      onClick={onNavigate}
      aria-current={current ? "page" : undefined}
      className={cn(
        "flex h-10 items-center gap-2.5 rounded-lg px-3 text-sm font-medium transition-colors",
        "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        current
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
        className,
      )}
    >
      {Icon ? <Icon className="size-4 shrink-0" /> : null}
      <span className="truncate">{label}</span>
    </Link>
  );
}

/** The console's own destinations, shown whenever no record has the rail. */
function RootNav({ onNavigate }: { onNavigate?: () => void }) {
  const location = useLocation();

  return (
    <nav className="flex flex-col gap-1 p-3">
      {NAV_ITEMS.map((item) => {
        const active = location.pathname.startsWith(item.to);
        const sections = active ? item.sections : undefined;
        // The destination holds its own list, so it is the current page
        // whenever none of the sections under it is.
        const current = active && !sections?.some((entry) => entry.to === location.pathname);
        return (
          <div key={item.to} className="flex flex-col gap-1">
            <RailLink
              to={item.to}
              label={item.label}
              icon={item.icon}
              current={current}
              onNavigate={onNavigate}
            />

            {sections ? (
              // Nothing draws the nesting: a section's mark starts where its
              // destination's label does, which says it belongs to it without
              // a rule down the side of the rail. The pills stay one column
              // wide. (px-3 + a size-4 mark + gap-2.5 is the 9.5 below.)
              <div className="flex flex-col gap-1">
                {sections.map((section) => (
                  <RailLink
                    key={section.to}
                    to={section.to}
                    label={section.label}
                    icon={section.icon}
                    current={location.pathname === section.to}
                    onNavigate={onNavigate}
                    className="h-9 pr-3 pl-9.5"
                  />
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </nav>
  );
}

/**
 * Sidebar body, shared by the fixed desktop rail and the mobile drawer.
 * `onNavigate` lets the drawer close itself once a destination is chosen.
 */
export function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { readOnly } = useConsoleSession();

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-14 items-center justify-between gap-2 px-3">
        <Brand className="px-1" onClick={onNavigate} />
        <ThemeToggle />
      </div>

      {/* The one region that scrolls, so the account block stays put. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <RootNav onNavigate={onNavigate} />
      </div>

      <div className="flex flex-col gap-1 border-t border-sidebar-border p-3">
        {readOnly ? (
          <div className="px-1 pb-1.5">
            <ReadOnlyBadge />
          </div>
        ) : null}
        <UserMenu onNavigate={onNavigate} />
      </div>
    </div>
  );
}
