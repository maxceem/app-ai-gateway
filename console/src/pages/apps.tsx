import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AlertCircle, Check, ChevronRight } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageHeader } from "@/components/field";
import { GuardedButton } from "@/components/guarded-button";
import { MonthPicker } from "@/components/pickers";
import { StatCard } from "@/components/stat-card";
import { AppStatusBadge } from "@/components/status-badge";
import { NewAppDialog } from "@/pages/new-app-dialog";
import { AddProviderButton } from "@/pages/providers";
import { currentMonth, formatCompact, formatCost, formatNumber, totalTokens } from "@/lib/format";
import { useApp, useApps, usePrices, useProviders } from "@/lib/queries";
import { useCheckoutSuccessToast } from "@/lib/checkout-return";
import { firstRequest } from "@/lib/first-request";
import type { AppSummary } from "@/lib/types";

/** Where the Swift client walks through the first proxied request end to end. */
const QUICKSTART_URL = "https://docs.appaigateway.com/quickstart/";

/** How long the checklist waits between looks for the first proxied request. */
const FIRST_REQUEST_POLL_MS = 15_000;

/**
 * One step of the checklist: what to do, how to do it, and whether it is done.
 *
 * A finished step keeps its place and its number's position rather than folding
 * away. The list is short, and an operator returning to it should be able to
 * see what they have already done as readily as what is left — a checklist that
 * deletes its own history reads as if nothing had happened yet.
 */
function Step({
  index,
  title,
  description,
  done,
  completedLabel,
  action,
  status,
}: {
  index: number;
  title: string;
  description: React.ReactNode;
  done: boolean;
  completedLabel: string;
  action?: React.ReactNode;
  status?: React.ReactNode;
}) {
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 sm:gap-x-4">
      <span
        aria-hidden
        className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold tabular"
      >
        {index}
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className={cn("text-sm font-medium", done && "text-muted-foreground")}>
          {title}
          {/* The state in words, for anyone who cannot see the mark beside it. */}
          {done ? <span className="sr-only"> — done</span> : null}
        </p>
        <p className="text-sm text-pretty text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0 sm:pt-0.5">
        {done
          ? <span className="flex size-8 items-center justify-center text-primary" role="img" aria-label={completedLabel}><Check className="size-5" aria-hidden /></span>
          : action}
      </div>
      {status ? <div className="col-span-2 col-start-2 min-w-0">{status}</div> : null}
    </li>
  );
}

/**
 * The third step's state for as long as the card exists.
 *
 * Nothing in the console can complete it — it is finished by traffic arriving
 * from an application — so it never renders as done: the whole card goes the
 * moment the first request lands. Until then it says it is watching, which is
 * true; the list behind it is polled.
 */
function WaitingForRequest() {
  return (
    <p className="flex items-center gap-2 pt-1 text-xs text-muted-foreground" role="status" aria-label="Waiting for your first request">
      <span className="relative flex size-2" aria-hidden>
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60" />
        <span className="relative inline-flex size-2 rounded-full bg-primary" />
      </span>
      Waiting…
    </p>
  );
}

function FirstRequestExample({ app }: { app: AppSummary }) {
  const details = useApp(app.id);
  const providers = useProviders();
  const prices = usePrices();
  const ios = app.authentication_type === "apple_app_attest";
  if (details.isPending || providers.isPending || prices.isPending) return <Skeleton className="mt-4 h-32" />;
  const example = details.data && providers.data && prices.data
    ? firstRequest(details.data, providers.data.providers, prices.data.prices) : null;
  if (!example) return <p className="mt-3 text-sm text-muted-foreground">No text request example is available for this app’s current provider and model settings.</p>;
  const { provider, path, body, anthropic } = example;
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const origin = window.location.origin;
  const code = ios
    ? `import Foundation
import AppAIGateway

let gateway = AppAIGatewayClient(
    appID: ${JSON.stringify(app.id)},
    baseURL: URL(string: ${JSON.stringify(origin)})!,
    authMode: .appAttestInstall
)

var request = try await gateway.authorizedRequest(
    provider: ${JSON.stringify(provider)},
    providerPath: ${JSON.stringify(path)}
)
request.setValue("application/json", forHTTPHeaderField: "Content-Type")
${anthropic ? 'request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")\n' : ""}request.httpBody = Data(${JSON.stringify(JSON.stringify(body))}.utf8)
let (data, response) = try await URLSession.shared.data(for: request)
print(String(decoding: data, as: UTF8.self))`
    : `curl --fail-with-body ${shellQuote(`${origin}/v1/apps/${encodeURIComponent(app.id)}/proxy/${encodeURIComponent(provider)}/${path}`)} \\
  -H 'Authorization: Bearer API_KEY' \\
  -H 'Content-Type: application/json' \\
${anthropic ? "  -H 'anthropic-version: 2023-06-01' \\\n" : ""}  -d ${shellQuote(JSON.stringify(body))}`;

  return (
    <div className="mt-4 min-w-0 overflow-hidden rounded-lg border bg-muted/40">
      <pre className="overflow-x-auto p-4 text-xs leading-relaxed"><code>{code}</code></pre>
    </div>
  );
}

