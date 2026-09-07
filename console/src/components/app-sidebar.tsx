import { Link, useLocation, useMatch, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  ChevronsUpDown,
  CreditCard,
  Eye,
  KeyRound,
  LayoutGrid,
  LogOut,
  Settings,
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
import { OrganizationMenuItems } from "@/components/org-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import { APP_SECTIONS } from "@/lib/app-sections";
import { useConsoleSession } from "@/lib/console-session";
import { READ_ONLY_REASON } from "@/lib/permissions";
import { useApp, useSignOut } from "@/lib/queries";
import { cn } from "@/lib/utils";

interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutGrid;
  /** Lists the destination holds besides its own, revealed once inside it. */
  sections?: { to: string; label: string }[];
}

/**
 * The console has exactly two places to be. Everything else is account or
 * organization administration, which lives in the user menu at the foot of the
 * sidebar rather than competing with them here.
 *
 * Gateways hang under Providers rather than beside it: most deployments never
 * add one, and it is the providers list they support. The destination keeps its
 * own list, so only the gateways need a row of their own.
 */
const NAV_ITEMS: NavItem[] = [
  { to: "/apps", label: "Apps", icon: LayoutGrid },
  {
    to: "/providers",
    label: "Providers",
    icon: Waypoints,
    sections: [{ to: "/providers/gateways", label: "Gateways" }],
  },
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
 * the account-scoped and organization-scoped screens, the organizations they
 * can act as, and sign-out.
 */
function UserMenu({ onNavigate }: { onNavigate?: () => void }) {
  const navigate = useNavigate();
  const { session, capabilities } = useConsoleSession();
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
          <Link to="/settings" onClick={onNavigate}>
            <Settings className="size-4" />
            Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/keys" onClick={onNavigate}>
            <KeyRound className="size-4" />
            Management keys
          </Link>
        </DropdownMenuItem>
        {capabilities.billing ? (
          <DropdownMenuItem asChild>
            <Link to="/billing" onClick={onNavigate}>
              <CreditCard className="size-4" />
              Billing
            </Link>
          </DropdownMenuItem>
        ) : null}
        <OrganizationMenuItems />
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={signOut.isPending} onSelect={() => void logout()}>
          <LogOut className="size-4" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
    <nav className="flex flex-1 flex-col gap-1 p-3">
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
              // Nothing draws the nesting: a section's label sits in from its
              // destination's, which says it belongs to it without a rule
              // down the side of the rail. The pills stay one column wide.
              <div className="flex flex-col gap-1">
                {sections.map((section) => (
                  <RailLink
                    key={section.to}
                    to={section.to}
                    label={section.label}
                    current={location.pathname === section.to}
                    onNavigate={onNavigate}
                    className="h-9 pr-3 pl-12.5"
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
 * The rail one record takes over while it is open: the way back out, the
 * record it belongs to, then that record's sections.
 *
 * The way out is the first row under the brand and never moves, so a second
 * kind of record — a provider, a gateway — can be given the same treatment
 * without the operator having to look for it somewhere new. `title` names the
 * record so the rail always says which one the sections belong to.
 */
function DrillInRail({
  back,
  title,
  subtitle,
  items,
  onNavigate,
}: {
  back: { to: string; label: string };
  title: string;
  subtitle?: string;
  items: { to: string; label: string; icon?: typeof LayoutGrid }[];
  onNavigate?: () => void;
}) {
  const location = useLocation();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-2 border-b border-sidebar-border px-3 pb-3">
        <Link
          to={back.to}
          onClick={onNavigate}
          className={cn(
            "flex h-8 w-fit items-center gap-1.5 rounded-lg px-2 text-sm text-muted-foreground transition-colors",
            "hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
            "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
          )}
        >
          <ArrowLeft className="size-3.5 shrink-0" />
          {back.label}
        </Link>

        <div className="min-w-0 px-2">
          <p className="truncate text-sm font-semibold">{title}</p>
          {subtitle ? (
            <p className="truncate font-mono text-xs text-muted-foreground">{subtitle}</p>
          ) : null}
        </div>
      </div>

      <nav
        aria-label={`${title} sections`}
        className="flex flex-1 flex-col gap-1 overflow-y-auto p-3"
      >
        {items.map((item) => (
          <RailLink
            key={item.to}
            to={item.to}
            label={item.label}
            icon={item.icon}
            current={location.pathname === item.to}
            onNavigate={onNavigate}
          />
        ))}
      </nav>
    </div>
  );
}

/**
 * The rail for one app. The name is read from the same query the detail page
 * uses, so opening an app costs no extra request; until it resolves the id
 * stands in, which is what the URL already says.
 */
function AppRail({ appId, onNavigate }: { appId: string; onNavigate?: () => void }) {
  const app = useApp(appId);

  return (
    <DrillInRail
      back={{ to: "/apps", label: "Apps" }}
      title={app.data?.app.name ?? appId}
      subtitle={appId}
      items={APP_SECTIONS.map((section) => ({
        to: `/apps/${appId}/${section.slug}`,
        label: section.label,
        icon: section.icon,
      }))}
      onNavigate={onNavigate}
    />
  );
}

/**
 * Sidebar body, shared by the fixed desktop rail and the mobile drawer.
 * `onNavigate` lets the drawer close itself once a destination is chosen.
 *
 * Opening a single app hands the rail to that app rather than nesting its
 * sections under Apps: they are sections of one record, and a list of every
 * app with one of them expanded would say less about where the operator is.
 */
export function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { readOnly } = useConsoleSession();
  const appMatch = useMatch("/apps/:appId/*");

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-14 items-center justify-between gap-2 px-3">
        <Brand className="px-1" onClick={onNavigate} />
        <ThemeToggle />
      </div>

      {appMatch?.params.appId ? (
        <AppRail appId={appMatch.params.appId} onNavigate={onNavigate} />
      ) : (
        <RootNav onNavigate={onNavigate} />
      )}

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
