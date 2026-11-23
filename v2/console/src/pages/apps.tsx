import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AlertCircle, Plus } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AppAttestFields,
  IdentityProviderFields,
  SubscriptionFields,
  UserSourceFields,
  authIssues,
  issueAt,
  type AuthDraft,
  type AuthIssues,
} from "@/components/auth-fields";
import { ChoiceList, type Choice } from "@/components/choice-list";
import { Field, PageHeader } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { GuardedButton } from "@/components/guarded-button";
import { RelativeTime } from "@/components/relative-time";
import { SecretRevealDialog } from "@/components/secret-reveal-dialog";
import { MonthPicker } from "@/components/pickers";
import { StatCard } from "@/components/stat-card";
import { currentMonth, formatCompact, formatCost, formatNumber, totalTokens } from "@/lib/format";
import { useAccountUsage, useApps, useCreateApp } from "@/lib/queries";
import type { App, CreatedApp } from "@/lib/types";

/** What kind of app it is, as a person reads it. */
export function appKind(app: App): string {
  return app.config.authentication.type === "apple_app_attest" ? "iOS (App Attest)" : "Server (app key)";
}

export function AppsPage() {
  const apps = useApps();
  const [creating, setCreating] = useState(false);
  const [month, setMonth] = useState(currentMonth());
  // The account's month, as v1's app list showed it: totals over every app,
  // deleted ones included (their usage is kept), and a line per app.
  const usage = useAccountUsage(month);
  const list = apps.data?.apps ?? [];
  // Only a read that succeeded is shown: after a failed refresh the query keeps its old data,
  // and no figure, line or detail may show it under an error.
  const shown = usage.isSuccess ? usage.data : undefined;
  const usageOf = new Map((shown?.apps ?? []).map((line) => [line.app_id, line]));
  const totals = shown?.totals;
  const deleted = (shown?.apps ?? []).filter((line) => line.deleted).length;
  const figure = (value: string) => (usage.isPending ? <Skeleton className="h-6 w-16" /> : usage.isError ? "—" : value);
  const detail = (text: string) => (usage.isSuccess ? text : usage.isError ? "unavailable" : undefined);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Apps"
        description="Each app calls AI providers through this gateway, with its own sign-in, providers and limits."
        action={
          <>
            <MonthPicker value={month} onChange={setMonth} />
            <GuardedButton size="sm" onClick={() => setCreating(true)}>
              <Plus className="size-4" />
              New app
            </GuardedButton>
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Spend"
          value={figure(formatCost(totals?.cost_usd))}
          detail={detail(deleted > 0 ? `includes ${formatNumber(deleted)} deleted ${deleted === 1 ? "app" : "apps"}` : "all your apps")}
        />
        <StatCard
          label="Charges"
          value={figure(formatNumber(totals?.charges))}
          detail={detail(totals && totals.failed > 0 ? `${formatNumber(totals.failed)} failed` : "calls, session slices and job estimates")}
        />
        <StatCard label="Tokens" value={figure(formatCompact(totals ? totalTokens(totals) : null))} detail={detail("all buckets")} />
        <StatCard
          label="Unpriced"
          value={figure(formatNumber(totals?.unpriced))}
          detail={detail("charges still without a price, counted as $0")}
        />
      </div>

      {apps.isError ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Could not load apps</AlertTitle>
          <AlertDescription>{apps.error instanceof Error ? apps.error.message : "Unknown error"}</AlertDescription>
        </Alert>
      ) : null}

      <Card className="overflow-hidden py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Providers</TableHead>
              <TableHead className="text-right">Charges</TableHead>
              <TableHead className="text-right">Spend</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {apps.isPending ? (
              [0, 1].map((row) => (
                <TableRow key={row}>
                  <TableCell colSpan={7}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : list.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                  No apps yet. Create one to get started.
                </TableCell>
              </TableRow>
            ) : (
              list.map((app) => (
                <TableRow key={app.id}>
                  <TableCell>
                    <Link to={`/apps/${encodeURIComponent(app.id)}`} className="font-medium underline-offset-4 hover:underline">
                      {app.name}
                    </Link>
                    <p className="font-mono text-xs text-muted-foreground">{app.id}</p>
                  </TableCell>
                  <TableCell>{appKind(app)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {Object.keys(app.config.routing.providers).join(", ") || "None yet"}
                  </TableCell>
                  <TableCell className="tabular text-right">
                    {usage.isSuccess ? formatNumber(usageOf.get(app.id)?.charges ?? 0) : "—"}
                    {(usageOf.get(app.id)?.failed ?? 0) > 0 ? (
                      <span className="block text-[11px] text-amber-600 dark:text-amber-400">{formatNumber(usageOf.get(app.id)?.failed)} failed</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="tabular text-right">
                    {usage.isSuccess ? formatCost(usageOf.get(app.id)?.cost_usd ?? 0) : "—"}
                    {/* So an app whose charges are all unpriced does not just read $0.00. */}
                    {(usageOf.get(app.id)?.unpriced ?? 0) > 0 ? (
                      <span className="block text-[11px] text-amber-600 dark:text-amber-400">{formatNumber(usageOf.get(app.id)?.unpriced)} unpriced</span>
                    ) : null}
                  </TableCell>
                  <TableCell>{app.status === "active" ? "On" : <span className="text-muted-foreground">Off</span>}</TableCell>
                  <TableCell className="text-muted-foreground">
                    <RelativeTime value={app.updated_at} />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      <NewAppDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

type Kind = "ios" | "server";

const KINDS: Choice<Kind>[] = [
  {
    value: "ios",
    label: "iOS app",
    description: "Calls come straight from the app. Apple's App Attest proves each call comes from your real app.",
  },
  {
    value: "server",
    label: "Server",
    description: "Calls come from your own server, with an app key it keeps secret.",
  },
];

/** The sign-in a new app of each kind starts from; who may call is asked before it is used. */
function startingAuth(kind: Kind): AuthDraft {
  return kind === "ios"
    ? { type: "apple_app_attest", end_user: { source: "app_install" }, app_attest: { team_id: "", bundle_id: "" } }
    : { type: "api_key", end_user: { source: "none" } };
}

/** The first settings of a new app: its sign-in as answered, trimmed, and nothing else yet. */
export function newAppConfig(authentication: AuthDraft): { authentication: AuthDraft } {
  const endUser = authentication.end_user.source === "header"
    ? { source: "header" as const, header: authentication.end_user.header.trim() }
    : authentication.end_user;
  if (authentication.type === "apple_app_attest") {
    const { team_id, bundle_id } = authentication.app_attest;
    return {
      authentication: {
        ...authentication,
        end_user: endUser,
        app_attest: { ...authentication.app_attest, team_id: team_id.trim(), bundle_id: bundle_id.trim() },
      },
    };
  }
  return { authentication: { ...authentication, end_user: endUser } };
}

type StepId = "basics" | "identity" | "users" | "provider" | "paid";

const STEP_TITLES: Record<StepId, string> = {
  basics: "Name and kind",
  identity: "How the app proves itself",
  users: "Who may call",
  provider: "Identity provider",
  paid: "Paid users only",
};

/** Whether a step's own answers are complete: judged by the problems under its part only. */
function stepDone(step: StepId, name: string, answered: boolean, issues: AuthIssues): boolean {
  switch (step) {
    case "basics":
      return name.trim() !== "";
    case "identity":
      return issueAt(issues, "app_attest") === undefined;
    case "users":
      return answered && issueAt(issues, "end_user.header") === undefined;
    case "provider":
      return (["preset", "jwks_url", "issuer", "audience"] as const).every((field) => issueAt(issues, `end_user.issuer.${field}`) === undefined);
    case "paid":
      return issues.size === 0;
  }
}

/**
 * Creating an app, one question at a time, as v1's wizard asked it: its name
 * and kind, how an iOS app proves itself, who may call, and for signed-in
 * users, where they sign in and whether they must have paid. The same fields
 * as the app's Sign-in tab, which changes any answer later.
 */
function NewAppDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const create = useCreateApp();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>("ios");
  const [auth, setAuth] = useState<AuthDraft>(() => startingAuth("ios"));
  // Who may call has no default answer: the person chooses, as v1 asked it.
  const [answered, setAnswered] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [created, setCreated] = useState<CreatedApp | null>(null);

  const issuer = answered && auth.end_user.source === "issuer";
  const steps: StepId[] = ["basics", ...(kind === "ios" ? (["identity"] as const) : []), "users", ...(issuer ? (["provider", "paid"] as const) : [])];
  const step = steps[Math.min(stepIndex, steps.length - 1)]!;
  const last = stepIndex >= steps.length - 1;
  const issues = authIssues(auth);
  const done = stepDone(step, name, answered, issues);

  const reset = () => {
    setName("");
    setKind("ios");
    setAuth(startingAuth("ios"));
    setAnswered(false);
    setStepIndex(0);
  };

  const open_ = (app: CreatedApp) => void navigate(`/apps/${encodeURIComponent(app.app.id)}`);

  const submit = async () => {
    try {
      const result = await create.mutateAsync({ name: name.trim(), config: newAppConfig(auth) });
      reset();
      onOpenChange(false);
      toast.success("App created");
      // A server app's first key is in the answer, shown once before moving on.
      if (result.api_key) setCreated(result);
      else open_(result);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create the app");
    }
  };

  return (
    <>
      <FormDialog
        open={open}
        onOpenChange={(next) => {
          if (!next) reset();
          onOpenChange(next);
        }}
        title="Create an app"
        description={`Step ${stepIndex + 1} of ${steps.length}: ${STEP_TITLES[step]}`}
        submitLabel={last ? "Create app" : "Next"}
        pending={create.isPending}
        disabled={!done}
        className="sm:max-w-lg"
        secondaryAction={
          stepIndex > 0 ? (
            <Button type="button" variant="ghost" className="sm:mr-auto" onClick={() => setStepIndex(stepIndex - 1)}>
              Back
            </Button>
          ) : null
        }
        onSubmit={() => (last ? void submit() : setStepIndex(stepIndex + 1))}
      >
        {step === "basics" ? (
          <>
            <Field label="Name" htmlFor="app-name">
              <Input id="app-name" value={name} maxLength={100} autoFocus autoComplete="off" onChange={(event) => setName(event.target.value)} />
            </Field>
            <div className="space-y-1">
              <p className="text-sm font-medium">Where do calls come from?</p>
              <ChoiceList
                label="App kind"
                choices={KINDS}
                value={kind}
                onChange={(next) => {
                  if (next === kind) return;
                  setKind(next);
                  setAuth(startingAuth(next));
                  setAnswered(false);
                }}
              />
            </div>
          </>
        ) : null}
        {step === "identity" && auth.type === "apple_app_attest" ? (
          <AppAttestFields value={auth.app_attest} issues={issues} withVerifyOn={false} onChange={(app_attest) => setAuth({ ...auth, app_attest })} />
        ) : null}
        {step === "users" ? (
          <UserSourceFields
            type={auth.type}
            value={answered ? auth.end_user : null}
            issues={issues}
            onChange={(end_user) => {
              setAnswered(true);
              setAuth({ ...auth, end_user } as AuthDraft);
            }}
          />
        ) : null}
        {step === "provider" && auth.end_user.source === "issuer" ? (
          <IdentityProviderFields
            issuer={auth.end_user.issuer}
            issues={issues}
            onChange={(next) => setAuth({ ...auth, end_user: { source: "issuer", issuer: next } } as AuthDraft)}
          />
        ) : null}
        {step === "paid" && auth.end_user.source === "issuer" ? (
          <SubscriptionFields
            issuer={auth.end_user.issuer}
            issues={issues}
            onChange={(next) => setAuth({ ...auth, end_user: { source: "issuer", issuer: next } } as AuthDraft)}
          />
        ) : null}
      </FormDialog>

      <SecretRevealDialog
        open={created !== null}
        title="Copy your app key now"
        description={
          <>
            Your server sends this key with every call. This is the only time it is shown: the gateway stores
            only a hash.
          </>
        }
        label="App key"
        secret={created?.api_key?.key ?? ""}
        onAcknowledge={() => {
          const app = created;
          setCreated(null);
          create.reset();
          if (app) open_(app);
        }}
      />
    </>
  );
}
