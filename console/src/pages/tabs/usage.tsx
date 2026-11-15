import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
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
import { GatewayIcon, ProviderIcon, ProviderName } from "@/components/brand-icon";
import { EmptyState, SectionHeader } from "@/components/field";
import { RangePicker } from "@/components/pickers";
import { EventStatusLabel, ServiceModeLabel } from "@/components/status-badge";
import { isGatewayType } from "@/lib/config-types";
import { isProviderType } from "@shared/providers";
import { isPassthroughPath } from "@shared/app-config";
import {
  cachedInputRate,
  daysAgo,
  formatCompact,
  formatCost,
  formatCostToCent,
  formatDateTime,
  formatEventTime,
  formatNumber,
  formatPercent,
  inputTokens,
  today,
  totalTokens,
} from "@/lib/format";
import { useBreakdown, useEvents, usePrices, useProviders, useTimeseries } from "@/lib/queries";
import { FullIds, shortId } from "@/components/short-id";
import { parseServiceModeName, serviceModeFactor } from "@shared/service-modes";
import type { UsageBreakdownDimension, UsageEvent, UsageStatus } from "@contracts/responses";
import { OTHER, pivot, type Metric } from "@/lib/usage-pivot";
import { Hint } from "@/components/hint";

/**
 * Whether an event was a passthrough call, read off its route with the rule
 * the gateway itself applies: the gateway forwarded it without reading a
 * model, so there is no model to name and a cost only where the provider
 * reported one. A custom endpoint is never one.
 *
 * By route alone, so an event recorded on such a path before passthrough
 * existed reads the same way: the model it was stored with was a label from
 * the configuration, never read from the request, and is not shown as if the
 * request had used it.
 */
/**
 * The path an event went to, without its provider's slug where the slug is
 * just the provider's type, as it is for most providers: `/v1/responses`. A
 * slug of your own, such as `openai-direct`, is kept, since it names which of
 * your providers it was.
 */
function routePath(event: { route: string; provider: string; provider_slug: string | null }): string {
  const prefix = `${event.provider_slug}/`;
  return event.provider_slug === event.provider && event.route.startsWith(prefix)
    ? `/${event.route.slice(prefix.length)}`
    : event.route;
}

export function isPassthroughEvent(event: {
  provider: string;
  route: string;
  endpoint_slug: string | null;
}): boolean {
  const slash = event.route.indexOf("/");
  return event.endpoint_slug === null
    && slash > 0
    && isProviderType(event.provider)
    && isPassthroughPath(event.provider, event.route.slice(slash + 1));
}

/** Why a passthrough request has no model, tokens or cost to show, one reason per column. */
const UNREPORTED_REASON = {
  model: "Non-standard path: forwarded as sent, so the gateway reads no model.",
  tokens: "Non-standard path: tokens are counted only if the provider reports them, and it reported none.",
  cost: "Non-standard path: its cost counts toward spending limits only if the provider reports it, and it reported none. Request limits still apply.",
} as const;

/**
 * What a cell shows for something a passthrough request never reported. The
 * gateway records a passthrough call's tokens and cost only where the provider
 * said them, and stores nothing as 0, so a 0 there means "not reported", not
 * "none used": a dash says that, and a number the provider did report still
 * shows. Hovering it says why.
 */
function Unreported({ what, label = "—" }: { what: keyof typeof UNREPORTED_REASON; label?: string }) {
  return (
    <Hint content={<span className="block max-w-64">{UNREPORTED_REASON[what]}</span>}>
      <span className="cursor-help font-sans text-muted-foreground">{label}</span>
    </Hint>
  );
}

/**
 * The categorical slots, in the fixed order they were validated in — see the
 * comment on `--chart-1` in `index.css`. Assigned in sequence and never cycled:
 * a series past the last of them does not get a hue, because `pivot` has
 * already folded it into `OTHER`. There are exactly `MAX_SERIES` of these, and
 * `@/lib/usage-pivot` is where that number is written.
 */
const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
  "var(--chart-7)",
];

const BREAKDOWNS = [
  { value: "model", label: "By model" },
  { value: "model_author", label: "By model author" },
  { value: "provider", label: "By provider" },
  // The transport a request took and whose key paid for it are questions the
  // provider alone cannot answer, so each gets its own dimension.
  { value: "provider_gateway", label: "By gateway" },
  { value: "credential_source", label: "By credential source" },
  // Who made the traffic; which of these an app offers is decided below.
  { value: "user", label: "By user" },
  { value: "install", label: "By install" },
  { value: "status", label: "By status" },
  { value: "cost_source", label: "By cost source" },
  { value: "service_mode", label: "By service mode" },
  { value: "route", label: "By route" },
  { value: "endpoint", label: "By endpoint" },
  { value: "app_version", label: "By app version" },
] as const;

