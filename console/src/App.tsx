import { useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppShell } from "@/components/app-shell";
import { AppDetailPage } from "@/pages/app-detail";
import { AppsPage } from "@/pages/apps";
import { BillingPage } from "@/pages/billing";
import { CheckoutPage } from "@/pages/checkout";
import { LoginPage } from "@/pages/login";
import { ManagementKeysPage } from "@/pages/management-keys";
import { ProvidersPage } from "@/pages/providers";
import { DEFAULT_SETTINGS_SECTION, SettingsPage } from "@/pages/settings";
import { SignupPage } from "@/pages/signup";
import { ConsoleSessionProvider } from "@/lib/console-session";
import { analytics, captureSignup, useAnalyticsPageviews } from "@/lib/analytics";
import { DEFAULT_LANDING, loginUrlFor, postAuthPath } from "@/lib/auth-redirect";
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

  const userId = session.data?.user?.id;
  const createdAt = session.data?.user?.createdAt;
  const organizationId = session.data?.organization?.id ?? null;
  const role = session.data?.role;
  const plan = billing.data?.access.state === "billed"
    ? billing.data.access.plan?.planKey ?? null
    : null;

  /*
   * The single place the console names who is using it.
   *
   * Every authenticated route renders through here, so identifying here rather
   * than on the screens that cause it means no path can be signed in and
   * unreported. It is also what joins this account to whatever the same browser
   * did on the marketing site beforehand: the visitor identity is held on the
   * shared parent domain, so identifying it here attributes that earlier visit —
   * and its campaign — to this account.
   */
  useEffect(() => {
    if (!userId || !createdAt || !role) return;
    analytics.identify(userId, role, createdAt);
    captureSignup(userId, createdAt);
  }, [userId, createdAt, role]);

  useEffect(() => {
    if (!organizationId) return;
    analytics.group(organizationId, plan === null ? undefined : { plan });
  }, [organizationId, plan]);

  if (session.isPending || capabilities.isPending) return <FullPageSpinner />;

  if (session.isError || !session.data) {
    // Same query-string contract the global 401 handler uses, so both paths
    // return the operator to where they were headed.
    return <Navigate to={loginUrlFor(`${location.pathname}${location.search}`)} replace />;
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
      quota={billing.data?.quota}
    >
      <AppShell>
        <Routes>
          <Route path="/" element={<Navigate to={DEFAULT_LANDING} replace />} />
          <Route path="/apps" element={<AppsPage />} />
          <Route path="/apps/:appId" element={<Navigate to="overview" replace />} />
          <Route path="/apps/:appId/:tab" element={<AppDetailPage />} />
          <Route path="/apps/:appId/:tab/:section" element={<AppDetailPage />} />
          <Route path="/providers" element={<ProvidersPage />} />
          <Route path="/providers/:section" element={<ProvidersPage />} />
          <Route path="/keys" element={<ManagementKeysPage />} />
          <Route
            path="/settings"
            element={<Navigate to={`/settings/${DEFAULT_SETTINGS_SECTION}`} replace />}
          />
          <Route path="/settings/:section" element={<SettingsPage />} />
          {capabilities.data.billing ? (
            <Route path="/billing" element={<BillingPage />} />
          ) : null}
          {/*
            Registered whatever the deployment sells, unlike /billing above:
            the marketing site links here, and a self-hosted console answering
            an inbound ?plan= link with its catch-all would look like the link
            was broken. The page states the refusal by redirecting instead.
          */}
          <Route path="/checkout" element={<CheckoutPage />} />
          <Route path="*" element={<Navigate to={DEFAULT_LANDING} replace />} />
        </Routes>
      </AppShell>
    </ConsoleSessionProvider>
  );
}

/**
 * Sends an already-signed-in operator away from the auth screens.
 *
 * To the plan they came for when the link carried one: someone pressing a price
 * on the marketing site lands on `/signup?plan=growth` whether or not they
 * already have an account, and dropping them on the apps page would answer a
 * request to buy with silence.
 */
function PublicOnly({ children }: { children: React.ReactNode }) {
  const session = useSession();
  const location = useLocation();
  if (session.isPending) return <FullPageSpinner />;
  if (session.isSuccess && session.data) {
    return <Navigate to={postAuthPath(location.search)} replace />;
  }
  return <>{children}</>;
}

export default function App() {
  useAnalyticsPageviews();

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
