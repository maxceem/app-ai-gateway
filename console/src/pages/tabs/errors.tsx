import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { foldOutcomes } from "@/lib/auth-events";
import { formatDateTime, formatDuration, formatNumber, formatPercent } from "@/lib/format";
import { useAuthEventSummary, useAuthEvents, useRejectionEvents } from "@/lib/queries";
import { REJECTION_REASONS, REJECTION_SCOPES } from "@shared/rejection-reasons";

const OUTCOME_FILTERS = [
  "issuer_claims_missing",
  "issuer_token_rejected",
  "issuer_verification_unavailable",
  "attest_failed",
  "auth_required",
  "ok",
] as const;

export function ErrorsTab({ appId }: { appId: string }) {
  const [days, setDays] = useState("30");
  const [outcome, setOutcome] = useState<string>("all");
  const [cursors, setCursors] = useState<number[]>([]);
  const [rejectionReason, setRejectionReason] = useState("all");
  const [rejectionScope, setRejectionScope] = useState("all");
  const [rejectionUser, setRejectionUser] = useState("");
  const [rejectionCursors, setRejectionCursors] = useState<number[]>([]);

  const summary = useAuthEventSummary(appId, Number(days));
  const events = useAuthEvents(appId, {
    limit: 25,
    outcome: outcome === "all" ? undefined : outcome,
    before_id: cursors.at(-1),
  });
  const rejections = useRejectionEvents(appId, {
    limit: 25,
    reason: REJECTION_REASONS.find((value) => value === rejectionReason),
    scope: REJECTION_SCOPES.find((value) => value === rejectionScope),
    user: rejectionUser || undefined,
    before_id: rejectionCursors.at(-1),
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
            description="Authentication failures, provider errors, and sampled pre-provider refusals, busiest first. Sample counts are not exact request totals."
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
                  <TableRow key={`${row.outcome}-${row.reason ?? ""}-${row.sampled}`}>
                    <TableCell>
                      <AuthOutcomeBadge outcome={row.outcome} />
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {row.reason ?? "—"}
                    </TableCell>
                    <TableCell className="tabular text-right">
                      {formatNumber(row.total)}
                      {row.sampled ? (
                        <span className="ml-1 text-xs text-muted-foreground">
                          {row.total === 1 ? "sample" : "samples"}
                        </span>
                      ) : null}
                    </TableCell>
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
            title="Recent refusal samples"
            description="Requests stopped before a provider call. At most one sample per identity per minute; this is diagnostic history, not an exact count."
          />
          <div className="flex flex-wrap gap-2 pt-3">
            <Select
              value={rejectionReason}
              onValueChange={(value) => {
                setRejectionReason(value);
                setRejectionCursors([]);
              }}
            >
              <SelectTrigger className="w-[190px]" size="sm" aria-label="Refusal reason">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All reasons</SelectItem>
                <SelectItem value="blocked_app_rate">App rate limit</SelectItem>
                <SelectItem value="blocked_app_budget">App budget</SelectItem>
                <SelectItem value="blocked_billing">Account allowance</SelectItem>
                <SelectItem value="blocked_user">Blocked user</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={rejectionScope}
              onValueChange={(value) => {
                setRejectionScope(value);
                setRejectionCursors([]);
              }}
            >
              <SelectTrigger className="w-[150px]" size="sm" aria-label="Refusal scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All scopes</SelectItem>
                <SelectItem value="user">User</SelectItem>
                <SelectItem value="app">App</SelectItem>
                <SelectItem value="account">Account</SelectItem>
              </SelectContent>
            </Select>
            <Input
              className="h-8 w-[190px]"
              aria-label="Refusal user ID"
              placeholder="User ID"
              value={rejectionUser}
              onChange={(event) => {
                setRejectionUser(event.target.value);
                setRejectionCursors([]);
              }}
            />
          </div>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>When</TableHead>
                <TableHead>User / API key</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Attempted route</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Version</TableHead>
                <TableHead className="text-right">Latency</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rejections.isPending ? (
                <TableRow>
                  <TableCell colSpan={8}><Skeleton className="h-8 w-full" /></TableCell>
                </TableRow>
              ) : rejections.isError ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">
                    Could not load refusal samples. {" "}
                    <Button variant="outline" size="sm" onClick={() => void rejections.refetch()}>
                      Retry
                    </Button>
                  </TableCell>
                </TableRow>
              ) : rejections.data?.events.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">
                    No refusal samples.
                  </TableCell>
                </TableRow>
              ) : (
                rejections.data?.events.map((event) => (
                  <TableRow key={event.id}>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatDateTime(event.created_at)}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {event.user_id ?? event.api_key_id ?? "—"}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{event.reason}</TableCell>
                    <TableCell className="text-xs">{event.scope ?? "unknown"}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {event.endpoint_slug ?? event.route ?? "—"}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{event.model ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{event.app_version ?? "—"}</TableCell>
                    <TableCell className="text-right text-xs tabular">
                      {event.latency_ms === null ? "—" : `${formatNumber(event.latency_ms)} ms`}
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
              disabled={rejections.isFetching || rejectionCursors.length === 0}
              onClick={() => setRejectionCursors((current) => current.slice(0, -1))}
            >
              Newer
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={rejections.isFetching || !rejections.data?.next_before_id}
              onClick={() => setRejectionCursors((current) => [
                ...current,
                rejections.data!.next_before_id as number,
              ])}
            >
              Older
            </Button>
          </div>
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
