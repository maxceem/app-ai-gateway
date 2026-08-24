import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppShell } from "@/components/app-shell";
import { AppDetailPage } from "@/pages/app-detail";
import { AppsPage } from "@/pages/apps";
import { BillingPage } from "@/pages/billing";
import { LoginPage } from "@/pages/login";
import { ManagementKeysPage } from "@/pages/management-keys";
import { MembersPage } from "@/pages/members";
import { ProfilePage } from "@/pages/profile";
import { SignupPage } from "@/pages/signup";
import { ConsoleSessionProvider } from "@/lib/console-session";
import { useBillingStatus, useCapabilities, useSession } from "@/lib/queries";

function FullPageSpinner() {
  return (
    <div className="flex h-dvh items-center justify-center">
      <Loader2 className="size-5 animate-spin text-muted-foreground" />
    </div>
  );
}

/**
 * The authenticated half of the console.
 *
 * Session and capabilities are resolved once here so every screen below can
 * read role and feature flags synchronously instead of guarding on loading
 * states of its own.
 */
function AuthenticatedConsole() {
  const capabilities = useCapabilities();
  const session = useSession();
  const location = useLocation();
  // Billing status feeds the global banner, so it is fetched at the shell level.
  const billing = useBillingStatus(Boolean(capabilities.data?.billing) && session.isSuccess);

  if (session.isPending || capabilities.isPending) return <FullPageSpinner />;

  if (session.isError || !session.data) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  if (!capabilities.data) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16">
        <Alert variant="destructive">
          <AlertTitle>Could not reach the gateway</AlertTitle>
          <AlertDescription>
            The console could not load deployment capabilities. Reload to try again.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <ConsoleSessionProvider
      session={session.data}
      capabilities={capabilities.data}
      billing={billing.data?.access}
    >
      <AppShell>
        <Routes>
          <Route path="/" element={<Navigate to="/apps" replace />} />
          <Route path="/apps" element={<AppsPage />} />
          <Route path="/apps/:appId" element={<Navigate to="overview" replace />} />
          <Route path="/apps/:appId/:tab" element={<AppDetailPage />} />
          <Route path="/keys" element={<ManagementKeysPage />} />
          <Route path="/members" element={<MembersPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          {capabilities.data.billing ? (
            <Route path="/billing" element={<BillingPage />} />
          ) : null}
          <Route path="*" element={<Navigate to="/apps" replace />} />
        </Routes>
      </AppShell>
    </ConsoleSessionProvider>
  );
}

/** Sends an already-signed-in operator away from the auth screens. */
function PublicOnly({ children }: { children: React.ReactNode }) {
  const session = useSession();
  if (session.isPending) return <FullPageSpinner />;
  if (session.isSuccess && session.data) return <Navigate to="/apps" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <TooltipProvider>
      <Routes>
        <Route
          path="/login"
          element={
            <PublicOnly>
              <LoginPage />
            </PublicOnly>
          }
        />
        <Route
          path="/signup"
          element={
            <PublicOnly>
              <SignupPage />
            </PublicOnly>
          }
        />
        <Route path="*" element={<AuthenticatedConsole />} />
      </Routes>
      <Toaster position="top-center" />
    </TooltipProvider>
  );
}
