/**
 * An app's Errors tab: v1's sign-in health and refusal samples, read from the
 * v2 diagnostics (`getAppAuthEventSummary`, `listAppAuthEvents`,
 * `listAppRejectionEvents`).
 *
 * What is shaped differently from v1, and why:
 * - Failed proxied requests come from the usage totals as one count per day
 *   (`failed_charges`), so the failures table shows them as one row; the Usage
 *   tab's breakdown by status splits them.
 * - A refusal names the operation it asked for, not v1's route or endpoint,
 *   and an API key as `app_key_id`. A requested model the gateway does not
 *   know reads `unrecognized`: it was the caller's own text.
 * - Pages go back with the `before` cursor the API hands out, not a numeric id.
 */
import { useEffect, useMemo, useState } from "react";
import { AlertCircle } from "lucide-react";
import { FullIds, shortId } from "@/components/short-id";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, SectionHeader } from "@/components/field";
import { Hint } from "@/components/hint";
import { DateWindowNav, KEPT_DAYS } from "@/components/date-window";
import { usePagedList } from "@/lib/paged-list";
import { RangePicker } from "@/components/pickers";
import { StatCard } from "@/components/stat-card";
import { AuthOutcomeBadge } from "@/components/status-badge";
import { foldOutcomes } from "@/lib/auth-events";
import { formatDateTime, formatDuration, formatNumber, formatPercent } from "@/lib/format";
import { isAppleNetwork, networkLabel } from "@/lib/networks";
import { useAuthEventSummary, useAuthEvents, useRejectionEvents, type AuthEventQuery, type RejectionQuery } from "@/lib/queries";
import { AUTH_EVENT_OUTCOMES, REJECTION_SCOPES } from "@contracts/diagnostics";

type RejectionScope = (typeof REJECTION_SCOPES)[number];

/**
 * Whose limit refused, in the filter and the table. `account` is the plan
 * allowance shared by all your apps and `apple_account` is one end user's
 * Apple Account: the labels keep them apart.
 */
const REJECTION_SCOPE_LABELS: Record<RejectionScope, string> = {
  user: "User",
  install: "Install",
  apple_account: "Apple Account",
  app: "App",
  account: "Your account",
};

/**
 * Why a request was refused, in the filter: the reasons the gateway records
 * today. The table shows the code itself, which is what the app received, so
 * a reason added later still shows there.
 */
export const REJECTION_REASON_LABELS: Record<string, string> = {
  blocked_app_rate: "App rate limit",
  blocked_app_budget: "App budget",
  blocked_billing: "Account allowance",
  blocked_user: "Blocked user",
  blocked_replay: "Replayed App Attest proof",
  path_not_allowed: "Path not allowed",
  model_not_allowed: "Model not allowed",
  provider_not_configured: "Provider not configured",
  provider_disabled: "Provider turned off",
  pricing_not_configured: "Model has no price",
  max_output_tokens_exceeded: "Output limit exceeded",
  preset_not_found: "Preset not found",
  payload_too_large: "Request too large",
};

/** How long the user filter waits after the last keystroke before it reads. */
export const USER_FILTER_DEBOUNCE_MS = 250;

