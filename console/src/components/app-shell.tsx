import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { AlertCircle, PanelLeft } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { SidebarContent } from "@/components/app-sidebar";
import { Brand } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-toggle";
import { useConsoleSession } from "@/lib/console-session";
import { billingNotice } from "@/lib/billing";

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

/**
 * Below `lg` the sidebar becomes a drawer, so the same header carries the
 * trigger, the logo, and the theme control the sidebar holds on wider screens.
 */
function MobileHeader() {
  const [open, setOpen] = useState(false);
  const location = useLocation();

  // A drawer left open across a navigation would cover the page it revealed.
  useEffect(() => setOpen(false), [location.pathname]);

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/80 px-3 backdrop-blur lg:hidden">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Open navigation">
            <PanelLeft className="size-4" />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-72 border-sidebar-border p-0" showCloseButton={false}>
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SidebarContent onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
      <Brand />
      <div className="ml-auto">
        <ThemeToggle />
      </div>
    </header>
  );
}

/**
 * Sidebar plus an inset content surface. The page sits on the sidebar tone and
 * the content floats above it, so the two regions read apart without a hard
 * divider running the height of the window.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-sidebar">
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-64 lg:block">
        <SidebarContent />
      </aside>

      <div className="flex min-h-dvh flex-col lg:pl-64">
        <MobileHeader />
        <main className="min-w-0 flex-1 bg-background lg:my-2 lg:mr-2 lg:rounded-xl lg:border lg:shadow-sm">
          <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
            <BillingBanner />
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