/**
 * The brand a breakdown key names, on the two dimensions whose keys are types
 * rather than free-form strings. The key itself stays exactly as recorded —
 * these are the values the API groups by, and an event from before a type
 * existed simply has no mark.
 */
function BreakdownMark({ dimension, value }: { dimension: string; value: string }) {
  if (dimension === "provider" && isProviderType(value)) return <ProviderIcon type={value} />;
  if (dimension === "provider_gateway" && isGatewayType(value)) return <GatewayIcon type={value} />;
  return null;
}

export function UsageTab({
  appId,
  identity = "user",
  showInstalls = false,
}: {
  appId: string;
  /**
   * Who an app's traffic is broken down by: an App Attest app's install, or
   * its user when its budget is measured per user; a server app's user. An
   * Apple Account budget has no breakdown of its own and stays on the install.
   */
  identity?: "user" | "install";
  /** Whether events name the install that made them: App Attest apps only. */
  showInstalls?: boolean;
}) {
  const breakdowns = BREAKDOWNS.filter((entry) =>
    entry.value === "user" || entry.value === "install" ? entry.value === identity : true);
  const [days, setDays] = useState("30");
  const [metric, setMetric] = useState<Metric>("cost_usd");
  const [dimension, setDimension] = useState<UsageBreakdownDimension>("model");
  const [eventStatus, setEventStatus] = useState<UsageStatus | "all">("all");
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
  const prices = usePrices();
  const providers = useProviders();

  /**
   * How many times the standard price an event's mode costs, from the
   * provider's custom price where it has one and the price list otherwise, as
   * billing reads them. Undefined where neither prices the mode: the event's
   * cost is then an estimate, and says so.
   */
  const modeFactor = (event: UsageEvent): number | undefined => {
    const mode = event.service_mode ? parseServiceModeName(event.service_mode) : null;
    if (!mode || event.cost_source === "estimated") return undefined;
    const custom = providers.data?.providers.find((row) => row.slug === event.provider_slug)?.pricing?.[event.model];
    const listed = prices.data?.prices[event.provider]?.[event.model];
    return serviceModeFactor(custom?.modes ?? listed?.modes, mode);
  };

  const chart = useMemo(
    () => pivot(series.data?.buckets ?? [], from, to, metric),
    [series.data, from, to, metric],
  );

  // The legend and the tooltip both take a node, so a series is named with the
  // provider's mark beside its label — the colour swatch is what ties the entry
  // to its bar, and stays. A series whose key is not a provider type at all is
  // an older event's, and is named as it was recorded.
  const config: ChartConfig = Object.fromEntries(
    chart.providers.map((provider, index) => [
      provider,
      provider === OTHER
        ? {
            label: `Other (${chart.foldedCount})`,
            // Neutral on purpose: the band is a remainder, not a brand, and it
            // must not read as a ninth entry in the categorical order.
            color: "var(--chart-other)",
          }
        : {
            label: isProviderType(provider) ? <ProviderName type={provider} /> : provider,
            // Straight indexing, never `% length`: the seventh series is the
            // last that gets a hue, and `pivot` has already folded the rest.
            color: CHART_COLORS[index],
          },
    ]),
  );

  // The chart plots a day's total for one provider, not one request, so its
  // costs read to the cent — see `formatCostToCent`.
  const formatMetric = (value: number) =>
    metric === "cost_usd" ? formatCostToCent(value) : formatCompact(value);

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
                    <ChartTooltipContent
                      valueFormatter={(value) => formatMetric(Number(value))}
                    />
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
              <Select
                value={dimension}
                // Only this select's own items can reach it, and each is a dimension.
                onValueChange={(next) => setDimension(next as UsageBreakdownDimension)}
              >
                <SelectTrigger className="w-[170px]" size="sm">
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
                <TableHead className="text-right">Requests</TableHead>
                {/* Input is every prompt token, cached and cache-written ones
                    included, which is what the two columns after it are a
                    share of. */}
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
              ) : breakdown.data?.rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                    Nothing recorded in this range.
                  </TableCell>
                </TableRow>
              ) : (
                breakdown.data?.rows.map((row) => {
                  // The model breakdown's empty key is passthrough requests,
                  // whose counts are only what a provider reported.
                  const passthrough = dimension === "model" && row.key === "";
                  const noTokens = passthrough
                    && inputTokens(row) + row.cache_write_tokens + row.output_tokens === 0;
                  return (
                  <TableRow key={row.key ?? "unknown"}>
                    <TableCell className="font-mono text-xs">
                      {/* Empty is a passthrough request's model: the gateway read none. */}
                      {passthrough ? (
                        <Unreported what="model" label="none" />
                      ) : dimension === "service_mode" ? (
                        // No mode is the standard one; every other is a badge.
                        row.key ? <ServiceModeLabel mode={row.key} /> : <span className="text-muted-foreground">standard</span>
                      ) : !row.key ? (
                        <span className="text-muted-foreground">none</span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5">
                          <BreakdownMark dimension={dimension} value={row.key} />
                          {row.key}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="tabular text-right">{formatNumber(row.requests)}</TableCell>
                    <TableCell className="tabular text-right">
                      {noTokens ? <Unreported what="tokens" /> : formatCompact(inputTokens(row))}
                    </TableCell>
                    <TableCell className="tabular text-right">
                      {noTokens ? <Unreported what="tokens" /> : (
                        <>
                          <span className="block">{formatCompact(row.cached_input_tokens)}</span>
                          <span className="block text-[11px] text-muted-foreground">
                            {formatPercent(cachedInputRate(row))} of input
                          </span>
                        </>
                      )}
                    </TableCell>
                    <TableCell className="tabular text-right">
                      {noTokens ? <Unreported what="tokens" /> : formatCompact(row.cache_write_tokens)}
                    </TableCell>
                    <TableCell className="tabular text-right">
                      {noTokens ? <Unreported what="tokens" /> : formatCompact(row.output_tokens)}
                    </TableCell>
                    <TableCell className="tabular text-right">
                      {passthrough && row.cost_usd === 0 ? <Unreported what="cost" /> : formatCost(row.cost_usd)}
                    </TableCell>
                  </TableRow>
                  );
                })
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
                  setEventStatus(next as UsageStatus | "all");
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
                  {/*
                    Labelled rather than raw, because the value alone does not
                    say who refused the request, and that is the distinction an
                    operator is filtering for: the app's own limits, or the plan.
                  */}
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
                <TableHead>{showInstalls ? "User / install" : "User / key"}</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Route</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">Latency</TableHead>
                <TableHead className="text-right">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.isPending ? (
                <TableRow>
                  <TableCell colSpan={7}>
                    <Skeleton className="h-8 w-full" />
                  </TableCell>
                </TableRow>
              ) : events.data?.events.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                    No events.
                  </TableCell>
                </TableRow>
              ) : (
                events.data?.events.map((event) => {
                  const factor = modeFactor(event);
                  return (
                  // A failed request is tinted whole, so it stands out from the
                  // served rows around it at a glance.
                  <TableRow
                    key={event.id}
                    className={cn(event.status !== "ok" && "bg-destructive/5 hover:bg-destructive/10 dark:bg-destructive/10 dark:hover:bg-destructive/15")}
                  >
                    <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                      <Hint content={formatDateTime(event.created_at)}>
                        <span>{formatEventTime(event.created_at)}</span>
                      </Hint>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {/* Long identifiers are shortened to their two ends; the
                          hover shows them whole, to select or copy. An
                          application that identifies no end users has none to
                          name here, and an empty cell would read as a lost
                          value rather than an absent one. Key attribution is
                          absent for attested traffic; under app_install the
                          install is the user, already named. */}
                      <FullIds
                        ids={[
                          ...(event.user_id ? [{ label: "User", value: event.user_id }] : []),
                          ...(event.api_key_id ? [{ label: "Key", value: event.api_key_id }] : []),
                          ...(showInstalls && event.install_id && event.install_id !== event.user_id
                            ? [{ label: "Install", value: event.install_id }]
                            : []),
                        ]}
                      >
                        <span className="block w-fit">
                          {event.user_id ? <span className="block">{shortId(event.user_id)}</span> : (
                            <span className="block font-sans text-muted-foreground">No end user</span>
                          )}
                          {event.api_key_id ? (
                            <span className="block text-muted-foreground">{shortId(event.api_key_id)}</span>
                          ) : null}
                          {showInstalls && event.install_id && event.install_id !== event.user_id ? (
                            <span className="block text-muted-foreground">{shortId(event.install_id)}</span>
                          ) : null}
                        </span>
                      </FullIds>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {/* The provider as a mark, its name and the gateway that
                          carried the request in the hover. */}
                      <span className="inline-flex items-center gap-1.5">
                        {isProviderType(event.provider) ? (
                          <Hint
                            content={`${event.provider_slug ?? event.provider}${event.provider_gateway_type ? ` via ${event.provider_gateway_type}` : ""}`}
                          >
                            <span className="inline-flex"><ProviderIcon type={event.provider} /></span>
                          </Hint>
                        ) : null}
                        {/* A passthrough call names no model: the gateway never read one. */}
                        {isPassthroughEvent(event) ? <Unreported what="model" /> : event.model}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-56 font-mono text-xs whitespace-normal text-muted-foreground">
                      {event.endpoint_slug ? <span className="block">{event.endpoint_slug} →</span> : null}
                      <span className="block">
                        {/* A long path, such as Gemini's with the model in it,
                            wraps after a separator rather than widening the table. */}
                        {routePath(event).split(/(?<=[/:])/u).map((part, index) => (
                          <span key={index}>{index > 0 ? <wbr /> : null}{part}</span>
                        ))}
                      </span>
                      {/* Observed, not configured: only shown when the upstream
                          named the host that actually served the request. */}
                      {event.served_provider ? (
                        <span className="block">Served by {event.served_provider}</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="tabular text-right text-xs">
                      {isPassthroughEvent(event) && totalTokens(event) === 0
                        ? <Unreported what="tokens" />
                        : formatCompact(totalTokens(event))}
                    </TableCell>
                    <TableCell className="tabular text-right text-xs whitespace-nowrap">
                      {event.latency_ms === null ? "—" : `${formatNumber(event.latency_ms)} ms`}
                    </TableCell>
                    <TableCell className="tabular text-right text-xs">
                      {/* An unresolved event was not billed because its usage
                          was unreadable, so showing $0.00 would be a claim the
                          gateway cannot make. */}
                      {isPassthroughEvent(event) && event.cost_source !== "reported" ? (
                        <Unreported what="cost" />
                      ) : event.cost_source === "unresolved" ? (
                        <Hint
                          description="The provider answered successfully but reported no usage this gateway could read, so this request consumed no budget."
                          content={<span className="block max-w-64">The provider answered successfully but reported no usage this gateway could read, so this request consumed no budget.</span>}
                        >
                          <span className="text-amber-600 dark:text-amber-400">unresolved</span>
                        </Hint>
                      ) : event.cost_source === "estimated" ? (
                        <Hint
                          description="Billed at an estimate: the price list has no price for this service mode on this model, or the request named a mode the gateway does not know."
                          content={<span className="block max-w-64">Billed at an estimate: the price list has no price for this service mode on this model, or the request named a mode the gateway does not know. Add a price for the mode under the provider's custom model pricing to bill it exactly.</span>}
                        >
                          <span className="text-amber-600 dark:text-amber-400">≈{formatCost(event.cost_usd)}</span>
                        </Hint>
                      ) : (
                        // A reported cost is what the provider charged, not
                        // what this deployment's catalog estimates — worth
                        // saying, because the two can differ.
                        <Hint
                          content={
                            event.cost_source === "reported"
                              ? isPassthroughEvent(event)
                                ? "Non-standard path: cost reported by the provider for this request."
                                : "Cost reported by the provider for this request."
                              : undefined
                          }
                        >
                          <span>{formatCost(event.cost_usd)}</span>
                        </Hint>
                      )}
                      {/* The mode that served it, where not the standard one:
                          beside the cost, because it is what set the price. */}
                      {event.service_mode ? (
                        <span className="mt-1 flex justify-end">
                          <ServiceModeLabel
                            mode={event.service_mode}
                            factor={factor}
                            estimated={event.cost_source === "estimated" || factor === undefined}
                          />
                        </span>
                      ) : null}
                      {/* Only a failure is marked: a served request is every
                          ordinary row, and a badge on each would hide the few
                          that failed. */}
                      {event.status !== "ok" ? (
                        <span className="mt-1 flex justify-end">
                          <EventStatusLabel status={event.status} upstreamStatus={event.upstream_status} errorCode={event.error_code} />
                        </span>
                      ) : null}
                    </TableCell>
                  </TableRow>
                  );
                })
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
