import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState, SectionHeader } from "@/components/field";
import { RangePicker } from "@/components/pickers";
import { StatCard } from "@/components/stat-card";
import { AuthOutcomeBadge } from "@/components/status-badge";
import { formatDateTime, formatNumber, formatPercent } from "@/lib/format";
import { useAuthEventSummary, useAuthEvents } from "@/lib/queries";
import type { AuthEventSummary } from "@/lib/types";

/** A duration a person reads at a glance: seconds under a minute, else minutes. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

export interface OutcomeRow {
  outcome: string;
  reason: string | null;
  total: number;
  /** One entry per distinct day the failure occurred on, ascending. */
  days: { date: string; count: number }[];
}

/**
 * Collapses the per-day, per-reason buckets into one row per distinct failure.
 *
 * `ok` is dropped: the success rate above already says how much of the window
 * succeeded, and leaving the healthy majority in the table buries the handful
 * of rows the operator opened this view to find.
 *
 * Days are merged, not appended. The API groups by event as well as by outcome
 * and reason, so a day on which both a token exchange and a registration failed
 * the same way arrives as two buckets — appending them would let "Days
 * affected" exceed the number of days in the window, and would split one day's
 * count across two entries.
 */
export function foldOutcomes(summary: AuthEventSummary | undefined): OutcomeRow[] {
  const rows = new Map<
    string,
    { outcome: string; reason: string | null; days: Map<string, number> }
  >();
  const add = (
    key: string,
    outcome: string,
    reason: string | null,
    date: string,
    count: number,
  ): void => {
    const row = rows.get(key) ?? { outcome, reason, days: new Map<string, number>() };
    row.days.set(date, (row.days.get(date) ?? 0) + count);
    rows.set(key, row);
  };

  for (const bucket of summary?.daily ?? []) {
    if (bucket.outcome === "ok") continue;
    add(
      `auth:${bucket.outcome}:${bucket.reason ?? ""}`,
      bucket.outcome,
      bucket.reason,
      bucket.date,
      bucket.count,
    );
  }
  for (const bucket of summary?.usage_failures ?? []) {
    add(`proxy:${bucket.status}`, bucket.status, "proxied request", bucket.date, bucket.count);
  }

  return [...rows.values()]
    .map((row): OutcomeRow => ({
      outcome: row.outcome,
      reason: row.reason,
      total: [...row.days.values()].reduce((sum, count) => sum + count, 0),
      days: [...row.days.entries()]
        .map(([date, count]) => ({ date, count }))
        .sort((left, right) => (left.date < right.date ? -1 : left.date > right.date ? 1 : 0)),
    }))
    .sort(
      (left, right) =>
        right.total - left.total
        || (left.outcome < right.outcome ? -1 : left.outcome > right.outcome ? 1 : 0),
    );
}

const OUTCOME_FILTERS = [
  "issuer_claims_missing",
  "issuer_token_rejected",
  "issuer_verification_unavailable",
  "attest_failed",
  "auth_required",
  "ok",
] as const;

