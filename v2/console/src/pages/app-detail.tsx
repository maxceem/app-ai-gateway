import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { AlertCircle, ArrowLeft, Ban, CheckCircle2, CircleSlash, KeyRound, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { GuardedButton } from "@/components/guarded-button";
import { RelativeTime } from "@/components/relative-time";
import { RowAction, RowActions } from "@/components/row-actions";
import { SecretRevealDialog } from "@/components/secret-reveal-dialog";
import { ApiError } from "@/lib/api";
import { useConsoleSession } from "@/lib/console-session";
import { formatCost, formatNumber } from "@/lib/format";
import { dollarsToNano, nanoToDollarText, nanoToDollars } from "@/lib/money";
import { operationsOf, providerLabel } from "@/lib/providers";
import {
  useApp,
  useAppCheck,
  useAppKeys,
  useAppUsers,
  useCreateAppKey,
  useDeleteApp,
  useProviders,
  useRevokeAppKey,
  useUpdateApp,
  useUserAction,
  useValidateApp,
} from "@/lib/queries";
import type { App, AppConfig, CreatedAppKey } from "@/lib/types";
import { cn } from "@/lib/utils";
import { appKind } from "@/pages/apps";

interface Tab {
  slug: string;
  label: string;
  /** Only for some apps: keys exist only for server apps. */
  shown?: (app: App) => boolean;
}

const TABS: Tab[] = [
  { slug: "overview", label: "Overview" },
  { slug: "providers", label: "Providers" },
  { slug: "limits", label: "Limits" },
  { slug: "users", label: "Users" },
  { slug: "keys", label: "Keys", shown: (app) => app.config.authentication.type === "api_key" },
  { slug: "settings", label: "Settings" },
];

export const DEFAULT_APP_TAB = "overview";

/**
 * What a save refusal means for the person, in words. Settings keeps what
 * was typed through a conflict; the shorter forms reload and ask again.
 */
function saveError(error: unknown, fallback: string, keepsEdits: boolean): string {
  if (error instanceof ApiError && error.code === "app_revision_conflict") {
    return keepsEdits
      ? "The app changed since you opened it. Your edits are kept; save again to replace it."
      : "The app changed since you opened it. The latest version is loaded; make your change again.";
  }
  return error instanceof Error ? error.message : fallback;
}

/**
 * Saves the app with one part of it changed, at the revision it was read at.
 * Returns the app as the gateway stored it, or null when the save failed.
 */
function useSaveApp(app: App, { keepsEdits = false }: { keepsEdits?: boolean } = {}) {
  const update = useUpdateApp(app.id);
  const save = async (change: { name?: string; status?: App["status"]; config?: AppConfig | unknown }, done: string) => {
    try {
      const result = await update.mutateAsync({
        name: change.name ?? app.name,
        status: change.status ?? app.status,
        // An explicit config is sent as typed, even `null`: the gateway refuses
        // what is not valid, rather than this page saving the old one instead.
        config: "config" in change ? change.config : app.config,
        revision: app.revision,
      });
      toast.success(done);
      return result.app;
    } catch (error) {
      toast.error(saveError(error, "Could not save the app", keepsEdits));
      return null;
    }
  };
  return { save, pending: update.isPending };
}

export function AppDetailPage() {
  const { appId = "", tab = DEFAULT_APP_TAB } = useParams();
  const app = useApp(appId);

  if (app.isPending) return <Skeleton className="h-40 w-full" />;
  if (app.isError || !app.data) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>Could not load this app</AlertTitle>
        <AlertDescription>{app.error instanceof Error ? app.error.message : "It may have been deleted."}</AlertDescription>
      </Alert>
    );
  }
  const data = app.data.app;
  const tabs = TABS.filter((entry) => entry.shown?.(data) ?? true);
  const active = tabs.find((entry) => entry.slug === tab);
  if (!active) return <Navigate to={`/apps/${encodeURIComponent(appId)}/${DEFAULT_APP_TAB}`} replace />;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link to="/apps" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" />
          Apps
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{data.name}</h1>
        <p className="text-sm text-muted-foreground">
          {appKind(data)} · <span className="font-mono">{data.id}</span>
          {data.status === "disabled" ? " · Off" : null}
        </p>
      </div>

      <nav aria-label="App sections" className="flex gap-1 overflow-x-auto border-b">
        {tabs.map((entry) => (
          <Link
            key={entry.slug}
            to={`/apps/${encodeURIComponent(appId)}/${entry.slug}`}
            aria-current={entry.slug === active.slug ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium",
              entry.slug === active.slug
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {entry.label}
          </Link>
        ))}
      </nav>

      {active.slug === "overview" ? <OverviewTab app={data} /> : null}
      {active.slug === "providers" ? <ProvidersTab app={data} /> : null}
      {active.slug === "limits" ? <LimitsTab app={data} /> : null}
      {active.slug === "users" ? <UsersTab app={data} /> : null}
      {active.slug === "keys" ? <KeysTab app={data} /> : null}
      {active.slug === "settings" ? <SettingsTab app={data} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview

function OverviewTab({ app }: { app: App }) {
  const check = useAppCheck(app.id);
  const base = `${window.location.origin}/v2/apps/${encodeURIComponent(app.id)}/proxy/`;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Ready to serve</CardTitle>
          <CardDescription>Whether the provider connections this app names are in place.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {check.isPending ? (
            <Skeleton className="h-5 w-48" />
          ) : check.isError || !check.data ? (
            <p className="text-destructive">Could not check the app.</p>
          ) : (
            <>
              <p className="flex items-center gap-2 font-medium">
                {check.data.ready ? <CheckCircle2 className="size-4 text-primary" /> : <CircleSlash className="size-4 text-muted-foreground" />}
                {check.data.ready ? "Ready" : "Not ready yet"}
              </p>
              {check.data.providers.length === 0 ? (
                <p className="text-muted-foreground">
                  It names no provider yet. <Link className="underline" to={`/apps/${encodeURIComponent(app.id)}/providers`}>Allow one</Link>.
                </p>
              ) : (
                <ul className="space-y-1">
                  {check.data.providers.map((provider) => (
                    <li key={provider.slug}>
                      <span className="font-mono">{provider.slug}</span>:{" "}
                      {provider.status === "active" ? "on" : provider.status === "disabled" ? "turned off" : "removed"}
                    </li>
                  ))}
                </ul>
              )}
              {check.data.limitations.map((line) => (
                <p key={line} className="text-xs text-muted-foreground">{line}</p>
              ))}
            </>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Calling a provider</CardTitle>
          <CardDescription>Your app sends a provider's own request to this address, followed by the provider's path.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="font-mono text-xs break-all">{base}&lt;provider slug&gt;/…</p>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Providers: which connections, operations and models the app may use

interface RoutingDraft {
  allowed: boolean;
  operations: string[];
  models: string;
  maxOutputTokens: string;
}

type ProviderRouting = AppConfig["routing"]["providers"][string];

function draftOf(routing: ProviderRouting | undefined): RoutingDraft {
  return {
    allowed: routing !== undefined,
    operations: routing?.operations ?? [],
    models: routing?.models?.join(", ") ?? "",
    maxOutputTokens: routing?.max_output_tokens === undefined ? "" : String(routing.max_output_tokens),
  };
}

/** The routing entry a draft saves as, or null for a connection the app does not use. */
export function routingOf(draft: RoutingDraft): ProviderRouting | null {
  if (!draft.allowed) return null;
  const models = draft.models.split(",").map((model) => model.trim()).filter(Boolean);
  const max = draft.maxOutputTokens.trim();
  return {
    operations: draft.operations,
    ...(models.length > 0 ? { models: [...new Set(models)] } : {}),
    ...(max ? { max_output_tokens: Number(max) } : {}),
  };
}

function ProvidersTab({ app }: { app: App }) {
  const providers = useProviders();
  const { save, pending } = useSaveApp(app);
  const routing = app.config.routing.providers;
  const [drafts, setDrafts] = useState<Record<string, RoutingDraft>>({});
  useEffect(() => setDrafts({}), [app.revision]);

  const connections = providers.data?.providers ?? [];
  const known = new Set(connections.map((connection) => connection.slug));
  const removed = Object.keys(routing).filter((slug) => !known.has(slug));
  const draftFor = (slug: string) => drafts[slug] ?? draftOf(routing[slug]);
  const change = (slug: string, next: Partial<RoutingDraft>) =>
    setDrafts((current) => ({ ...current, [slug]: { ...draftFor(slug), ...next } }));
  const dirty = Object.keys(drafts).length > 0;

  const invalid = connections.some((connection) => {
    const draft = draftFor(connection.slug);
    const max = draft.maxOutputTokens.trim();
    return draft.allowed && (draft.operations.length === 0 || (max !== "" && !/^[1-9]\d*$/u.test(max)));
  });

  const submit = async () => {
    const next: Record<string, ProviderRouting> = {};
    // A removed connection's entry stays as it was: the gateway keeps it only unchanged.
    for (const slug of removed) next[slug] = routing[slug]!;
    for (const connection of connections) {
      const entry = routingOf(draftFor(connection.slug));
      if (entry) next[connection.slug] = entry;
    }
    if (await save({ config: { ...app.config, routing: { providers: next } } }, "Providers saved")) setDrafts({});
  };

  if (providers.isPending) return <Skeleton className="h-24 w-full" />;
  // Without the list, every allowed connection would look removed.
  if (providers.isError) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>Could not load your providers</AlertTitle>
        <AlertDescription>{providers.error instanceof Error ? providers.error.message : "Try again in a moment."}</AlertDescription>
      </Alert>
    );
  }
  if (connections.length === 0 && removed.length === 0) {
    return (
      <Alert>
        <AlertTitle>No providers yet</AlertTitle>
        <AlertDescription>
          <span>
            Add a provider first, then come back to allow it. <Link className="underline" to="/providers">Go to providers</Link>.
          </span>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        The app may call only what is allowed here. Leave models empty to allow every model with a price.
      </p>
      {connections.map((connection) => {
        const draft = draftFor(connection.slug);
        const operations = operationsOf(connection.type);
        return (
          <Card key={connection.id}>
            <CardContent className="space-y-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <Checkbox
                  checked={draft.allowed}
                  // Every field is locked while a save runs, so its answer never wipes a later edit.
                  disabled={pending}
                  aria-label={`Allow ${connection.slug}`}
                  onCheckedChange={(checked) =>
                    change(connection.slug, {
                      allowed: checked === true,
                      // The first operation, so a newly allowed connection is valid as it stands.
                      operations: checked === true && draft.operations.length === 0 && operations[0] ? [operations[0].name] : draft.operations,
                    })
                  }
                />
                {connection.name} <span className="font-mono text-xs text-muted-foreground">{connection.slug}</span>
                <span className="text-xs font-normal text-muted-foreground">{providerLabel(connection.type)}</span>
                {connection.status === "disabled" ? <span className="text-xs font-normal text-muted-foreground">(turned off)</span> : null}
              </label>
              {draft.allowed ? (
                <div className="space-y-3 pl-6">
                  <div className="space-y-1">
                    <p className="text-sm">Operations</p>
                    <div className="flex flex-wrap gap-x-4 gap-y-1">
                      {operations.map((operation) => (
                        <label key={operation.name} className="flex items-center gap-1.5 text-sm">
                          <Checkbox
                            checked={draft.operations.includes(operation.name)}
                            disabled={pending}
                            onCheckedChange={(checked) =>
                              change(connection.slug, {
                                operations: checked === true
                                  ? [...draft.operations, operation.name]
                                  : draft.operations.filter((name) => name !== operation.name),
                              })
                            }
                          />
                          <span className="font-mono text-xs">{operation.name}</span>
                          {operation.session ? <span className="text-xs text-muted-foreground">(live sessions, coming later)</span> : null}
                        </label>
                      ))}
                    </div>
                    {draft.operations.length === 0 ? <p className="text-sm text-destructive">Allow at least one operation.</p> : null}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Models" htmlFor={`models-${connection.slug}`} hint="Separated by commas. Empty allows every priced model.">
                      <Input
                        id={`models-${connection.slug}`}
                        value={draft.models}
                        disabled={pending}
                        autoComplete="off"
                        onChange={(event) => change(connection.slug, { models: event.target.value })}
                      />
                    </Field>
                    <Field label="Most output tokens" htmlFor={`max-${connection.slug}`} hint="Optional.">
                      <Input
                        id={`max-${connection.slug}`}
                        inputMode="numeric"
                        value={draft.maxOutputTokens}
                        disabled={pending}
                        autoComplete="off"
                        onChange={(event) => change(connection.slug, { maxOutputTokens: event.target.value })}
                      />
                    </Field>
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>
        );
      })}
      {removed.map((slug) => (
        <Alert key={slug}>
          <AlertTitle>
            <span className="font-mono">{slug}</span> was removed
          </AlertTitle>
          <AlertDescription>
            Its settings stay as they were. Add a provider with this slug to bring it back.
          </AlertDescription>
        </Alert>
      ))}
      <GuardedButton disabled={!dirty || invalid || pending} onClick={() => void submit()}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        Save providers
      </GuardedButton>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Limits

interface ScopeDraft {
  perMinute: string;
  perDay: string;
  monthlyDollars: string;
}

type LimitScope = AppConfig["limits"]["per_app"];

function scopeDraft(scope: LimitScope): ScopeDraft {
  return {
    perMinute: scope.requests.per_minute === null ? "" : String(scope.requests.per_minute),
    perDay: scope.requests.per_day === null ? "" : String(scope.requests.per_day),
    monthlyDollars: scope.spending.monthly_nano === null ? "" : nanoToDollarText(scope.spending.monthly_nano),
  };
}

const WHOLE = /^[1-9]\d*$/u;

/** A scope's draft as the config saves it, or null when something in it is not a valid number. */
export function scopeOf(draft: ScopeDraft): { requests: { per_minute: number | null; per_day: number | null }; monthly_nano: number | null } | null {
  const count = (text: string) => (text.trim() === "" ? null : WHOLE.test(text.trim()) ? Number(text.trim()) : undefined);
  const perMinute = count(draft.perMinute);
  const perDay = count(draft.perDay);
  const monthly = draft.monthlyDollars.trim() === "" ? null : dollarsToNano(draft.monthlyDollars);
  if (perMinute === undefined || perDay === undefined || (draft.monthlyDollars.trim() !== "" && monthly === null)) return null;
  return { requests: { per_minute: perMinute, per_day: perDay }, monthly_nano: monthly };
}

const BUDGET_SCOPE_LABELS = {
  install: "Each install",
  user: "Each signed-in user",
  apple_account: "Each Apple Account",
} as const;

function ScopeFields({
  id,
  draft,
  disabled,
  onChange,
}: {
  id: string;
  draft: ScopeDraft;
  disabled?: boolean;
  onChange: (next: Partial<ScopeDraft>) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Field label="Requests per minute" htmlFor={`${id}-minute`}>
        <Input id={`${id}-minute`} inputMode="numeric" disabled={disabled} value={draft.perMinute} onChange={(event) => onChange({ perMinute: event.target.value })} />
      </Field>
      <Field label="Requests per day" htmlFor={`${id}-day`}>
        <Input id={`${id}-day`} inputMode="numeric" disabled={disabled} value={draft.perDay} onChange={(event) => onChange({ perDay: event.target.value })} />
      </Field>
      <Field label="Monthly budget ($)" htmlFor={`${id}-budget`}>
        <Input id={`${id}-budget`} inputMode="decimal" disabled={disabled} value={draft.monthlyDollars} onChange={(event) => onChange({ monthlyDollars: event.target.value })} />
      </Field>
    </div>
  );
}

function LimitsTab({ app }: { app: App }) {
  const { save, pending } = useSaveApp(app);
  const { limits, authentication } = app.config;
  const [perUser, setPerUser] = useState(() => scopeDraft(limits.per_user));
  const [perApp, setPerApp] = useState(() => scopeDraft(limits.per_app));
  const [budgetScope, setBudgetScope] = useState(limits.per_user.spending.scope ?? "");
  useEffect(() => {
    setPerUser(scopeDraft(limits.per_user));
    setPerApp(scopeDraft(limits.per_app));
    setBudgetScope(limits.per_user.spending.scope ?? "");
  }, [app.revision, limits]);

  const namesUsers = authentication.end_user.source !== "none";
  const scopes = authentication.type === "api_key"
    ? (["user"] as const)
    : authentication.end_user.source === "issuer"
      ? (["install", "user", "apple_account"] as const)
      : (["install", "apple_account"] as const);
  const user = scopeOf(perUser);
  const whole = scopeOf(perApp);

  const submit = async () => {
    if (!user || !whole) return;
    const next = {
      per_user: {
        requests: user.requests,
        spending: { monthly_nano: user.monthly_nano, ...(budgetScope ? { scope: budgetScope } : {}) },
      },
      per_app: { requests: whole.requests, spending: { monthly_nano: whole.monthly_nano } },
    };
    await save({ config: { ...app.config, limits: next } }, "Limits saved");
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Leave a field empty for no limit. Budgets are in dollars a month.</p>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">For each of the app's users</CardTitle>
          {!namesUsers ? <CardDescription>This app names no end users, so it can only be limited as a whole.</CardDescription> : null}
        </CardHeader>
        <CardContent className="space-y-3">
          <ScopeFields id="per-user" draft={perUser} disabled={!namesUsers || pending} onChange={(next) => setPerUser({ ...perUser, ...next })} />
          {namesUsers ? (
            <Field label="Whose month the budget counts" htmlFor="budget-scope">
              <Select value={budgetScope || "default"} disabled={pending} onValueChange={(value) => setBudgetScope(value === "default" ? "" : value)}>
                <SelectTrigger id="budget-scope" className="w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">The default for this app</SelectItem>
                  {scopes.map((scope) => (
                    <SelectItem key={scope} value={scope}>{BUDGET_SCOPE_LABELS[scope]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          {user === null ? <p className="text-sm text-destructive">Use whole numbers for requests, and an amount like 25 or 0.50 for the budget.</p> : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">For the whole app</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <ScopeFields id="per-app" draft={perApp} disabled={pending} onChange={(next) => setPerApp({ ...perApp, ...next })} />
          {whole === null ? <p className="text-sm text-destructive">Use whole numbers for requests, and an amount like 25 or 0.50 for the budget.</p> : null}
        </CardContent>
      </Card>
      <GuardedButton disabled={!user || !whole || pending} onClick={() => void submit()}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        Save limits
      </GuardedButton>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Users

const PAGE = 50;

function UsersTab({ app }: { app: App }) {
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const users = useAppUsers(app.id, { query: search.trim() || undefined, limit: PAGE, offset });
  const action = useUserAction(app.id);
  const list = users.data?.users ?? [];
  const total = users.data?.total ?? 0;

  const act = async (userId: string, block: boolean) => {
    try {
      await action.mutateAsync({ userId, block });
      toast.success(block ? "User blocked" : "User unblocked");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not change the user");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          The app's users this month{users.data ? ` (${users.data.month})` : ""}, with what they spent.
        </p>
        <Input
          aria-label="Search users"
          placeholder="Search by user id"
          className="h-8 w-64"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setOffset(0);
          }}
        />
      </div>
      <Card className="overflow-hidden py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Requests</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead>Last seen</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.isPending ? (
              <TableRow>
                <TableCell colSpan={6}>
                  <Skeleton className="h-5 w-full" />
                </TableCell>
              </TableRow>
            ) : list.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                  No users yet.
                </TableCell>
              </TableRow>
            ) : (
              list.map((user) => (
                <TableRow key={user.id}>
                  <TableCell className="max-w-72 font-mono text-xs break-all">{user.id}</TableCell>
                  <TableCell>{user.status === "blocked" ? <span className="text-destructive">Blocked</span> : "Active"}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(user.usage.charges)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCost(nanoToDollars(user.usage.cost_nano))}</TableCell>
                  <TableCell className="text-muted-foreground">{user.last_seen_at ? <RelativeTime value={user.last_seen_at} /> : "—"}</TableCell>
                  <TableCell className="text-right">
                    {/* A user only usage names has no record to block. */}
                    {user.is_virtual ? null : (
                      <RowActions label={user.id}>
                        {user.status === "blocked" ? (
                          <RowAction onSelect={() => void act(user.id, false)}>
                            <CheckCircle2 />
                            Unblock
                          </RowAction>
                        ) : (
                          <RowAction destructive onSelect={() => void act(user.id, true)}>
                            <Ban />
                            Block
                          </RowAction>
                        )}
                      </RowActions>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
      {total > PAGE ? (
        <div className="flex items-center justify-end gap-2 text-sm">
          <span className="text-muted-foreground">
            {offset + 1}–{Math.min(offset + PAGE, total)} of {total}
          </span>
          <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
            Previous
          </Button>
          <Button size="sm" variant="outline" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
            Next
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Keys (server apps)

function KeysTab({ app }: { app: App }) {
  const keysList = useAppKeys(app.id);
  const create = useCreateAppKey(app.id);
  const revoke = useRevokeAppKey(app.id);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<CreatedAppKey | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const list = keysList.data?.keys ?? [];

  const submit = async () => {
    try {
      setCreated(await create.mutateAsync(name.trim()));
      setNaming(false);
      setName("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create the key");
    }
  };

  const confirmRevoke = async () => {
    if (!revoking) return;
    try {
      await revoke.mutateAsync(revoking);
      toast.success("App key revoked");
      setRevoking(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not revoke the key");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">Your server sends one of these keys with every call.</p>
        <GuardedButton size="sm" onClick={() => setNaming(true)}>
          <Plus className="size-4" />
          New key
        </GuardedButton>
      </div>
      <Card className="overflow-hidden py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Key</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keysList.isPending ? (
              <TableRow>
                <TableCell colSpan={6}>
                  <Skeleton className="h-5 w-full" />
                </TableCell>
              </TableRow>
            ) : list.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">No keys.</TableCell>
              </TableRow>
            ) : (
              list.map((key) => (
                <TableRow key={key.id}>
                  <TableCell className="font-medium">{key.name}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{key.key_prefix}…</TableCell>
                  <TableCell className="text-muted-foreground"><RelativeTime value={key.created_at} /></TableCell>
                  <TableCell className="text-muted-foreground">{key.last_used_at ? <RelativeTime value={key.last_used_at} /> : "Never"}</TableCell>
                  <TableCell>{key.status === "active" ? "Active" : <span className="text-muted-foreground">Revoked</span>}</TableCell>
                  <TableCell className="text-right">
                    {key.status === "active" ? (
                      <RowActions label={key.name}>
                        <RowAction destructive onSelect={() => setRevoking(key.id)}>
                          <KeyRound />
                          Revoke key
                        </RowAction>
                      </RowActions>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      <FormDialog
        open={naming}
        onOpenChange={setNaming}
        title="Create an app key"
        submitLabel="Create key"
        pending={create.isPending}
        disabled={!name.trim()}
        onSubmit={() => void submit()}
      >
        <Field label="Key name" htmlFor="app-key-name">
          <Input id="app-key-name" value={name} maxLength={100} autoFocus autoComplete="off" onChange={(event) => setName(event.target.value)} />
        </Field>
      </FormDialog>

      <SecretRevealDialog
        open={created !== null}
        title="Copy your app key now"
        description={<>This is the only time the key is shown. The gateway stores only a hash.</>}
        label="App key"
        secret={created?.key ?? ""}
        onAcknowledge={() => {
          setCreated(null);
          create.reset();
        }}
      />

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title="Revoke app key"
        description={<p>Calls with this key are refused at once. This cannot be undone.</p>}
        confirmLabel="Revoke key"
        destructive
        pending={revoke.isPending}
        onConfirm={() => void confirmRevoke()}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
/** Whether typed JSON means the same as the stored text, ignoring layout. */
function sameJson(typed: string, stored: string): boolean {
  try {
    return JSON.stringify(JSON.parse(typed), null, 2) === stored;
  } catch {
    return false;
  }
}

// Settings: name, on or off, the whole configuration, and deleting

function SettingsTab({ app }: { app: App }) {
  const navigate = useNavigate();
  const { readOnly } = useConsoleSession();
  const { save, pending } = useSaveApp(app, { keepsEdits: true });
  const validate = useValidateApp(app.id);
  const remove = useDeleteApp();
  const stored = JSON.stringify(app.config, null, 2);
  const [name, setName] = useState(app.name);
  const [text, setText] = useState(stored);
  const [deleting, setDeleting] = useState(false);
  // What each draft started from. When the stored value changes, an untouched
  // draft follows it, and so does one that now matches it (such as after its
  // own save). An edited draft is kept, and the page says the saved version
  // changed, so nothing typed is lost and the next save uses the new revision.
  const [nameBase, setNameBase] = useState(app.name);
  const [textBase, setTextBase] = useState(stored);
  const [changedElsewhere, setChangedElsewhere] = useState(false);
  useEffect(() => {
    if (app.name === nameBase) return;
    if (name === nameBase || name.trim() === app.name) setName(app.name);
    else setChangedElsewhere(true);
    setNameBase(app.name);
  }, [app.name, nameBase, name]);
  useEffect(() => {
    if (stored === textBase) return;
    if (text === textBase || sameJson(text, stored)) setText(stored);
    else setChangedElsewhere(true);
    setTextBase(stored);
  }, [stored, textBase, text]);
  // Once both drafts match what is saved, by a save or by discarding, the
  // conflict is over: a later edit starts fresh.
  const draftsSaved = name.trim() === app.name && sameJson(text, stored);
  useEffect(() => {
    if (changedElsewhere && draftsSaved) setChangedElsewhere(false);
  }, [changedElsewhere, draftsSaved]);
  // A saved draft becomes what the gateway stored, defaults filled in, and
  // ends any conflict: comparing the two could differ only by those defaults.
  const saveName = async () => {
    const saved = await save({ name: name.trim() }, "App renamed");
    if (!saved) return;
    setName(saved.name);
    setNameBase(saved.name);
    // The conflict ends only once the configuration draft is saved or
    // discarded too: the `draftsSaved` effect clears it then.
  };
  const saveConfig = async () => {
    const saved = await save({ config: parsed }, "Configuration saved");
    if (!saved) return;
    const text = JSON.stringify(saved.config, null, 2);
    setText(text);
    setTextBase(text);
    setChangedElsewhere(false);
  };
  const discardDrafts = () => {
    setName(app.name);
    setText(stored);
    setChangedElsewhere(false);
  };

  let parsed: unknown = undefined;
  let parseError: string | null = null;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    parseError = error instanceof Error ? error.message : "Not valid JSON";
  }

  const check = async () => {
    try {
      // The saved name, as Save sends: renaming has its own button.
      await validate.mutateAsync({ name: app.name, config: parsed, status: app.status });
      toast.success("The configuration is valid");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The configuration is not valid");
    }
  };

  const confirmDelete = async () => {
    try {
      await remove.mutateAsync(app.id);
      toast.success("App deleted");
      await navigate("/apps", { replace: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not delete the app");
    }
  };

  return (
    <div className="space-y-4">
      {changedElsewhere && (name.trim() !== app.name || !sameJson(text, stored)) ? (
        <Alert>
          <AlertCircle />
          <AlertTitle>This app was changed since you started editing</AlertTitle>
          <AlertDescription>
            <p>Your unsaved edits are kept below. Saving them replaces the latest saved version.</p>
            <Button type="button" size="sm" variant="outline" className="mt-2" onClick={discardDrafts}>
              Discard my edits
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Name and status</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex max-w-md items-end gap-2">
            <div className="flex-1 space-y-2">
              <Label htmlFor="app-rename">Name</Label>
              <Input id="app-rename" value={name} maxLength={100} disabled={readOnly || pending} onChange={(event) => setName(event.target.value)} />
            </div>
            <GuardedButton variant="outline" disabled={!name.trim() || name.trim() === app.name || pending} onClick={() => void saveName()}>
              Rename
            </GuardedButton>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span>{app.status === "active" ? "The app is on and serves calls." : "The app is off: every call is refused."}</span>
            <GuardedButton
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => void save({ status: app.status === "active" ? "disabled" : "active" }, app.status === "active" ? "App turned off" : "App turned on")}
            >
              {app.status === "active" ? "Turn off" : "Turn on"}
            </GuardedButton>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Configuration</CardTitle>
          <CardDescription>
            The whole configuration: sign-in, providers and limits. Checked in full before it is saved.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            aria-label="Configuration"
            className="min-h-72 font-mono text-xs"
            spellCheck={false}
            value={text}
            // Locked while a save runs, so its answer never overwrites a later edit.
            disabled={readOnly || pending}
            onChange={(event) => setText(event.target.value)}
          />
          {parseError ? <p className="text-sm text-destructive">Not valid JSON: {parseError}</p> : null}
          <div className="flex gap-2">
            <Button type="button" variant="outline" disabled={parseError !== null || validate.isPending || pending} onClick={() => void check()}>
              Check
            </Button>
            <GuardedButton disabled={parseError !== null || pending} onClick={() => void saveConfig()}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              Save configuration
            </GuardedButton>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Delete this app</CardTitle>
          <CardDescription>Every call it makes is refused, and its keys stop working.</CardDescription>
        </CardHeader>
        <CardContent>
          <GuardedButton variant="destructive" onClick={() => setDeleting(true)}>
            <Trash2 className="size-4" />
            Delete app
          </GuardedButton>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete app"
        description={<p>This deletes <span className="font-medium text-foreground">{app.name}</span>. It cannot be undone.</p>}
        confirmLabel="Delete app"
        confirmWord={app.id}
        destructive
        pending={remove.isPending}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
