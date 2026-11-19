import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppShell } from "@/components/app-shell";
import { AccessPage } from "@/pages/access";
import { AppDetailPage, DEFAULT_APP_TAB } from "@/pages/app-detail";
import { AppsPage } from "@/pages/apps";
import { PricesPage } from "@/pages/prices";
import { ProvidersPage } from "@/pages/providers";
import { DevicePage } from "@/pages/device";
import { LoginPage } from "@/pages/login";
import { OAuthConsentPage } from "@/pages/oauth-consent";
import { DEFAULT_SETTINGS_SECTION, SettingsPage } from "@/pages/settings";
import { SignupPage } from "@/pages/signup";
import { ConsoleSessionProvider } from "@/lib/console-session";
import { DEFAULT_LANDING, loginUrlFor, postAuthPath } from "@/lib/auth-redirect";
import { useCapabilities, useSession } from "@/lib/queries";

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
    <ConsoleSessionProvider session={session.data} capabilities={capabilities.data}>
      <AppShell>
        <Routes>
          <Route path="/" element={<Navigate to={DEFAULT_LANDING} replace />} />
          <Route path="/apps" element={<AppsPage />} />
          <Route path="/apps/:appId" element={<Navigate to={DEFAULT_APP_TAB} replace />} />
          <Route path="/apps/:appId/:tab" element={<AppDetailPage />} />
          <Route path="/providers" element={<ProvidersPage />} />
          <Route path="/prices" element={<PricesPage />} />
          <Route path="/access" element={<AccessPage />} />
          <Route
            path="/settings"
            element={<Navigate to={`/settings/${DEFAULT_SETTINGS_SECTION}`} replace />}
          />
          <Route path="/settings/:section" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to={DEFAULT_LANDING} replace />} />
        </Routes>
      </AppShell>
    </ConsoleSessionProvider>
  );
}

/** Sends an already-signed-in operator away from the auth screens, to where they were headed. */
function PublicOnly({ children }: { children: React.ReactNode }) {
  const session = useSession();
  const location = useLocation();
  if (session.isPending) return <FullPageSpinner />;
  if (session.isSuccess && session.data) {
    return <Navigate to={postAuthPath(location.search)} replace />;
  }
  return <>{children}</>;
}

/**
 * Every route is below the console's `/v2` base (the router's `basename`),
 * so `/login` here is `/v2/login` in the address bar.
 */
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
        {/*
          Where an OAuth client's authorization request sends a person.
          Outside the shell: it starts with nobody signed in as often as not,
          and signing in brings them back.
        */}
        <Route path="/oauth/consent" element={<OAuthConsentPage />} />
        {/* Where a person types the code a CLI without a browser shows. Outside the shell for the same reason. */}
        <Route path="/device" element={<DevicePage />} />
        <Route path="*" element={<AuthenticatedConsole />} />
      </Routes>
      <Toaster position="top-center" />
    </TooltipProvider>
  );
}
