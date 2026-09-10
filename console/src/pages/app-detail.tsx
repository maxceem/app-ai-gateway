import { lazy, Suspense, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { AlertCircle, Loader2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { GuardedButton } from "@/components/guarded-button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/field";
import { MissingProvidersAlert } from "@/components/missing-providers-alert";
import { MonthPicker } from "@/components/pickers";
import { useAppDraft } from "@/hooks/use-app-draft";
import { APP_SECTIONS } from "@/lib/app-sections";
import { draftProblem } from "@/lib/draft-problems";
import { currentMonth } from "@/lib/format";
import { AuthEventsTab } from "@/pages/tabs/auth-events";
import { AuthPolicyTab } from "@/pages/tabs/auth-policy";
import { LimitsTab } from "@/pages/tabs/limits";
import { OverviewTab } from "@/pages/tabs/overview";
import { ProxyPolicyTab } from "@/pages/tabs/proxy-policy";
import { SettingsTab } from "@/pages/tabs/settings";
import { UsersTab } from "@/pages/tabs/users";

// Charts and the code editor are each larger than the rest of the console; they
// load only when their tab is opened.
const UsageTab = lazy(() => import("@/pages/tabs/usage").then((module) => ({ default: module.UsageTab })));
const EndpointsTab = lazy(() =>
  import("@/pages/tabs/endpoints").then((module) => ({ default: module.EndpointsTab })),
);

/**
 * One app. The sidebar names it and lists its sections; the content is headed
 * by the section it is showing, in the sidebar's own words, so the page always
 * says which of them is open. Turning the app off and deleting it live on the
 * Settings section rather than in a menu up here: they are decisions about the
 * record, made rarely, and a menu that follows every section says otherwise.
 */
export function AppDetailPage() {
  const { appId = "", tab = "overview", section } = useParams();
  const state = useAppDraft(appId);
  // The month belongs to the page, because the control that picks it sits in
  // the page header beside the section's name.
  const [month, setMonth] = useState(currentMonth());
  const heading = APP_SECTIONS.find((entry) => entry.slug === tab);

  const { query, draft, dirty } = state;
  // What would make the Worker refuse the draft, said on the button instead.
  const problem = draft ? draftProblem(draft) : null;

  if (query.isError) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>Could not load this app</AlertTitle>
        <AlertDescription>
          {query.error instanceof Error ? query.error.message : "Unknown error"}
          <Link to="/apps" className="underline underline-offset-4">
            Back to apps
          </Link>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6 pb-24">
      <PageHeader
        title={heading?.label ?? "Overview"}
        action={
          tab === "overview" ? <MonthPicker value={month} onChange={setMonth} /> : undefined
        }
      />

      {query.data?.config_error ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>The stored configuration is invalid</AlertTitle>
          <AlertDescription>
            {query.data.config_error}. The gateway rejects requests for this app until it is fixed.
          </AlertDescription>
        </Alert>
      ) : null}

      {draft ? <MissingProvidersAlert proxy={draft.config.routing} /> : null}

      {query.isPending || !draft ? (
        <div className="space-y-3">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : tab === "overview" ? (
        <OverviewTab appId={appId} month={month} state={state} />
      ) : tab === "auth" ? (
        <AuthPolicyTab appId={appId} level={section} state={state} />
      ) : tab === "proxy" ? (
        <ProxyPolicyTab state={state} />
      ) : tab === "limits" ? (
        <LimitsTab state={state} />
      ) : tab === "users" ? (
        <UsersTab appId={appId} />
      ) : tab === "auth-events" ? (
        <AuthEventsTab appId={appId} />
      ) : tab === "settings" ? (
        <SettingsTab appId={appId} state={state} />
      ) : (
        <Suspense fallback={<Skeleton className="h-64 w-full" />}>
          {tab === "usage" ? (
            <UsageTab appId={appId} />
          ) : (
            <EndpointsTab appId={appId} state={state} />
          )}
        </Suspense>
      )}

      {dirty ? (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 backdrop-blur">
          <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:px-6">
            <span className="text-sm">
              <span className="mr-2 inline-block size-2 rounded-full bg-amber-500 align-middle" />
              Unsaved changes to <span className="font-medium">{draft?.name ?? appId}</span>
            </span>
            <div className="ml-auto flex gap-2">
              <Button variant="ghost" size="sm" onClick={state.reset} disabled={state.saving}>
                Discard
              </Button>
              <GuardedButton
                size="sm"
                reason={problem ?? undefined}
                onClick={() => void state.save()}
                disabled={state.saving}
              >
                {state.saving ? <Loader2 className="size-4 animate-spin" /> : null}
                Save changes
              </GuardedButton>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
