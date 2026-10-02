import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertCircle, ChevronRight } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
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
import { MonthPicker } from "@/components/pickers";
import { StatCard } from "@/components/stat-card";
import { DEFAULT_APP_SECTION } from "@/lib/app-sections";
import { AppStatusBadge } from "@/components/status-badge";
import { BudgetCell } from "@/components/budget";
import { NewAppDialog } from "@/pages/new-app-dialog";
import { currentMonth, formatCompact, formatCost, formatNumber, totalTokens } from "@/lib/format";
import { useApps } from "@/lib/queries";
import { useCheckoutSuccessToast } from "@/lib/checkout-return";
import { noteProxiedRequests } from "@/lib/analytics";
import { useConsoleSession } from "@/lib/console-session";

/**
 * What the list says when there is nothing in it. Setup as a whole is walked
 * through in the rail; this only names the one thing this page is for and
 * offers the same modal the header does, so the page is never a heading over
 * a blank.
 */
function NoApps() {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <div className="space-y-1">
          <p className="text-sm font-medium">No apps yet</p>
          <p className="text-sm text-pretty text-muted-foreground">
            One app per iOS app or backend. It decides who may call the gateway and what they may spend.
          </p>
        </div>
        {/* The header's own control, repeated where the eye lands: one name
            for one action, wherever it is offered. */}
        <NewAppDialog />
      </CardContent>
    </Card>
  );
}

export function AppsPage() {
  const [month, setMonth] = useState(currentMonth());
  // The landing a completed checkout returns to, so the purchase is confirmed
  // somewhere rather than only implied by a plan that quietly changed.
  useCheckoutSuccessToast();
  const apps = useApps(month);

  /*
   * Whether the organization has ever proxied a request is what the hosted
   * deployment counts as activation, so it is reported from the page that
   * already asks for it rather than from a reading of its own. The rail's
   * first-run checklist polls the same list while it waits for that answer, so
   * this sees it arrive without a poll of its own.
   */
  const { organization } = useConsoleSession();
  const organizationId = organization?.id;
  const proxied = apps.data?.has_proxied_requests;
  useEffect(() => {
    if (organizationId === undefined || proxied === undefined) return;
    noteProxiedRequests(organizationId, proxied);
  }, [organizationId, proxied]);
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
          it, and replaced only for an organization that genuinely has no apps. */}
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
                        to={`/apps/${app.id}/${DEFAULT_APP_SECTION}`}
                        className="block after:absolute after:inset-0 after:content-['']"
                      >
                        <div className="flex items-center gap-2 font-medium">
                          {app.name}
                          <AppStatusBadge status={app.status} />
                        </div>
                      </Link>
                    </TableCell>
                    <TableCell className="tabular text-right">
                      {/* The whole app against the budget set for it. */}
                      <BudgetCell
                        spent={app.usage.cost_usd}
                        budget={app.monthly_budget_usd}
                      />
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
      ) : apps.isSuccess ? (
        <NoApps />
      ) : null}
    </div>
  );
}