export function AuthEventsTab({ appId }: { appId: string }) {
  const [days, setDays] = useState("30");
  const [outcome, setOutcome] = useState<string>("all");
  const [cursors, setCursors] = useState<number[]>([]);

  const summary = useAuthEventSummary(appId, Number(days));
  const events = useAuthEvents(appId, {
    limit: 25,
    outcome: outcome === "all" ? undefined : outcome,
    before_id: cursors.at(-1),
  });

  const outcomes = useMemo(() => foldOutcomes(summary.data), [summary.data]);
  const claimDelay = summary.data?.claim_delay;
  const pending = summary.data?.pending_users ?? 0;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Exchange success"
          value={formatPercent(summary.data?.token_exchange.success_rate)}
          detail={`${formatNumber(summary.data?.token_exchange.total ?? 0)} attempts`}
        />
        <StatCard
          label="Claim delay p50"
          value={formatDuration(claimDelay?.p50_ms)}
          detail={`${formatNumber(claimDelay?.count ?? 0)} measured`}
        />
        <StatCard
          label="Claim delay p95"
          value={formatDuration(claimDelay?.p95_ms)}
          detail={`avg ${formatDuration(claimDelay?.avg_ms)}`}
        />
        <StatCard
          label="Pending activations"
          value={formatNumber(pending)}
          // The only figure here that is about right now rather than the window:
          // these users are waiting on an entitlement claim as you read this.
          detail={pending > 0 ? "waiting on a claim now" : "none waiting"}
        />
      </div>

      <Card className="py-0">
        <CardHeader className="pt-6">
          <SectionHeader
            title="Failures by cause"
            description="Refused authentication attempts and non-ok proxied requests, busiest first."
            action={<RangePicker value={days} onChange={setDays} />}
          />
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {summary.isPending ? (
            <div className="px-6 pb-6">
              <Skeleton className="h-24 w-full" />
            </div>
          ) : outcomes.length === 0 ? (
            <div className="px-6 pb-6">
              <EmptyState>No failed requests in this range.</EmptyState>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Outcome</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead className="text-right">Count</TableHead>
                  <TableHead className="text-right">Days affected</TableHead>
                  <TableHead>Last seen</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {outcomes.map((row) => (
                  <TableRow key={`${row.outcome}-${row.reason ?? ""}`}>
                    <TableCell>
                      <AuthOutcomeBadge outcome={row.outcome} />
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {row.reason ?? "—"}
                    </TableCell>
                    <TableCell className="tabular text-right">{formatNumber(row.total)}</TableCell>
                    <TableCell className="tabular text-right">{formatNumber(row.days.length)}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                      {/* `days` is already ascending, so the last entry is the
                          most recent day this cause was seen. */}
                      {row.days.at(-1)?.date ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card className="py-0">
        <CardHeader className="pt-6">
          <SectionHeader
            title="Recent attempts"
            description="Every token exchange and key registration, newest first."
            action={
              <Select
                value={outcome}
                onValueChange={(next) => {
                  setOutcome(next);
                  setCursors([]);
                }}
              >
                <SelectTrigger className="w-[210px]" size="sm" aria-label="Outcome">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All outcomes</SelectItem>
                  {OUTCOME_FILTERS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>When</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Call</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>App version</TableHead>
                <TableHead className="text-right">Latency</TableHead>
                <TableHead className="text-right">Claim delay</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.isPending ? (
                <TableRow>
                  <TableCell colSpan={8}>
                    <Skeleton className="h-8 w-full" />
                  </TableCell>
                </TableRow>
              ) : events.data?.events.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">
                    No attempts.
                  </TableCell>
                </TableRow>
              ) : (
                events.data?.events.map((event) => (
                  <TableRow key={event.id}>
                    <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                      {formatDateTime(event.created_at)}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {/* Absent whenever the attempt never got far enough to
                          establish an identity, which is most refusals. */}
                      {event.user_id ?? <span className="text-muted-foreground">unknown</span>}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {event.event}
                      {event.auth_method ? (
                        <span className="block">{event.auth_method}</span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <AuthOutcomeBadge outcome={event.outcome} />
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {event.reason ?? "—"}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {event.app_version ?? "—"}
                    </TableCell>
                    <TableCell className="tabular text-right text-xs">
                      {event.latency_ms === null ? "—" : `${formatNumber(event.latency_ms)} ms`}
                    </TableCell>
                    <TableCell className="tabular text-right text-xs">
                      {/* Only the exchange that ended a wait carries one, so a
                          value here marks the moment a user was unblocked. */}
                      {event.claim_delay_ms === null ? (
                        "—"
                      ) : (
                        <span
                          className="text-amber-600 dark:text-amber-400"
                          title="This exchange ended a wait for an entitlement claim to propagate."
                        >
                          {formatDuration(event.claim_delay_ms)}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          <div className="flex items-center justify-end gap-2 border-t px-6 py-3">
            <Button
              variant="outline"
              size="sm"
              disabled={cursors.length === 0}
              onClick={() => setCursors((current) => current.slice(0, -1))}
            >
              Newer
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!events.data?.next_before_id}
              onClick={() =>
                setCursors((current) => [...current, events.data!.next_before_id as number])
              }
            >
              Older
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
