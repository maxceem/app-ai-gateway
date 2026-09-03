import { useState } from "react";
import { Link } from "react-router-dom";
import { AlertCircle, ChevronRight } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
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
import { AppStatusBadge } from "@/components/status-badge";
import { NewAppDialog } from "@/pages/new-app-dialog";
import { currentMonth, formatCompact, formatCost, formatNumber, totalTokens } from "@/lib/format";
import { useApps } from "@/lib/queries";

export function AppsPage() {
  const [month, setMonth] = useState(currentMonth());
  const apps = useApps(month);

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
            <NewAppDialog existingIds={apps.data?.apps.map((app) => app.id) ?? []} />
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
          label="Requests"
          value={apps.isPending ? <Skeleton className="h-6 w-16" /> : formatNumber(totals.requests)}
          detail={totals.errors > 0 ? `${formatNumber(totals.errors)} provider errors` : "month to date"}
        />
        <StatCard
          label="Tokens"
          value={apps.isPending ? <Skeleton className="h-6 w-16" /> : formatCompact(totals.tokens)}
          detail="all buckets"
        />
        <StatCard
          label="Users"
          value={apps.isPending ? <Skeleton className="h-6 w-12" /> : formatNumber(totals.users)}
          detail={`${apps.data?.apps.length ?? 0} apps`}
        />
      </div>

      <Card className="overflow-hidden py-0">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>App</TableHead>
              <TableHead className="text-right">Users</TableHead>
              <TableHead className="text-right">Requests</TableHead>
              <TableHead className="text-right">Tokens</TableHead>
              <TableHead className="text-right">Cost</TableHead>
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
            ) : apps.data?.apps.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                  No apps yet. Create one to start proxying requests.
                </TableCell>
              </TableRow>
            ) : (
              apps.data?.apps.map((app) => (
                <TableRow key={app.id} className="group">
                  <TableCell>
                    <Link to={`/apps/${app.id}/overview`} className="block">
                      <div className="flex items-center gap-2 font-medium">
                        {app.name}
                        <AppStatusBadge status={app.status} />
                      </div>
                      <span className="font-mono text-xs text-muted-foreground">{app.id}</span>
                    </Link>
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
                  <TableCell className="tabular text-right">{formatCost(app.usage.cost_usd)}</TableCell>
                  <TableCell>
                    <Link to={`/apps/${app.id}/overview`} aria-label={`Open ${app.name}`}>
                      <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                    </Link>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
