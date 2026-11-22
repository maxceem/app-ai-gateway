/**
 * An app's Usage tab: v1's chart, breakdown and recent requests, read from
 * the v2 ledger (`getAppUsageTimeseries`, `getAppUsageBreakdown`,
 * `listAppCharges`).
 *
 * What is shaped differently from v1, and why:
 * - v1 listed usage events, one per request; v2 lists charges, one per
 *   upstream attempt, session slice or job estimate, and each correction as a
 *   row of its own that names the charge it corrects.
 * - Costs are integer nano-dollars on the wire; the dollars shown are the
 *   API's `cost_usd`, worked out from them once on the server.
 * - "Requests" is "Charges": a correction changes a charge's cost and is never
 *   counted as one.
 * - v1's route, endpoint and cost source are v2's operation, preset and price
 *   source. v1's gateway, credential source, model author and service mode
 *   have no breakdown: v2 records none of them on a charge.
 * - Pages go back with the `before` cursor the API hands out, not a numeric id.
 */
import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, SectionHeader } from "@/components/field";
import { Hint } from "@/components/hint";
import { DateWindowNav, KEPT_DAYS, useDateWindow } from "@/components/date-window";
import { RangePicker } from "@/components/pickers";
import { AuthOutcomeBadge } from "@/components/status-badge";
import {
  cachedInputRate,
  daysAgo,
  formatCompact,
  formatCost,
  formatDateTime,
  formatEventTime,
  formatNumber,
  formatPercent,
  inputTokens,
  today,
} from "@/lib/format";
import { useAppCharges, useUsageBreakdown, useUsageTimeseries, type ChargeQuery } from "@/lib/queries";
import type { App, Charge, UsageDimension } from "@/lib/types";
import { OTHER, pivot, type Metric } from "@/lib/usage-pivot";
import { cn } from "@/lib/utils";
import { CHARGE_STATUS_FILTERS, USAGE_CHARGE_DIMENSIONS, USAGE_CHARGE_RANGE_MAX_DAYS } from "@contracts/usage";

/** The categorical slots, in their validated order; `pivot` folds anything past the last into `OTHER`. */
const CHART_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)", "var(--chart-6)", "var(--chart-7)"];

const BREAKDOWNS: { value: UsageDimension; label: string }[] = [
  { value: "model", label: "By model" },
  { value: "provider", label: "By provider" },
  { value: "connection", label: "By connection" },
  { value: "user", label: "By user" },
  { value: "install", label: "By install" },
  { value: "status", label: "By status" },
  { value: "price_source", label: "By price source" },
  { value: "measured", label: "By measurement" },
  { value: "operation", label: "By operation" },
  { value: "preset", label: "By preset" },
  { value: "unit", label: "By unit" },
  { value: "app_version", label: "By app version" },
];

/** Breakdowns read from the charges themselves: kept 90 days, over at most 31 at a time. */
const FROM_CHARGES: ReadonlySet<string> = new Set(USAGE_CHARGE_DIMENSIONS);

/** What a price source means, for the hint beside an amount. */
const PRICE_SOURCE_TEXT: Record<Charge["price_source"], string> = {
  provider_usd: "The provider reported what it charged.",
  list_rate: "Priced from the price list.",
  customer_rate: "Priced from your own rate for this model.",
  unresolved: "Not priced yet: the usage is kept, and a correction prices it once a price exists.",
  not_priced: "A passthrough path with no price: counted, not charged.",
};

/** Whether the app's traffic names installs: App Attest apps only. */
function namesInstalls(app: App): boolean {
  return app.config.authentication.type === "apple_app_attest";
}

/** The first day of a range ending `to`, at most `maxDays` long. */
function clampedFrom(from: string, to: string, maxDays: number): string {
  const earliest = new Date(Date.parse(`${to}T00:00:00Z`) - (maxDays - 1) * 86_400_000).toISOString().slice(0, 10);
  return from < earliest ? earliest : from;
}