export function ErrorsTab({ appId }: { appId: string }) {
  const [days, setDays] = useState("30");
  // Each list holds its filters, days and pages together: any filter change,
  // a typed user included, starts at page one in the same update.
  const eventList = usePagedList({ outcome: "all" as string });
  const rejectionList = usePagedList({ reason: "all" as string, scope: "all" as string, user: "" });
  const outcome = eventList.filters.outcome;
  const eventWindow = eventList.range;
  const { reason: rejectionReason, scope: rejectionScope, user: rejectionUserFilter } = rejectionList.filters;
  const rejectionWindow = rejectionList.range;
  // The box shows each letter; the list takes the user once typing settles, not per letter.
  const [rejectionUser, setRejectionUser] = useState("");
  const setRejectionFilters = rejectionList.setFilters;
  useEffect(() => {
    const timer = setTimeout(() => setRejectionFilters({ user: rejectionUser.trim() }), USER_FILTER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [rejectionUser, setRejectionFilters]);

  const summary = useAuthEventSummary(appId, Number(days));
  // A filter with no index of its own reads a window of days, which the list shows and moves.
  const eventsWindowed = outcome !== "all";
  const eventQuery: AuthEventQuery = {
    limit: 25,
    ...(outcome === "all" ? {} : { outcome }),
    ...(eventsWindowed ? { from: eventWindow.from, to: eventWindow.to } : {}),
    ...(eventList.before !== undefined ? { before: eventList.before } : {}),
  };
  const events = useAuthEvents(appId, eventQuery);
  // A user filter has an index; a reason or scope alone does not.
  const rejectionsWindowed = rejectionUserFilter === "" && (rejectionReason !== "all" || rejectionScope !== "all");
  const rejectionQuery: RejectionQuery = {
    limit: 25,
    ...(rejectionReason === "all" ? {} : { reason: rejectionReason }),
    ...(rejectionScope === "all" ? {} : { scope: rejectionScope as RejectionScope }),
    ...(rejectionUserFilter ? { user: rejectionUserFilter } : {}),
    ...(rejectionsWindowed ? { from: rejectionWindow.from, to: rejectionWindow.to } : {}),
    ...(rejectionList.before !== undefined ? { before: rejectionList.before } : {}),
  };
  const rejections = useRejectionEvents(appId, rejectionQuery);

  const outcomes = useMemo(() => foldOutcomes(summary.data), [summary.data]);
  const claimDelay = summary.data?.claim_delay;
  const pending = summary.data?.pending_users ?? 0;
  // A failure on Apple's own network is most likely App Review's: the one network
  // worth calling out, because a build in review that cannot sign in may be
  // rejected without the developer ever seeing why. Read on its own where the
  // gateway gives it, so ten busier networks never hide it; from the network
  // list on an older gateway.
  // Only from a summary that loaded: a failed refresh keeps the old data, and an old alert must not stay up.
  const shown = summary.isSuccess ? summary.data : undefined;
  const apple =
    shown?.apple_failures !== undefined ? shown.apple_failures : shown?.failing_networks.find((row) => isAppleNetwork(row.network_asn));
  // Until the summary has loaded, the cards say so, not zero.
  const figure = (text: string) => (summary.isPending ? <Skeleton className="h-6 w-16" /> : summary.isError ? "—" : text);
  const detail = (text: string) => (summary.isSuccess ? text : summary.isError ? "unavailable" : undefined);

  return (
    <div className="space-y-4">
      {apple ? (
        <Alert>
          <AlertCircle />
          <AlertTitle>
            Sign-in failed {formatNumber(apple.count)} {apple.count === 1 ? "time" : "times"} on Apple&apos;s network
          </AlertTitle>
          <AlertDescription>
            App Review tests apps from Apple&apos;s network, so a build in review most likely could not use this app&apos;s AI features.
            Last seen {formatDateTime(apple.last_seen)}. Look for attempts from Apple Inc. under Recent attempts below.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Exchange success"
          value={figure(formatPercent(summary.data?.token_exchange.success_rate))}
          detail={detail(`${formatNumber(summary.data?.token_exchange.total ?? 0)} attempts`)}
        />
        <StatCard label="Claim delay p50" value={figure(formatDuration(claimDelay?.p50_ms))} detail={detail(`${formatNumber(claimDelay?.count ?? 0)} measured`)} />
        <StatCard label="Claim delay p95" value={figure(formatDuration(claimDelay?.p95_ms))} detail={detail(`avg ${formatDuration(claimDelay?.avg_ms)}`)} />
        <StatCard
          label="Pending activations"
          value={figure(formatNumber(pending))}
          // The only figure here about right now rather than the window: these
          // users are waiting on an entitlement claim as you read this.
          detail={detail(pending > 0 ? "waiting on a claim now" : "none waiting")}
        />
      </div>

      <Card className="py-0">
        <CardHeader className="pt-6">
          <SectionHeader
            title="Failures by cause"
            description="Sign-in failures, failed provider requests, and sampled refusals before a provider call, busiest first. Sample counts are not exact request totals."
            action={<RangePicker value={days} onChange={setDays} />}
          />
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {summary.isPending ? (
            <div className="px-6 pb-6">
              <Skeleton className="h-24 w-full" />
            </div>
          ) : summary.isError ? (
            <div className="px-6 pb-6">
              <EmptyState>Could not load the summary.</EmptyState>
            </div>
          ) : outcomes.length === 0 ? (
            <div className="px-6 pb-6">
              <EmptyState>No failures in this range.</EmptyState>
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
                    <TableCell className="font-mono text-xs text-muted-foreground">{row.reason ?? "—"}</TableCell>
                    <TableCell className="tabular text-right">
                      {formatNumber(row.total)}
                      {row.sampled ? <span className="ml-1 text-xs text-muted-foreground">{row.total === 1 ? "sample" : "samples"}</span> : null}
                    </TableCell>
                    <TableCell className="tabular text-right">{formatNumber(row.days.length)}</TableCell>
                    {/* `days` is ascending, so the last entry is the most recent day this cause was seen. */}
                    <TableCell className="text-xs whitespace-nowrap text-muted-foreground">{row.days.at(-1)?.date ?? "—"}</TableCell>
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
            description={
              rejectionsWindowed
                ? `Filtered by reason or scope: ${rejectionWindow.from} to ${rejectionWindow.to}, at most 31 days at a time. Move back through the ${KEPT_DAYS} days kept below.`
                : `Requests stopped before a provider call, by the app's limits or by its settings, such as a model it does not allow. At most one sample per user a minute; this is diagnostic history, not an exact count. Kept ${KEPT_DAYS} days.`
            }
          />
          <div className="flex flex-wrap gap-2 pt-3">
            <Select
              value={rejectionReason}
              onValueChange={(value) => rejectionList.setFilters({ reason: value })}
            >
              <SelectTrigger className="w-[230px]" size="sm" aria-label="Refusal reason">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All reasons</SelectItem>
                {Object.entries(REJECTION_REASON_LABELS).map(([reason, label]) => (
                  <SelectItem key={reason} value={reason}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={rejectionScope}
              onValueChange={(value) => rejectionList.setFilters({ scope: value })}
            >
              <SelectTrigger className="w-[150px]" size="sm" aria-label="Refusal scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All scopes</SelectItem>
                {REJECTION_SCOPES.map((scope) => (
                  <SelectItem key={scope} value={scope}>
                    {REJECTION_SCOPE_LABELS[scope]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              className="h-8 w-[190px]"
              aria-label="Refusal user ID"
              placeholder="User ID"
              value={rejectionUser}
              onChange={(event) => setRejectionUser(event.target.value)}
            />
          </div>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>When</TableHead>
                <TableHead>User / app key</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Attempted operation</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Version</TableHead>
                <TableHead className="text-right">Latency</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rejections.isPending ? (
                <TableRow>
                  <TableCell colSpan={8}>
                    <Skeleton className="h-8 w-full" />
                  </TableCell>
                </TableRow>
              ) : rejections.isError ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">
                    Could not load refusal samples.{" "}
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
                    <TableCell className="text-xs whitespace-nowrap text-muted-foreground">{formatDateTime(event.created_at)}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {event.user_id ?? event.app_key_id ? (
                        <FullIds ids={[{ label: event.user_id ? "User" : "App key", value: (event.user_id ?? event.app_key_id)! }]}>
                          <span>{shortId((event.user_id ?? event.app_key_id)!)}</span>
                        </FullIds>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{event.reason}</TableCell>
                    <TableCell className="text-xs">
                      {event.scope === null ? "—" : (REJECTION_SCOPE_LABELS[event.scope as RejectionScope] ?? event.scope)}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {event.provider_slug ? <span className="block text-muted-foreground">{event.provider_slug}</span> : null}
                      {event.operation ?? "—"}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {event.model === "unrecognized" ? (
                        <Hint content="The request named a model the gateway does not know, so its text was not kept.">
                          <span className="font-sans text-muted-foreground">unrecognized</span>
                        </Hint>
                      ) : (event.model ?? "—")}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{event.app_version ?? "—"}</TableCell>
                    <TableCell className="tabular text-right text-xs">{event.latency_ms === null ? "—" : `${formatNumber(event.latency_ms)} ms`}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          <div className="flex flex-wrap items-center justify-end gap-2 border-t px-6 py-3">
            {rejectionsWindowed ? (
              <div className="mr-auto">
                <DateWindowNav range={rejectionWindow} disabled={rejections.isFetching} onEarlier={rejectionList.earlier} onLater={rejectionList.later} />
              </div>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              disabled={rejections.isFetching || !rejectionList.canNewer}
              onClick={rejectionList.newer}
            >
              Newer
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={rejections.isFetching || !rejections.data?.next_before}
              onClick={() => rejectionList.older(rejections.data!.next_before as string, rejectionList.range)}
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
            description={
              eventsWindowed
                ? `Filtered by outcome: ${eventWindow.from} to ${eventWindow.to}, at most 31 days at a time. Move back through the ${KEPT_DAYS} days kept below.`
                : `Every token exchange and key registration, and every App Attest challenge that nothing used, newest first. Kept ${KEPT_DAYS} days.`
            }
            action={
              <Select
                value={outcome}
                onValueChange={(next) => eventList.setFilters({ outcome: next })}
              >
                <SelectTrigger className="w-[210px]" size="sm" aria-label="Outcome">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All outcomes</SelectItem>
                  {AUTH_EVENT_OUTCOMES.map((value) => (
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
                <TableHead>Network</TableHead>
                <TableHead className="text-right">Latency</TableHead>
                <TableHead className="text-right">Claim delay</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.isPending ? (
                <TableRow>
                  <TableCell colSpan={9}>
                    <Skeleton className="h-8 w-full" />
                  </TableCell>
                </TableRow>
              ) : events.isError ? (
                <TableRow>
                  <TableCell colSpan={9} className="py-8 text-center text-sm text-muted-foreground">
                    Could not load attempts.{" "}
                    <Button variant="outline" size="sm" onClick={() => void events.refetch()}>
                      Retry
                    </Button>
                  </TableCell>
                </TableRow>
              ) : events.data?.events.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="py-8 text-center text-sm text-muted-foreground">
                    No attempts.
                  </TableCell>
                </TableRow>
              ) : (
                events.data?.events.map((event) => (
                  <TableRow key={event.id}>
                    <TableCell className="text-xs whitespace-nowrap text-muted-foreground">{formatDateTime(event.created_at)}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {/* Absent whenever the attempt never got far enough to establish an identity. */}
                      {event.user_id ? (
                        <FullIds ids={[{ label: "User", value: event.user_id }]}>
                          <span>{shortId(event.user_id)}</span>
                        </FullIds>
                      ) : (
                        <span className="text-muted-foreground">unknown</span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {event.event}
                      {event.auth_method ? <span className="block">{event.auth_method}</span> : null}
                    </TableCell>
                    <TableCell>
                      <AuthOutcomeBadge outcome={event.outcome} />
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{event.reason ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{event.app_version ?? "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {networkLabel(event.network_asn, event.network_name) ?? "—"}
                      {isAppleNetwork(event.network_asn) ? <span className="block text-amber-600 dark:text-amber-400">probably App Review</span> : null}
                    </TableCell>
                    <TableCell className="tabular text-right text-xs">{event.latency_ms === null ? "—" : `${formatNumber(event.latency_ms)} ms`}</TableCell>
                    <TableCell className="tabular text-right text-xs">
                      {/* Only the exchange that ended a wait carries one, so a value here marks the moment a user was unblocked. */}
                      {event.claim_delay_ms === null ? (
                        "—"
                      ) : (
                        <Hint content="This exchange ended a wait for an entitlement claim to reach the issuer.">
                          <span className="text-amber-600 dark:text-amber-400">{formatDuration(event.claim_delay_ms)}</span>
                        </Hint>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          <div className="flex flex-wrap items-center justify-end gap-2 border-t px-6 py-3">
            {eventsWindowed ? (
              <div className="mr-auto">
                <DateWindowNav range={eventWindow} disabled={events.isFetching} onEarlier={eventList.earlier} onLater={eventList.later} />
              </div>
            ) : null}
            <Button variant="outline" size="sm" disabled={events.isFetching || !eventList.canNewer} onClick={eventList.newer}>
              Newer
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={events.isFetching || !events.data?.next_before}
              onClick={() => eventList.older(events.data!.next_before as string, eventList.range)}
            >
              Older
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