/**
 * The first-run checklist, shown until the organization's first request lands.
 *
 * Every step is completed from inside this card: the two that the console can
 * do open the same modals their own pages use, so setting up never means
 * leaving the page and finding the way back. Completion is read from the data
 * rather than remembered — the organization has a provider, has an app, has
 * sent traffic — so it is correct for an operator who did any of it elsewhere,
 * or who is the second person to arrive in the organization.
 */
function WelcomeCard({
  hasProvider,
  firstApp,
}: {
  hasProvider: boolean;
  firstApp?: AppSummary;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Start proxying in three steps</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <ol className="space-y-5">
          <Step
            index={1}
            title="Add a provider key"
            description="Your own OpenAI, Anthropic or Gemini key. It is encrypted on arrival and never shown again."
            done={hasProvider}
            completedLabel="Added"
            action={<AddProviderButton label="Add a provider" />}
          />
          <Step
            index={2}
            title="Create an app"
            description="One app per iOS app or backend. It decides who may call the gateway and what they may spend."
            done={!!firstApp}
            completedLabel="Created"
            action={
              <NewAppDialog trigger={<GuardedButton size="sm">Create an app</GuardedButton>} />
            }
          />
          <Step
            index={3}
            title="Send your first request"
            description={firstApp?.authentication_type === "api_key"
              ? <>Replace <code>API_KEY</code> with <Link className="text-primary-ink underline underline-offset-4" to={`/apps/${encodeURIComponent(firstApp.id)}/auth/identity`}>your API key</Link>.</>
              : "Run this example in your iOS app using the AppAIGateway Swift package."}
            done={false}
            completedLabel="Received"
            status={hasProvider && firstApp ? <FirstRequestExample app={firstApp} /> : undefined}
            action={
              hasProvider && firstApp ? <WaitingForRequest /> : <Button asChild size="sm" variant="outline">
                <a href={QUICKSTART_URL} target="_blank" rel="noopener">
                  Quickstart
                </a>
              </Button>
            }
          />
        </ol>

      </CardContent>
    </Card>
  );
}

