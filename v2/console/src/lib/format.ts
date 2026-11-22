const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const plain = new Intl.NumberFormat("en-US");
const percent = new Intl.NumberFormat("en-US", {
  style: "percent",
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export const formatNumber = (value: number | null | undefined): string =>
  value === null || value === undefined ? "—" : plain.format(value);

export const formatCompact = (value: number | null | undefined): string =>
  value === null || value === undefined ? "—" : value < 10_000 ? plain.format(value) : compact.format(value);

export const formatPercent = (value: number | null | undefined): string =>
  value === null || value === undefined ? "—" : percent.format(value);

const dollars = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Dollars, the one way the console shows money. A cent or more
 * keeps its cents, however large: `$1,234.56`. Under a cent, two significant
 * digits, down to the gateway's nano-dollar: a request's whole cost often
 * lives there, and a nonzero amount never reads as zero. A correction's
 * negative amount keeps its sign in front: `-$0.0042`.
 */
export function formatCost(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value === 0) return "$0.00";
  const sign = value < 0 ? "-" : "";
  const size = Math.abs(value);
  if (size >= 0.01) return `${sign}$${dollars.format(size)}`;
  const significant = Number(size.toPrecision(2));
  // Enough decimals for two significant digits, at most nine (one nano-dollar).
  const decimals = Math.min(9, Math.max(3, 1 - Math.floor(Math.log10(significant))));
  const text = significant.toFixed(decimals).replace(/0+$/u, "");
  // Under half a nano-dollar rounds to no digit at all: say so, never `$0.`.
  if (!/[1-9]/u.test(text)) return sign ? ">-$0.000000001" : "<$0.000000001";
  return `${sign}$${text}`;
}

/** A duration a person reads at a glance: seconds under a minute, else minutes. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

/** D1 stores `YYYY-MM-DD HH:MM:SS` in UTC without a zone marker. */
export function parseTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null;
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDateTime(value: string | null | undefined): string {
  const date = parseTimestamp(value);
  return date
    ? date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : "—";
}

/**
 * A usage event's time, short enough for a table: the year only when it is
 * not the current one. `Nov 11, 12:23 PM`.
 */
export function formatEventTime(value: string | null | undefined): string {
  const date = parseTimestamp(value);
  if (!date) return "—";
  const thisYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    ...(thisYear ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatRelative(value: string | null | undefined): string {
  const date = parseTimestamp(value);
  if (!date) return "never";
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["second", 60],
    ["minute", 60],
    ["hour", 24],
    ["day", 30],
    ["month", 12],
    ["year", Number.POSITIVE_INFINITY],
  ];
  let amount = seconds;
  for (const [unit, size] of units) {
    if (Math.abs(amount) < size) {
      return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(-Math.round(amount), unit);
    }
    amount /= size;
  }
  return date.toLocaleDateString();
}

interface TokenUsage {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
}

/** Provider input includes every exclusive input billing bucket. */
export const inputTokens = (usage: TokenUsage): number =>
  usage.input_tokens + usage.cached_input_tokens + usage.cache_write_tokens;

export const cachedInputRate = (usage: TokenUsage): number | null => {
  const total = inputTokens(usage);
  return total === 0 ? null : usage.cached_input_tokens / total;
};

export const totalTokens = (usage: TokenUsage): number =>
  inputTokens(usage) + usage.output_tokens;

export function currentMonth(): string {
  return new Date().toISOString().slice(0, 10).slice(0, 7);
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

export function monthLabel(month: string): string {
  const date = new Date(`${month}-01T00:00:00Z`);
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
}

export function recentMonths(count: number): string[] {
  const months: string[] = [];
  const now = new Date();
  for (let index = 0; index < count; index += 1) {
    months.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - index, 1)).toISOString().slice(0, 7));
  }
  return months;
}
