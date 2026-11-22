import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AlertCircle, Plus } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
  const usageOf = new Map((usage.data?.apps ?? []).map((line) => [line.app_id, line]));
  const totals = usage.data?.totals;
  const deleted = (usage.data?.apps ?? []).filter((line) => line.deleted).length;
  const figure = (value: string) => (usage.isPending ? <Skeleton className="h-6 w-16" /> : usage.isError ? "—" : value);

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
          detail={deleted > 0 ? `includes ${formatNumber(deleted)} deleted ${deleted === 1 ? "app" : "apps"}` : "all your apps"}
        />
        <StatCard
          label="Charges"
          value={figure(formatNumber(totals?.charges))}
          detail={totals && totals.failed > 0 ? `${formatNumber(totals.failed)} failed` : "calls, session slices and job estimates"}
        />
        <StatCard label="Tokens" value={figure(formatCompact(totals ? totalTokens(totals) : null))} detail="all buckets" />
        <StatCard
          label="Unpriced"
          value={figure(formatNumber(totals?.unpriced))}
          detail="charges still without a price, counted as $0"
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

const TEAM_ID = /^[A-Z0-9]{10}$/u;
const BUNDLE_ID = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u;
const HEADER = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u;

/** The first settings of a new app: its sign-in, and nothing else yet. */
export function newAppConfig(input: {
  kind: Kind;
  teamId: string;
  bundleId: string;
  userHeader: string;
}): Record<string, unknown> {
  if (input.kind === "ios") {
    return {
      authentication: {
        type: "apple_app_attest",
        end_user: { source: "app_install" },
        app_attest: { team_id: input.teamId.trim(), bundle_id: input.bundleId.trim() },
      },
    };
  }
  const header = input.userHeader.trim();
  return {
    authentication: {
      type: "api_key",
      end_user: header ? { source: "header", header } : { source: "none" },
    },
  };
}

function NewAppDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const create = useCreateApp();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>("ios");
  const [teamId, setTeamId] = useState("");
  const [bundleId, setBundleId] = useState("");
  const [userHeader, setUserHeader] = useState("");
  const [created, setCreated] = useState<CreatedApp | null>(null);

  const teamInvalid = teamId !== "" && !TEAM_ID.test(teamId.trim());
  const bundleInvalid = bundleId !== "" && !BUNDLE_ID.test(bundleId.trim());
  const headerInvalid = userHeader !== "" && !HEADER.test(userHeader.trim());
  const ready =
    name.trim() !== "" &&
    (kind === "ios" ? TEAM_ID.test(teamId.trim()) && BUNDLE_ID.test(bundleId.trim()) : !headerInvalid);

  const reset = () => {
    setName("");
    setKind("ios");
    setTeamId("");
    setBundleId("");
    setUserHeader("");
  };

  const open_ = (app: CreatedApp) => void navigate(`/apps/${encodeURIComponent(app.app.id)}`);

  const submit = async () => {
    try {
      const result = await create.mutateAsync({ name: name.trim(), config: newAppConfig({ kind, teamId, bundleId, userHeader }) });
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
        submitLabel="Create app"
        pending={create.isPending}
        disabled={!ready}
        onSubmit={() => void submit()}
      >
        <Field label="Name" htmlFor="app-name">
          <Input id="app-name" value={name} maxLength={100} autoFocus autoComplete="off" onChange={(event) => setName(event.target.value)} />
        </Field>
        <div className="space-y-1">
          <p className="text-sm font-medium">Where do calls come from?</p>
          <ChoiceList label="App kind" choices={KINDS} value={kind} onChange={setKind} />
        </div>
        {kind === "ios" ? (
          <>
            <Field label="Apple Team ID" htmlFor="app-team" hint="Ten letters and digits, from your Apple developer account.">
              <Input
                id="app-team"
                value={teamId}
                autoComplete="off"
                aria-invalid={teamInvalid || undefined}
                onChange={(event) => setTeamId(event.target.value.toUpperCase())}
              />
            </Field>
            <Field label="Bundle ID" htmlFor="app-bundle" hint="Such as com.example.app.">
              <Input
                id="app-bundle"
                value={bundleId}
                autoComplete="off"
                aria-invalid={bundleInvalid || undefined}
                onChange={(event) => setBundleId(event.target.value)}
              />
            </Field>
          </>
        ) : (
          <Field
            label="End user header (optional)"
            htmlFor="app-user-header"
            hint="The header your server sends each user's id in, so limits can apply per user. Leave it empty if there are no end users."
          >
            <Input
              id="app-user-header"
              value={userHeader}
              placeholder="x-end-user-id"
              autoComplete="off"
              aria-invalid={headerInvalid || undefined}
              onChange={(event) => setUserHeader(event.target.value)}
            />
          </Field>
        )}
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
