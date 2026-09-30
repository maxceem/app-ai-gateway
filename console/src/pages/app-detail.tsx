import { lazy, Suspense, useMemo, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { AlertCircle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { GuardedButton } from "@/components/guarded-button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/field";
import { MissingProvidersAlert } from "@/components/missing-providers-alert";
import { NoKeysNotice } from "@/components/no-keys-notice";
import { PageActionProvider } from "@/components/page-action";
import { useAppDraft, type SaveOutcome } from "@/hooks/use-app-draft";
import { useLeaveGuard } from "@/hooks/use-leave-guard";
import { useReportUnsaved } from "@/lib/unsaved-draft";
import { APP_SECTIONS, DEFAULT_APP_SECTION, RENAMED_APP_SECTIONS } from "@/lib/app-sections";
import { draftLimits } from "@/lib/config-types";
import { draftProblem } from "@/lib/draft-problems";
import { ErrorsTab } from "@/pages/tabs/errors";
import { AuthPolicyTab } from "@/pages/tabs/auth-policy";
import { LimitsTab } from "@/pages/tabs/limits";
import { ModelRewritesTab } from "@/pages/tabs/model-rewrites";
import { ProviderAccessTab } from "@/pages/tabs/provider-access";
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
  const { appId = "", tab = DEFAULT_APP_SECTION, section } = useParams();
  const state = useAppDraft(appId);
  const { query, draft, dirty, issues } = state;
  // What would make the Worker refuse the draft, said on the button instead:
  // worked out once per change of the draft, not on every render.
  const problem = useMemo(() => (draft ? draftProblem(draft, issues) : null), [draft, issues]);
  // The place beside the title where a section puts the action that creates
  // its rows; held as state so the section renders into it once it exists.
  const [actionSlot, setActionSlot] = useState<HTMLElement | null>(null);
  const heading = APP_SECTIONS.find((entry) => entry.slug === tab);
  // The draft is this page's, and this page is every section of the app, so
  // only a navigation that leaves the app can lose it.
  const leaving = useLeaveGuard(
    dirty,
    (pathname) => pathname === `/apps/${appId}` || pathname.startsWith(`/apps/${appId}/`),
  );
  // Said in the sidebar, under the app's name, where it is seen from every section.
  useReportUnsaved(dirty);

  /*
   * A tab this app does not have: a stale bookmark, or a hand-typed URL.
   *
   * Answered once, here, rather than left to fall out of the chain below: that
   * chain ends in the pair of lazily-loaded tabs, so an unknown tab would reach
   * whichever of them stands last rather than anyone's chosen fallback, while
   * the header's own lookup missed and titled the page something else.
   *
   * Sending the URL to the default section instead keeps the address bar and
   * the content agreeing on what is open, and `replace` keeps Back going to
   * wherever the operator came from rather than to a tab that does not exist.
   */
  if (!heading) {
    const target = RENAMED_APP_SECTIONS[tab] ?? DEFAULT_APP_SECTION;
    return <Navigate to={`/apps/${encodeURIComponent(appId)}/${target}`} replace />;
  }

  /*
   * Saving is the hook's; saying so is this page's. The editor reports an
   * outcome rather than raising a toast itself, so the one place a save is
   * announced is the one screen a save is started from.
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

  return (
    <div className="space-y-6 pb-24">
      <PageHeader
        title={heading.label}
        description={heading.description}
        action={<div ref={setActionSlot} className="flex items-center gap-2 empty:hidden" />}
      />

      {draft ? <MissingProvidersAlert proxy={draft.config.routing} /> : null}
      {/* Not on Auth policy, where the keys themselves are in view. */}
      {draft && draft.config.authentication.type === "api_key" && tab !== "auth" ? (
        <NoKeysNotice appId={appId} />
      ) : null}

      <PageActionProvider value={actionSlot}>
        {query.isPending || !draft ? (
          <div className="space-y-3">
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : tab === "auth" ? (
          <AuthPolicyTab appId={appId} level={section} state={state} />
        ) : tab === "providers" ? (
          // Keyed, because the tab remembers switched-off policies by slug, and
          // a slug names an instance of the whole account, not of this app.
          <ProviderAccessTab key={appId} state={state} />
        ) : tab === "rewrites" ? (
          <ModelRewritesTab state={state} />
        ) : tab === "limits" ? (
          <LimitsTab appId={appId} state={state} />
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
      </PageActionProvider>

      {dirty ? (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t-2 border-amber-500 bg-amber-50/95 backdrop-blur dark:bg-amber-950/70">
          <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-4 sm:px-6">
            <span className="text-sm font-medium">
              Unsaved changes to <span className="font-semibold">{draft?.name ?? appId}</span>
            </span>
            <div className="ml-auto flex gap-2">
              <Button variant="outline" size="sm" onClick={state.reset} disabled={state.saving}>
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

      <ConfirmDialog
        open={leaving.state === "blocked"}
        onOpenChange={(open) => {
          if (!open) leaving.reset?.();
        }}
        title="Leave without saving?"
        description={
          <p>
            Your changes to <span className="font-medium">{draft?.name ?? appId}</span> have not
            been saved. Leaving this app discards them.
          </p>
        }
        confirmLabel="Discard and leave"
        destructive
        onConfirm={() => {
          state.reset();
          leaving.proceed?.();
        }}
      />
    </div>
  );
}
