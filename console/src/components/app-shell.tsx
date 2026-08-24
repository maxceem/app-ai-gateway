import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useTheme } from "next-themes";
import {
  AlertCircle,
  CreditCard,
  Eye,
  KeyRound,
  LogOut,
  Monitor,
  Moon,
  Sun,
  User,
  Users,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { OrganizationSwitcher } from "@/components/org-switcher";
import { useConsoleSession } from "@/lib/console-session";
import { billingNotice } from "@/lib/billing";
import { READ_ONLY_REASON, ROLE_LABELS } from "@/lib/permissions";
import { useSignOut } from "@/lib/queries";
import { cn } from "@/lib/utils";

const THEMES = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const;

function ThemePicker() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  // useTheme reports nothing until the provider mounts; the inline script in
  // index.html has already applied the class, so only the icon needs the guard.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const Icon = theme === "system" ? Monitor : resolvedTheme === "light" ? Sun : Moon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Theme">
          {mounted ? <Icon className="size-4" /> : <span className="size-4" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36">
        <DropdownMenuRadioGroup value={theme ?? "system"} onValueChange={setTheme}>
          {THEMES.map((entry) => (
            <DropdownMenuRadioItem key={entry.value} value={entry.value}>
              <entry.icon className="size-4" />
              {entry.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Read-only members see why the console looks restricted, once, in the header. */
function ReadOnlyBadge() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="secondary" className="gap-1">
          <Eye className="size-3" />
          Read-only
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{READ_ONLY_REASON}</TooltipContent>
    </Tooltip>
  );
}

function UserMenu() {
  const navigate = useNavigate();
  const { session, role } = useConsoleSession();
  const signOut = useSignOut();

  const logout = async () => {
    await signOut.mutateAsync().catch(() => undefined);
    await navigate("/login", { replace: true });
  };

  const email = session.user?.email ?? "Operator";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Account">
          <User className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="flex flex-col gap-1">
          <span className="truncate font-medium">{email}</span>
          <span className="text-xs font-normal text-muted-foreground">{ROLE_LABELS[role]}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/profile">
            <User className="size-4" />
            Profile
          </Link>
        </DropdownMenuItem>
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
 * Warns about billing state above every page so an inactive subscription is
 * visible wherever the operator happens to be. Never rendered when billing is
 * off, keeping self-hosted deployments free of billing traces.
 */
function BillingBanner() {
  const { capabilities, billing } = useConsoleSession();
  const notice = capabilities.billing ? billingNotice(billing) : null;
  if (!notice) return null;

  return (
    <Alert
      variant={notice.tone === "destructive" ? "destructive" : "default"}
      className="mb-4"
    >
      <AlertCircle />
      <AlertTitle>{notice.title}</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center gap-3">
        <span>{notice.description}</span>
        {notice.actionable ? (
          <Button asChild size="sm" variant="outline">
            <Link to="/billing">View plans</Link>
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

interface NavItem {
  to: string;
  label: string;
  icon?: typeof Users;
}

export function AppShell({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { capabilities, canManage, readOnly } = useConsoleSession();

  const items: NavItem[] = [
    { to: "/apps", label: "Apps" },
    { to: "/keys", label: "Management keys", icon: KeyRound },
    // Listing members is owner/admin-only on the server.
    ...(canManage ? [{ to: "/members", label: "Members", icon: Users }] : []),
    ...(capabilities.billing ? [{ to: "/billing", label: "Billing", icon: CreditCard }] : []),
  ];

  return (
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 sm:px-6">
          {/* "App [AI] Gateway" — the mark sits inline between the words, so the
              gap is word spacing rather than the wider mark-beside-text gap. */}
          <Link to="/apps" className="flex items-center gap-1.5 font-semibold tracking-tight">
            <span>App</span>
            <span className="grid size-6 place-items-center rounded bg-primary text-[11px] font-bold text-primary-foreground">
              AI
            </span>
            <span>Gateway</span>
          </Link>
          <OrganizationSwitcher />
          <nav className="ml-2 hidden items-center gap-1 sm:flex">
            {items.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground",
                  location.pathname.startsWith(item.to) && "bg-accent text-foreground",
                )}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            {readOnly ? <ReadOnlyBadge /> : null}
            <ThemePicker />
            <UserMenu />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        <BillingBanner />
        {children}
      </main>
    </div>
  );
}
