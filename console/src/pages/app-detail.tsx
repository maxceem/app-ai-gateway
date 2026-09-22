import { lazy, Suspense, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { AlertCircle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { GuardedButton } from "@/components/guarded-button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/field";
import { MissingProvidersAlert } from "@/components/missing-providers-alert";
import { MonthPicker } from "@/components/pickers";
import { useAppDraft, type SaveOutcome } from "@/hooks/use-app-draft";
import { APP_SECTIONS, DEFAULT_APP_SECTION } from "@/lib/app-sections";
import { draftLimits } from "@/lib/config-types";
import { draftProblem } from "@/lib/draft-problems";
import { currentMonth } from "@/lib/format";
import { useConsoleSession } from "@/lib/console-session";
import { ErrorsTab } from "@/pages/tabs/errors";
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
const JsonEditor = lazy(() =>
  import("@/components/json-editor").then((module) => ({ default: module.JsonEditor })),
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
  const { readOnly } = useConsoleSession();
  // The month belongs to the page, because the control that picks it sits in
  // the page header beside the section's name.
  const [month, setMonth] = useState(currentMonth());
  const heading = APP_SECTIONS.find((entry) => entry.slug === tab);

  /*
   * A tab this app does not have: a stale bookmark, or a hand-typed URL.
   *
   * Answered once, here, rather than left to fall out of the chain below. That
   * chain ends in the pair of lazily-loaded tabs, so an unknown tab used to
   * reach `Endpoints` — not as anyone's choice of fallback, but because
   * Endpoints is the second of the two and so the last branch standing. The
   * header meanwhile did its own lookup, missed, and titled the page
   * "Overview", leaving the two halves of the screen naming different sections.
   *
   * Sending the URL to the default section instead keeps the address bar and
   * the content agreeing on what is open, and `replace` keeps Back going to
   * wherever the operator came from rather than to a tab that does not exist.
   */
  if (!heading) {
    return <Navigate to={`/apps/${encodeURIComponent(appId)}/${DEFAULT_APP_SECTION}`} replace />;
  }

  const { query, draft, dirty } = state;
  // What would make the Worker refuse the draft, said on the button instead.
  const problem = draft ? draftProblem(draft) : null;

  /*
   * Saving is the hook's; saying so is this page's. The editor reports an
   * outcome rather than raising a toast itself, so the one place a save is
   * announced is the one screen a save is started from — and a rejection the
   * repair editor already shows beside the offending text is not repeated here.
   */
  const announce = (done: SaveOutcome, success: string) => {
    if (done.ok) {
      toast.success(success, {
        description: "The gateway picks it up within the 60 second config cache TTL.",
      });
      return;
    }
    if (!done.inline) toast.error("Save rejected", { description: done.message });
  };

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

  if (state.repair && state.invalidApp) {
    const row = state.invalidApp;
    return (
      <div className="space-y-6 pb-24">
        <PageHeader title={heading.label} />
        {state.storedConfigValid ? (
          <Alert>
            <AlertCircle />
            <AlertTitle>A newer valid configuration is stored</AlertTitle>
            <AlertDescription>
              This editor keeps your unsaved JSON and its original revision. Saving may require reloading first.
            </AlertDescription>
          </Alert>
        ) : (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>The stored configuration is invalid</AlertTitle>
            <AlertDescription>
              {state.configError}. The gateway rejects requests for this app until it is fixed.
            </AlertDescription>
          </Alert>
        )}
        <div className="space-y-1 text-sm text-muted-foreground">
          <p><span className="font-medium text-foreground">{row.name}</span> · {row.id}</p>
          <p>Status: {row.status}</p>
        </div>
        <div className="space-y-3">
          <div>
            <h2 className="font-medium">Repair configuration JSON</h2>
            <p className="text-sm text-muted-foreground">
              Correct the stored value below. It is validated before it is sent.
            </p>
          </div>
          {state.repair ? (
            <Suspense fallback={<Skeleton className="h-72 w-full" />}>
              <JsonEditor
                value={state.repair.text}
                onChange={state.updateRepair}
                readOnly={readOnly || state.saving}
                minHeight="320px"
              />
            </Suspense>
          ) : (
            <Skeleton className="h-72 w-full" />
          )}
          {state.repairError ? (
            <p role="alert" className="text-sm text-destructive">{state.repairError}</p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={state.resetRepair}
              disabled={!state.repairDirty || state.saving}
            >
              Discard
            </Button>
            <GuardedButton
              onClick={() => void state.saveRepair().then(
                (done) => announce(done, "Configuration repaired"),
              )}
              disabled={!state.repairDirty || state.saving}
            >
              {state.saving ? <Loader2 className="size-4 animate-spin" /> : null}
              Save repaired configuration
            </GuardedButton>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-24">
      <PageHeader
        title={heading.label}
        action={
          tab === "overview" ? <MonthPicker value={month} onChange={setMonth} /> : undefined
        }
      />

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
        // The users table measures each user against the app's own per-user
        // budget, which lives in the draft this page already holds. An app with
        // no limits block is unlimited.
        <UsersTab
          appId={appId}
          monthlyBudgetUsd={draftLimits(draft.config.limits).per_user.spending.monthly_usd}
        />
      ) : tab === "errors" ? (
        <ErrorsTab appId={appId} />
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
                onClick={() => void state.save().then(
                  (done) => announce(done, "Configuration saved"),
                )}
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
