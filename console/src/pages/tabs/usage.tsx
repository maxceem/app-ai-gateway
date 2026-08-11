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
import { EventStatusBadge } from "@/components/status-badge";
import { PROVIDER_LABELS, type Provider } from "@/lib/config-types";
import {
  cachedInputRate,
  daysAgo,
  formatCompact,
  formatCost,
  formatDateTime,
  formatNumber,
  formatPercent,
  inputTokens,
  today,
  totalTokens,
} from "@/lib/format";
import { useBreakdown, useEvents, useTimeseries } from "@/lib/queries";
import type { TimeseriesBucket } from "@/lib/types";

const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

const BREAKDOWNS = [
  { value: "model", label: "By model" },
  { value: "provider", label: "By provider" },
  { value: "user", label: "By user" },
  { value: "status", label: "By status" },
  { value: "route", label: "By route" },
  { value: "endpoint", label: "By endpoint" },
  { value: "app_version", label: "By app version" },
] as const;

type Metric = "cost_usd" | "requests" | "tokens";

/** Turns `(date, provider)` rows into one row per day with a column per provider. */
function pivot(buckets: TimeseriesBucket[], from: string, to: string, metric: Metric) {
  const providers = [...new Set(buckets.map((bucket) => bucket.provider))].sort();
  const byDate = new Map<string, Record<string, number>>();
  for (
    let day = new Date(`${from}T00:00:00Z`);
    day <= new Date(`${to}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() + 1)
  ) {
    const date = day.toISOString().slice(0, 10);
    byDate.set(date, Object.fromEntries(providers.map((provider) => [provider, 0])));
  }
  for (const bucket of buckets) {
    const row = byDate.get(bucket.date);
    if (!row) continue;
    row[bucket.provider] =
      metric === "tokens" ? totalTokens(bucket) : metric === "requests" ? bucket.requests : bucket.cost_usd;
  }
  return {
    providers,
    rows: [...byDate.entries()].map(([date, values]) => ({ date, ...values })),
  };
}

export function UsageTab({ appId }: { appId: string }) {
  const [days, setDays] = useState("30");
  const [metric, setMetric] = useState<Metric>("cost_usd");
  const [dimension, setDimension] = useState<string>("model");
  const [eventStatus, setEventStatus] = useState<string>("all");
  const [cursors, setCursors] = useState<number[]>([]);

  const from = daysAgo(Number(days) - 1);
  const to = today();
  const series = useTimeseries(appId, from, to);
  const breakdown = useBreakdown(appId, dimension, from, to);
  const events = useEvents(appId, {
    limit: 25,
    status: eventStatus === "all" ? undefined : eventStatus,
    before_id: cursors.at(-1),
  });

  const chart = useMemo(
    () => pivot(series.data?.buckets ?? [], from, to, metric),
    [series.data, from, to, metric],
  );

  const config: ChartConfig = Object.fromEntries(
    chart.providers.map((provider, index) => [
      provider,
      {
        label: PROVIDER_LABELS[provider as Provider] ?? provider,
        color: CHART_COLORS[index % CHART_COLORS.length],
      },
    ]),
  );

  const formatMetric = (value: number) =>
    metric === "cost_usd" ? formatCost(value) : formatCompact(value);

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
                  <SelectTrigger className="w-[130px]" size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cost_usd">Cost</SelectItem>
                    <SelectItem value="requests">Requests</SelectItem>
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
          ) : chart.providers.length === 0 ? (
            <EmptyState>No requests recorded in this range.</EmptyState>
          ) : (
            <ChartContainer config={config} className="h-[220px] w-full">
              <BarChart data={chart.rows} margin={{ left: 4, right: 4 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                <XAxis
                  dataKey="date"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  minTickGap={24}
                  tickFormatter={(value: string) => value.slice(5)}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={56}
                  tickFormatter={(value: number) => formatMetric(value)}
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent formatter={(value) => formatMetric(Number(value))} />
                  }
                />
                <ChartLegend content={<ChartLegendContent />} />
                {chart.providers.map((provider) => (
                  <Bar
                    key={provider}
                    dataKey={provider}
                    stackId="usage"
                    fill={`var(--color-${provider})`}
                    radius={[2, 2, 0, 0]}
                  />
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
            action={
              <Select value={dimension} onValueChange={setDimension}>
                <SelectTrigger className="w-[170px]" size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BREAKDOWNS.map((entry) => (
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
                <TableHead className="pl-6">{dimension}</TableHead>
                <TableHead className="text-right">Requests</TableHead>
                <TableHead className="text-right">Input</TableHead>
                <TableHead className="text-right">Cached input</TableHead>
                <TableHead className="text-right">Output</TableHead>
                <TableHead className="pr-6 text-right">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {breakdown.isPending ? (
                <TableRow>
                  <TableCell colSpan={6} className="px-6">
                    <Skeleton className="h-8 w-full" />
                  </TableCell>
                </TableRow>
              ) : breakdown.data?.rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                    Nothing recorded in this range.
                  </TableCell>
                </TableRow>
              ) : (
                breakdown.data?.rows.map((row) => (
                  <TableRow key={row.key ?? "unknown"}>
                    <TableCell className="pl-6 font-mono text-xs">
                      {row.key ?? <span className="text-muted-foreground">none</span>}
                    </TableCell>
                    <TableCell className="tabular text-right">{formatNumber(row.requests)}</TableCell>
                    <TableCell className="tabular text-right">{formatCompact(inputTokens(row))}</TableCell>
                    <TableCell className="tabular text-right">
                      <span className="block">{formatCompact(row.cached_input_tokens)}</span>
                      <span className="block text-[11px] text-muted-foreground">
                        {formatPercent(cachedInputRate(row))} of input
                      </span>
                    </TableCell>
                    <TableCell className="tabular text-right">{formatCompact(row.output_tokens)}</TableCell>
                    <TableCell className="tabular pr-6 text-right">{formatCost(row.cost_usd)}</TableCell>
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
            title="Recent events"
            description="Every proxied request, newest first."
            action={
              <Select
                value={eventStatus}
                onValueChange={(next) => {
                  setEventStatus(next);
                  setCursors([]);
                }}
              >
                <SelectTrigger className="w-[170px]" size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="ok">ok</SelectItem>
                  <SelectItem value="provider_error">provider_error</SelectItem>
                  <SelectItem value="blocked_rate">blocked_rate</SelectItem>
                  <SelectItem value="blocked_budget">blocked_budget</SelectItem>
                  <SelectItem value="blocked_user">blocked_user</SelectItem>
                </SelectContent>
              </Select>
            }
          />
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-6">When</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Route</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">Latency</TableHead>
                <TableHead className="pr-6">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.isPending ? (
                <TableRow>
                  <TableCell colSpan={8} className="px-6">
                    <Skeleton className="h-8 w-full" />
                  </TableCell>
                </TableRow>
              ) : events.data?.events.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">
                    No events.
                  </TableCell>
                </TableRow>
              ) : (
                events.data?.events.map((event) => (
                  <TableRow key={event.id}>
                    <TableCell className="pl-6 text-xs whitespace-nowrap text-muted-foreground">
                      {formatDateTime(event.created_at)}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{event.user_id}</TableCell>
                    <TableCell className="font-mono text-xs">{event.model}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {event.endpoint_slug ? `${event.endpoint_slug} → ${event.route}` : event.route}
                    </TableCell>
                    <TableCell className="tabular text-right text-xs">
                      {formatCompact(totalTokens(event))}
                    </TableCell>
                    <TableCell className="tabular text-right text-xs">{formatCost(event.cost_usd)}</TableCell>
                    <TableCell className="tabular text-right text-xs">
                      {event.latency_ms === null ? "—" : `${formatNumber(event.latency_ms)} ms`}
                    </TableCell>
                    <TableCell className="pr-6">
                      <EventStatusBadge status={event.status} />
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
