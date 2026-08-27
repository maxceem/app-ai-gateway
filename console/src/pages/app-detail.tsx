import { lazy, Suspense, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  AlertCircle,
  ArrowLeft,
  BadgeCheck,
  Braces,
  ChartNoAxesColumn,
  Gauge,
  Loader2,
  MoreHorizontal,
  Power,
  Route,
  ShieldCheck,
  Trash2,
  Users,
  Waypoints,
} from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { GuardedButton } from "@/components/guarded-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { MissingProvidersAlert } from "@/components/missing-providers-alert";
import { AppStatusBadge } from "@/components/status-badge";
import { useAppDraft } from "@/hooks/use-app-draft";
import { useConsoleSession } from "@/lib/console-session";
import { READ_ONLY_REASON } from "@/lib/permissions";
import { useDeleteApp } from "@/lib/queries";
import { AuthPolicyTab } from "@/pages/tabs/auth-policy";
import { LimitsTab } from "@/pages/tabs/limits";
import { OverviewTab } from "@/pages/tabs/overview";
import { ProxyPolicyTab } from "@/pages/tabs/proxy-policy";
import { UsersTab } from "@/pages/tabs/users";

// Charts and the code editor are each larger than the rest of the console; they
// load only when their tab is opened.
const UsageTab = lazy(() => import("@/pages/tabs/usage").then((module) => ({ default: module.UsageTab })));
const RawJsonTab = lazy(() =>
  import("@/pages/tabs/raw-json").then((module) => ({ default: module.RawJsonTab })),
);
const EndpointsTab = lazy(() =>
  import("@/pages/tabs/endpoints").then((module) => ({ default: module.EndpointsTab })),
);

const TABS = [
  { value: "overview", label: "Overview", icon: BadgeCheck },
  { value: "auth", label: "Auth policy", icon: ShieldCheck },
  { value: "proxy", label: "Proxy policy", icon: Waypoints },
  { value: "endpoints", label: "Endpoints", icon: Route },
  { value: "limits", label: "Limits", icon: Gauge },
  { value: "users", label: "Users", icon: Users },
  { value: "usage", label: "Usage", icon: ChartNoAxesColumn },
  { value: "json", label: "Raw JSON", icon: Braces },
] as const;

export function AppDetailPage() {
  const { appId = "", tab = "overview" } = useParams();
  const navigate = useNavigate();
  const state = useAppDraft(appId);
  const deleteApp = useDeleteApp();
  const { readOnly } = useConsoleSession();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { query, draft, dirty } = state;

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

  const remove = async () => {
    try {
      const result = await deleteApp.mutateAsync(appId);
      toast.success(`Deleted ${appId}`, {
        description: `${result.removed_users} users removed. Usage history was kept.`,
      });
      navigate("/apps");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not delete the app");
    }
  };

  const toggleStatus = () => {
    if (!draft) return;
    state.update({ status: draft.status === "active" ? "disabled" : "active" });
  };

  return (
    <div className="space-y-6 pb-24">
      <div className="space-y-3">
        <Link
          to="/apps"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Apps
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            {query.isPending || !draft ? (
              <Skeleton className="h-7 w-48" />
            ) : (
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-semibold tracking-tight">{draft.name}</h1>
                <AppStatusBadge status={draft.status} />
              </div>
            )}
            <p className="font-mono text-xs text-muted-foreground">{appId}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void state.validate()} disabled={!draft}>
              {state.validating ? <Loader2 className="size-4 animate-spin" /> : null}
              Validate
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" aria-label="More actions">
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                {/* A tooltip cannot follow the pointer into a menu, so the
                    restriction is stated as a label above the disabled items. */}
                {readOnly ? (
                  <>
                    <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                      {READ_ONLY_REASON}
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                  </>
                ) : null}
                <DropdownMenuItem onClick={toggleStatus} disabled={!draft || readOnly}>
                  <Power className="size-4" />
                  {draft?.status === "active" ? "Disable app" : "Enable app"}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  disabled={readOnly}
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 className="size-4" />
                  Delete app
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

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

      <Tabs value={tab} onValueChange={(next) => navigate(`/apps/${appId}/${next}`)}>
        <TabsList className="w-full justify-start overflow-x-auto">
          {TABS.map((entry) => (
            <TabsTrigger key={entry.value} value={entry.value} className="gap-1.5">
              <entry.icon className="size-3.5" />
              {entry.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {query.isPending || !draft ? (
        <div className="space-y-3">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : tab === "overview" ? (
        <OverviewTab appId={appId} state={state} />
      ) : tab === "auth" ? (
        <AuthPolicyTab appId={appId} state={state} />
      ) : tab === "proxy" ? (
        <ProxyPolicyTab state={state} />
      ) : tab === "limits" ? (
        <LimitsTab state={state} />
      ) : tab === "users" ? (
        <UsersTab appId={appId} />
      ) : (
        <Suspense fallback={<Skeleton className="h-64 w-full" />}>
          {tab === "usage" ? (
            <UsageTab appId={appId} />
          ) : tab === "endpoints" ? (
            <EndpointsTab appId={appId} state={state} />
          ) : (
            <RawJsonTab state={state} />
          )}
        </Suspense>
      )}

      {dirty ? (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 backdrop-blur">
          <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:px-6">
            <span className="text-sm">
              <span className="mr-2 inline-block size-2 rounded-full bg-amber-500 align-middle" />
              Unsaved changes to <span className="font-mono">{appId}</span>
            </span>
            <div className="ml-auto flex gap-2">
              <Button variant="ghost" size="sm" onClick={state.reset} disabled={state.saving}>
                Discard
              </Button>
              <GuardedButton size="sm" onClick={() => void state.save()} disabled={state.saving}>
                {state.saving ? <Loader2 className="size-4 animate-spin" /> : null}
                Save changes
              </GuardedButton>
            </div>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${appId}?`}
        description={
          <>
            <p>
              Clients of this app stop working immediately. Registered users and App Attest keys are
              removed; usage history is kept for accounting.
            </p>
            <p>This cannot be undone.</p>
          </>
        }
        confirmWord={appId}
        confirmLabel="Delete app"
        destructive
        pending={deleteApp.isPending}
        onConfirm={() => void remove()}
      />
    </div>
  );
}
