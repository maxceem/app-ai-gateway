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

/** Gateway costs are often fractions of a cent, so small values keep more digits. */
export function formatCost(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return formatCostToCent(value);
}

/**
 * The same to the nearest cent, with no sub-cent case. For totals — a day's
 * spend on one provider — where a hundredth of a cent is noise, and a column
 * of amounts that change length row by row is harder to read than that
 * precision is worth. A single request's cost keeps {@link formatCost}, where
 * the fraction of a cent is the whole answer.
 */
export function formatCostToCent(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value < 100) return `$${value.toFixed(2)}`;
  return `$${plain.format(Math.round(value))}`;
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