export function UsageTab({ app }: { app: App }) {
  const installs = namesInstalls(app);
  const breakdowns = BREAKDOWNS.filter((entry) => entry.value !== "install" || installs);
  const [days, setDays] = useState("30");
  const [metric, setMetric] = useState<Metric>("cost_nano");
  const [dimension, setDimension] = useState<UsageDimension>("model");
  const [status, setStatus] = useState<string>("all");
  const [cursors, setCursors] = useState<string[]>([]);
  const dateWindow = useDateWindow();
  // A status filter has no index of its own, so it reads a window of days the list shows and moves.
  const windowed = status !== "all";

  const to = today();
  const from = daysAgo(Number(days) - 1);
  // A breakdown from the charges reads at most 31 days, so a longer range is cut to its last 31.
  const breakdownFrom = FROM_CHARGES.has(dimension) ? clampedFrom(from, to, USAGE_CHARGE_RANGE_MAX_DAYS) : from;
  const series = useUsageTimeseries(app.id, { from, to });
  const breakdown = useUsageBreakdown(app.id, { by: dimension, from: breakdownFrom, to, limit: 50 });
  const chargeQuery: ChargeQuery = {
    limit: 25,
    ...(status === "all" ? {} : { status: status as NonNullable<ChargeQuery["status"]> }),
    ...(windowed ? { from: dateWindow.from, to: dateWindow.to } : {}),
    ...(cursors.length > 0 ? { before: cursors.at(-1) } : {}),
  };
  const charges = useAppCharges(app.id, chargeQuery);

  const chart = useMemo(() => pivot(series.data?.buckets ?? [], from, to, metric), [series.data, from, to, metric]);
  // Keys are generated (`s0`…) and colours fixed: a provider's name is only ever a label, shown as text.
  const colorOf = (provider: string, index: number) => (provider === OTHER ? "var(--chart-other)" : CHART_COLORS[index]!);
  const config: ChartConfig = Object.fromEntries(
    chart.series.map(({ key, provider }, index) => [
      key,
      { label: provider === OTHER ? `Other (${chart.foldedCount})` : provider, color: colorOf(provider, index) },
    ]),
  );
  const formatMetric = (value: number) => (metric === "cost_nano" ? formatCost(value / 1e9) : formatCompact(value));

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <SectionHeader
            title="Daily usage by provider"
            description={`${from} to ${to}`}
            action={
              <div className="flex gap-2">
                <Select value={metric} onValueChange={(next) => setMetric(next as Metric)}>
                  <SelectTrigger className="w-[130px]" size="sm" aria-label="Metric">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cost_nano">Cost</SelectItem>
                    <SelectItem value="charges">Charges</SelectItem>
                    <SelectItem value="tokens">Tokens</SelectItem>
                  </SelectContent>
                </Select>
                <RangePicker value={days} onChange={setDays} />
              </div>
            }
          />
        </CardHeader>
        <CardContent>
          {series.isPending ? (
            <Skeleton className="h-[220px] w-full" />
          ) : series.isError ? (
            <EmptyState>Could not load usage.</EmptyState>
          ) : chart.series.length === 0 ? (
            <EmptyState>No usage recorded in this range.</EmptyState>
          ) : (
            <ChartContainer config={config} className="h-[220px] w-full">
              <BarChart data={chart.rows} margin={{ left: 4, right: 4 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tickFormatter={(value: string) => value.slice(5)} />
                <YAxis tickLine={false} axisLine={false} width={56} allowDecimals={false} tickFormatter={(value: number) => formatMetric(value)} />
                <ChartTooltip content={<ChartTooltipContent valueFormatter={(value) => formatMetric(Number(value))} />} />
                <ChartLegend content={<ChartLegendContent />} />
                {chart.series.map(({ key, provider }, index) => (
                  <Bar key={key} dataKey={key} stackId="usage" fill={colorOf(provider, index)} radius={[2, 2, 0, 0]} />
                ))}
              </BarChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>

      <Card className="py-0">
        <CardHeader className="pt-6">
          <SectionHeader
            title="Breakdown"
            description={
              FROM_CHARGES.has(dimension)
                ? `${breakdownFrom} to ${to}. Read from the charges themselves, kept 90 days, at most ${USAGE_CHARGE_RANGE_MAX_DAYS} days at a time.`
                : `${breakdownFrom} to ${to}.`
            }
            action={
              <Select value={dimension} onValueChange={(next) => setDimension(next as UsageDimension)}>
                <SelectTrigger className="w-[170px]" size="sm" aria-label="Breakdown">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {breakdowns.map((entry) => (
                    <SelectItem key={entry.value} value={entry.value}>
                      {entry.label}
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
                <TableHead>{dimension}</TableHead>
                <TableHead className="text-right">Charges</TableHead>
                {/* Every prompt token, cached and cache-written ones included: the two columns after it are shares of it. */}
                <TableHead className="text-right">Total input</TableHead>
                <TableHead className="text-right">Cached input</TableHead>
                <TableHead className="text-right">Cache write</TableHead>
                <TableHead className="text-right">Output</TableHead>
                <TableHead className="text-right">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {breakdown.isPending ? (
                <TableRow>
                  <TableCell colSpan={7}>
                    <Skeleton className="h-8 w-full" />
                  </TableCell>
                </TableRow>
              ) : breakdown.isError ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                    Could not load the breakdown.
                  </TableCell>
                </TableRow>
              ) : breakdown.data?.rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                    Nothing recorded in this range.
                  </TableCell>
                </TableRow>
              ) : (
                breakdown.data?.rows.map((row) => (
                  <TableRow key={row.key ?? "none"}>
                    <TableCell className="font-mono text-xs">
                      {row.key === null ? <span className="font-sans text-muted-foreground">none</span> : (row.label ?? row.key)}
                    </TableCell>
                    <TableCell className="tabular text-right">
                      {formatNumber(row.charges)}
                      {row.failed > 0 ? <span className="block text-[11px] text-amber-600 dark:text-amber-400">{formatNumber(row.failed)} failed</span> : null}
                    </TableCell>
                    <TableCell className="tabular text-right">{formatCompact(inputTokens(row))}</TableCell>
                    <TableCell className="tabular text-right">
                      <span className="block">{formatCompact(row.cached_input_tokens)}</span>
                      <span className="block text-[11px] text-muted-foreground">{formatPercent(cachedInputRate(row))} of input</span>
                    </TableCell>
                    <TableCell className="tabular text-right">{formatCompact(row.cache_write_tokens)}</TableCell>
                    <TableCell className="tabular text-right">{formatCompact(row.output_tokens)}</TableCell>
                    <TableCell className="tabular text-right">
                      {formatCost(row.cost_usd)}
                      {/* Charges still without a price count as $0 here; saying how many keeps the total honest. */}
                      {row.unpriced > 0 ? (
                        <Hint content="Charges with no price yet count as $0 until a correction prices them. This may include failed attempts that cost nothing, where the provider reports its own price.">
                          <span className="block text-[11px] text-amber-600 dark:text-amber-400">{formatNumber(row.unpriced)} unpriced</span>
                        </Hint>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="py-0">
        <CardHeader className="pt-6">
          <SectionHeader
            title="Recent charges"
            description={
              windowed
                ? `Filtered by status: ${dateWindow.from} to ${dateWindow.to}, at most 31 days at a time. Move back through the ${KEPT_DAYS} days kept below.`
                : `Each upstream attempt, session slice and job estimate, and each correction, newest first. Kept ${KEPT_DAYS} days.`
            }
            action={
              <Select
                value={status}
                onValueChange={(next) => {
                  setStatus(next);
                  setCursors([]);
                  dateWindow.reset();
                }}
              >
                <SelectTrigger className="w-[170px]" size="sm" aria-label="Charge status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  {CHARGE_STATUS_FILTERS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value === "failed" ? "Every failure" : value}
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
                <TableHead>{installs ? "User / install" : "User"}</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Operation</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">Latency</TableHead>
                <TableHead className="text-right">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {charges.isPending ? (
                <TableRow>
                  <TableCell colSpan={7}>
                    <Skeleton className="h-8 w-full" />
                  </TableCell>
                </TableRow>
              ) : charges.isError ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                    Could not load charges.{" "}
                    <Button variant="outline" size="sm" onClick={() => void charges.refetch()}>
                      Retry
                    </Button>
                  </TableCell>
                </TableRow>
              ) : charges.data?.charges.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                    No charges.
                  </TableCell>
                </TableRow>
              ) : (
                charges.data?.charges.map((charge) => <ChargeRow key={charge.id} charge={charge} installs={installs} />)
              )}
            </TableBody>
          </Table>
          <div className="flex flex-wrap items-center justify-end gap-2 border-t px-6 py-3">
            {windowed ? (
              <div className="mr-auto">
                <DateWindowNav range={dateWindow} disabled={charges.isFetching} onMove={() => setCursors([])} />
              </div>
            ) : null}
            <Button variant="outline" size="sm" disabled={charges.isFetching || cursors.length === 0} onClick={() => setCursors((current) => current.slice(0, -1))}>
              Newer
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={charges.isFetching || !charges.data?.next_before}
              onClick={() => setCursors((current) => [...current, charges.data!.next_before as string])}
            >
              Older
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/** A charge's tokens, all buckets; null where the charge carries none. */
function chargeTokens(charge: Charge): number | null {
  const parts = [charge.input_tokens, charge.cached_input_tokens, charge.cache_write_tokens, charge.output_tokens];
  return parts.every((part) => part === null) ? null : parts.reduce<number>((sum, part) => sum + (part ?? 0), 0);
}

function ChargeRow({ charge, installs }: { charge: Charge; installs: boolean }) {
  const failed = charge.status !== "ok";
  const tokens = chargeTokens(charge);
  return (
    // A failed attempt is tinted whole, so it stands out from the served rows around it.
    <TableRow className={cn(failed && "bg-destructive/5 hover:bg-destructive/10 dark:bg-destructive/10 dark:hover:bg-destructive/15")}>
      <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
        <Hint content={formatDateTime(charge.used_at)}>
          <span>{formatEventTime(charge.used_at)}</span>
        </Hint>
      </TableCell>
      <TableCell className="font-mono text-xs">
        {charge.end_user_id ? <span className="block">{charge.end_user_id}</span> : <span className="block font-sans text-muted-foreground">No end user</span>}
        {installs && charge.install_id && charge.install_id !== charge.end_user_id ? (
          <span className="block text-muted-foreground">{charge.install_id}</span>
        ) : null}
      </TableCell>
      <TableCell className="font-mono text-xs">
        <span className="block">{charge.model ?? <span className="font-sans text-muted-foreground">none</span>}</span>
        <span className="block text-muted-foreground">{charge.provider_type}</span>
      </TableCell>
      <TableCell className="max-w-56 font-mono text-xs whitespace-normal text-muted-foreground">
        {charge.preset ? <span className="block">{charge.preset} →</span> : null}
        <span className="block">{charge.operation}</span>
        {charge.kind === "correction" ? (
          <Hint content={`Corrects charge ${charge.corrects_charge_id ?? "of its owner"}: a later figure changed its cost.`}>
            <span className="block font-sans text-amber-600 dark:text-amber-400">correction{charge.correction_kind ? ` (${charge.correction_kind})` : ""}</span>
          </Hint>
        ) : charge.kind !== "attempt" ? (
          <span className="block font-sans">{charge.kind}</span>
        ) : null}
      </TableCell>
      <TableCell className="tabular text-right text-xs">{tokens === null ? "—" : formatCompact(tokens)}</TableCell>
      <TableCell className="tabular text-right text-xs whitespace-nowrap">
        {charge.latency_ms === null ? "—" : `${formatNumber(charge.latency_ms)} ms`}
      </TableCell>
      <TableCell className="tabular text-right text-xs">
        <ChargeCost charge={charge} />
        {/* Only a failure is marked: a badge on every served row would hide the few that failed. */}
        {failed ? (
          <span className="mt-1 flex justify-end">
            <AuthOutcomeBadge outcome={charge.error_code ?? charge.status} />
          </span>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

/**
 * A charge's cost. A failed attempt that cost nothing has none, shown as —
 * rather than $0.00. An unpriced charge says so rather than claim $0, and an
 * estimate (a job before its final figure, or a mode with no exact price)
 * reads ≈.
 */
export function ChargeCost({ charge }: { charge: Pick<Charge, "cost_usd" | "price_source" | "price_is_estimate" | "measured" | "status"> }) {
  // A failed attempt that reported no usage was billed nothing: its cost is
  // empty and its measure complete, whatever price source it was written
  // with (`call-charge.ts`). That is not a cost still unknown (Sol 7b-6).
  if (charge.cost_usd === null && charge.status !== "ok" && charge.measured === "complete") {
    return (
      <Hint content="Failed before the provider reported any usage: nothing was billed.">
        <span className="text-muted-foreground">—</span>
      </Hint>
    );
  }
  if (charge.price_source === "unresolved" || charge.price_source === "not_priced") {
    return (
      <Hint content={PRICE_SOURCE_TEXT[charge.price_source]}>
        <span className="text-amber-600 dark:text-amber-400">{charge.price_source === "unresolved" ? "unpriced" : "not priced"}</span>
      </Hint>
    );
  }
  if (charge.cost_usd === null) return <span className="text-muted-foreground">—</span>;
  if (charge.price_is_estimate) {
    return (
      <Hint content="An estimate: a job's charge before the provider's final figure corrects it, or the closest known price for a mode with no exact one.">
        <span className="text-amber-600 dark:text-amber-400">≈{formatCost(charge.cost_usd)}</span>
      </Hint>
    );
  }
  return (
    <Hint content={PRICE_SOURCE_TEXT[charge.price_source]}>
      <span>{formatCost(charge.cost_usd)}</span>
    </Hint>
  );
}