export function AppsPage() {
  const [month, setMonth] = useState(currentMonth());
  // The landing a completed checkout returns to, so the purchase is confirmed
  // somewhere rather than only implied by a plan that quietly changed.
  useCheckoutSuccessToast();
  /*
   * The checklist retires on the organization's first proxied request, which is
   * reported by this list and which nothing on this page can cause. So while it
   * is up the list is polled: the operator's next act is to run their app, and
   * coming back to a console that still says "waiting" would suggest the
   * request never arrived.
   *
   * Read from the previous render's data, so the poll stops on the same answer
   * that retires the card.
   */
  const waiting = useRef(false);
  const apps = useApps(month, waiting.current ? FIRST_REQUEST_POLL_MS : undefined);
  // Step one's own state, and the only query this page adds. The add-provider
  // modal invalidates the same key, so finishing that step ticks it here.
  const providers = useProviders();

  /*
   * Shown until the organization has ever proxied a request, whether or not it
   * has apps yet — an app that has never served anything is a setup half done,
   * not a working deployment. `has_proxied_requests` is month-independent and
   * never returns to false, so this cannot come back on the first of a month or
   * after a quiet one.
   */
  const firstRun = apps.isSuccess && !apps.data.has_proxied_requests;
  waiting.current = firstRun;
  const hasApps = (apps.data?.apps.length ?? 0) > 0;

  const totals = (apps.data?.apps ?? []).reduce(
    (accumulator, app) => ({
      requests: accumulator.requests + app.usage.requests,
      tokens: accumulator.tokens + totalTokens(app.usage),
      cost: accumulator.cost + app.usage.cost_usd,
      users: accumulator.users + app.users.total,
      errors: accumulator.errors + app.usage.errors,
    }),
    { requests: 0, tokens: 0, cost: 0, users: 0, errors: 0 },
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Apps"
        action={
          <>
            <MonthPicker value={month} onChange={setMonth} />
            <NewAppDialog />
          </>
        }
      />

      {apps.isError ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Could not load apps</AlertTitle>
          <AlertDescription>
            {apps.error instanceof Error ? apps.error.message : "Unknown error"}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Spend"
          value={apps.isPending ? <Skeleton className="h-6 w-20" /> : formatCost(totals.cost)}
          detail="month to date"
        />
        <StatCard
          label="Users"
          value={apps.isPending ? <Skeleton className="h-6 w-12" /> : formatNumber(totals.users)}
          detail={`${apps.data?.apps.length ?? 0} apps`}
        />
        <StatCard
          label="Requests"
          value={apps.isPending ? <Skeleton className="h-6 w-16" /> : formatNumber(totals.requests)}
          detail={totals.errors > 0 ? `${formatNumber(totals.errors)} provider errors` : "month to date"}
        />
        <StatCard
          label="Tokens"
          value={apps.isPending ? <Skeleton className="h-6 w-16" /> : formatCompact(totals.tokens)}
          detail="all buckets"
        />
      </div>

      {/* Kept while the list is loading so the skeleton rows still stand in for
          it, and dropped only for an organization that genuinely has no apps —
          which is a state the checklist below already speaks to. */}
      {apps.isPending || hasApps ? (
        <Card className="overflow-hidden py-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>App</TableHead>
                {/* The order the cards above read in, so a column and its total
                    are found in the same place. */}
                <TableHead className="text-right">Budget</TableHead>
                <TableHead className="text-right">Users</TableHead>
                <TableHead className="text-right">Requests</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {apps.isPending ? (
                [0, 1, 2].map((row) => (
                  <TableRow key={row}>
                    <TableCell colSpan={6}>
                      <Skeleton className="h-8 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                apps.data?.apps.map((app) => (
                  // h-13 is what a row of the console's other tables comes to:
                  // an icon-sm actions button between the cells' own padding.
                  // This one holds a single line of text, and without a floor it
                  // would sit noticeably shorter than every list beside it.
                  <TableRow key={app.id} className="group relative h-13">
                    <TableCell>
                      {/* The name is the row's only link, stretched over the
                          cells beside it so the whole row opens the app while
                          the row keeps one focus stop and a real href. */}
                      <Link
                        to={`/apps/${app.id}/overview`}
                        className="block after:absolute after:inset-0 after:content-['']"
                      >
                        <div className="flex items-center gap-2 font-medium">
                          {app.name}
                          <AppStatusBadge status={app.status} />
                        </div>
                      </Link>
                    </TableCell>
                    <TableCell className="tabular text-right">
                      {formatCost(app.usage.cost_usd)}
                      <span className="text-muted-foreground">
                        {" / "}
                        {app.monthly_budget_usd === null ? (
                          // No budget is set, so there is nothing to spend
                          // against — the sign says so without a number.
                          <span title="No monthly budget">&#8734;</span>
                        ) : (
                          formatCost(app.monthly_budget_usd)
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="tabular text-right">
                      {formatNumber(app.users.total)}
                      {app.users.blocked > 0 ? (
                        <span className="block text-[11px] text-destructive">
                          {app.users.blocked} blocked
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="tabular text-right">
                      {formatNumber(app.usage.requests)}
                      {app.usage.errors > 0 ? (
                        <span className="block text-[11px] text-amber-600 dark:text-amber-400">
                          {app.usage.errors} errors
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="tabular text-right">
                      {formatCompact(totalTokens(app.usage))}
                    </TableCell>
                    <TableCell>
                      <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </Card>
      ) : null}
      {firstRun ? (
        <WelcomeCard
          hasProvider={(providers.data?.providers.length ?? 0) > 0}
          firstApp={apps.data?.apps.reduce<AppSummary | undefined>((first, app) =>
            !first || app.created_at < first.created_at ? app : first, undefined)}
        />
      ) : null}
    </div>
  );
}
