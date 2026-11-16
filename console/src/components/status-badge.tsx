import { useId } from "react";
import { Badge } from "@/components/ui/badge";
import type { UsageStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { parseServiceModeName, SERVICE_TIERS } from "@shared/service-modes";
import { Circle, Leaf, MapPin, Zap } from "lucide-react";
import { Hint } from "@/components/hint";

/**
 * Says an app is off, and says nothing at all when it is on.
 *
 * Working is the ordinary state of every app in the list, so a badge for it is
 * a word beside every name that never varies — and it makes the one app that
 * is off harder to spot, not easier, by giving it the same shape as the rest.
 */
export function AppStatusBadge({ status }: { status: "active" | "disabled" }) {
  if (status === "active") return null;

  return (
    <Badge variant="outline" className="gap-1.5 border-muted-foreground/30 text-muted-foreground">
      <span className="size-1.5 rounded-full bg-muted-foreground" />
      disabled
    </Badge>
  );
}


/**
 * What each stored status means, in words.
 *
 * The badge keeps showing the raw value, because that is what the API filters
 * on and what a log line says; the sentence is the hover. Each sentence has to
 * name *which* system refused the request, because that is the one thing the
 * raw value cannot say on its own and the one thing an operator is asking.
 */
export const USAGE_STATUS_LABELS: Record<UsageStatus, string> = {
  ok: "Served by the provider",
  provider_error: "The provider refused or failed the request",
};

/**
 * A solid disc with a bold cross cut out of it. Two thick strokes stay
 * readable at twelve pixels where an exclamation mark's thin ones break up,
 * and the cut-out shows the row behind it, tinted or not.
 */
function ErrorMark() {
  const mask = useId();
  return (
    <svg viewBox="0 0 16 16" className="size-3 shrink-0" aria-hidden>
      <mask id={mask}>
        <rect width="16" height="16" fill="white" />
        <path d="M5.4 5.4l5.2 5.2M10.6 5.4l-5.2 5.2" stroke="black" strokeWidth="2.4" strokeLinecap="round" />
      </mask>
      <circle cx="8" cy="8" r="8" fill="currentColor" mask={`url(#${mask})`} />
    </svg>
  );
}

/** The HTTP statuses a provider fails with, in words. */
const HTTP_STATUS_NAMES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  408: "Request Timeout",
  409: "Conflict",
  413: "Payload Too Large",
  422: "Unprocessable Content",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  529: "Overloaded",
};

/** What the gateway records when the provider never answered, in words. */
/** What a failure that names no HTTP status means, in words. */
const NO_ANSWER: Record<string, { short: string; long: string }> = {
  timeout: { short: "timeout", long: "The provider did not answer in time." },
  connection_failed: { short: "no connection", long: "The gateway could not reach the provider." },
  provider_error: { short: "provider_error", long: "The provider refused or failed the request. Its cause was not recorded." },
};

/**
 * A usage event's status, in the same quiet style as the mode beside it: a
 * solid mark and what went wrong, `429` with the provider's code under it, or
 * `timeout` where it never answered. The hover says it in words. A served
 * request is every ordinary row, so it is shown as nothing at all.
 */
export function EventStatusLabel({ error }: {
  /**
   * The event's `error`: `429 rate_limit_exceeded`, `502`, `timeout`, or
   * `provider_error` for a failure recorded before causes were. None on a
   * served request, which shows nothing.
   */
  error?: string | null;
}) {
  if (!error) return null;
  const status: UsageStatus = "provider_error";
  const [first = "", ...rest] = error.split(" ");
  const upstreamStatus = /^\d{3}$/u.test(first) ? Number(first) : null;
  const errorCode = upstreamStatus ? rest.join(" ") || null : error;
  const noAnswer = errorCode && !upstreamStatus ? NO_ANSWER[errorCode] : undefined;
  const headline = upstreamStatus ? String(upstreamStatus) : noAnswer?.short ?? "error";
  const code = upstreamStatus && errorCode ? errorCode : null;
  const name = upstreamStatus ? HTTP_STATUS_NAMES[upstreamStatus] : undefined;
  const said = upstreamStatus
    ? `The provider answered ${upstreamStatus}${name ? ` ${name}` : ""}${code ? `: ${code}` : ""}`
    : noAnswer?.long ?? USAGE_STATUS_LABELS[status];
  return (
    <Hint
      description={said}
      content={
        <span className="block max-w-72 space-y-0.5">
          <span className="block font-medium">
            {upstreamStatus
              ? `The provider answered ${upstreamStatus}${name ? ` ${name}` : ""}`
              : noAnswer?.long ?? USAGE_STATUS_LABELS[status]}
          </span>
          {code ? <span className="block font-mono opacity-80">{code}</span> : null}
          {upstreamStatus ? <span className="block opacity-80">{USAGE_STATUS_LABELS[status]}.</span> : null}
        </span>
      }
    >
      {/* One line: the mark, the status, then the provider's code, cut short
          where it is long; the hover has it whole. */}
      <span className="inline-flex max-w-44 items-center gap-1 text-xs leading-none whitespace-nowrap text-destructive">
        <ErrorMark />
        {/* A status where the provider answered; where it never did, the
            gateway's own code, set like the provider's. */}
        {upstreamStatus ? <span className="font-medium tabular-nums">{headline}</span> : null}
        {code || noAnswer ? (
          <span className="min-w-0 truncate font-mono text-[11px] opacity-80">{code ?? errorCode}</span>
        ) : !upstreamStatus ? (
          <span className="font-medium">{headline}</span>
        ) : null}
      </span>
    </Hint>
  );
}

/**
 * The service mode a request was served and billed in, where it is not the
 * standard one: a mark, the mode's name and how many times the standard price
 * it costs, `⚡ fast ×2`. Amber where it costs more than standard, green where
 * less, grey where the same or not known. Plain text rather than a badge, so
 * it reads as a note on the price beside it; the hover says it in words.
 */
export function ServiceModeLabel({ mode, factor, estimated = false }: {
  mode: string;
  /** The factor the price list sets the mode at against the standard price, where known. */
  factor?: number;
  /** The request was billed at an estimate, for want of a price in this mode. */
  estimated?: boolean;
}) {
  const parsed = parseServiceModeName(mode);
  // Without a factor, the tier says which way the price went; a region alone says nothing.
  const direction = factor !== undefined
    ? Math.sign(factor - 1)
    : parsed ? Math.sign(SERVICE_TIERS[parsed.tier].rank - SERVICE_TIERS.standard.rank) : 0;
  const tone = direction > 0
    ? "text-amber-700 dark:text-amber-400"
    : direction < 0
      ? "text-emerald-700 dark:text-emerald-400"
      : "text-muted-foreground";
  // Solid marks: a bolt for a faster tier, a leaf for a cheaper one, a pin
  // for a region alone, and a dot for a mode this console cannot read.
  const Mark = !parsed ? Circle : parsed.tier === "flex" ? Leaf : parsed.tier !== "standard" ? Zap : MapPin;
  return (
    <Hint
      description={`${describeMode(mode)}${factor !== undefined ? `, ${formatFactor(factor)} times the standard price` : ""}`}
      content={
        <span className="block max-w-64 space-y-0.5">
          <span className="block font-medium">{describeMode(mode)}</span>
          <span className="block opacity-80">
            {estimated
              ? "No price for this mode on this model, so the cost is an estimate."
              : factor === undefined
                ? "Its price depends on the model; each request shows its own."
              : factor === 1
                ? "The price list sets it at the standard price."
                : `The price list sets it at ${formatFactor(factor)} times the standard price.`}
          </span>
          
        </span>
      }
    >
      <span className={cn("inline-flex items-center gap-1 text-xs leading-none whitespace-nowrap", tone)}>
        <Mark className={cn("shrink-0", Mark === Circle ? "size-2" : "size-3")} fill="currentColor" strokeWidth={1.5} aria-hidden />
        <span>{mode}</span>
        {factor !== undefined ? <span className="font-semibold tabular-nums">×{formatFactor(factor)}</span> : null}
      </span>
    </Hint>
  );
}

/** A mode in words: `Fast tier in the US region`. */
function describeMode(mode: string): string {
  const parsed = parseServiceModeName(mode);
  if (!parsed) return `The ${mode} service mode`;
  const tier = parsed.tier === "standard" ? "" : `${parsed.tier[0]!.toUpperCase()}${parsed.tier.slice(1)} tier`;
  const region = parsed.region === "global" ? "" : `${parsed.region.toUpperCase()} region`;
  return tier && region ? `${tier} in the ${region}` : tier || region;
}

/** A price multiplier as people write one: 2, 0.5, 1.1, 2.2. */
function formatFactor(factor: number): string {
  return String(Number(factor.toFixed(2)));
}

/**
 * Tones for authentication outcomes, keyed by what the operator should do.
 *
 * `issuer_claims_missing` is amber, not red: the token was valid and the user
 * is simply waiting for an entitlement to propagate. Colouring it as a failure
 * would restage the confusion the separate code exists to end. Unlisted codes —
 * and every future one — fall back to red, because an unrecognised refusal is
 * still a refusal.
 */
const OUTCOME_TONES: Record<string, string> = {
  ok: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
  issuer_claims_missing: "border-amber-500/40 text-amber-600 dark:text-amber-400",
  issuer_verification_unavailable: "border-amber-500/40 text-amber-600 dark:text-amber-400",
  service_unavailable: "border-amber-500/40 text-amber-600 dark:text-amber-400",
  // The app reported a failure it got past by itself, such as a key lost to a
  // reinstall: worth seeing, not a sign-in that failed.
  client_recovered: "border-amber-500/40 text-amber-600 dark:text-amber-400",
};

export function AuthOutcomeBadge({ outcome }: { outcome: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "font-mono text-[11px] font-normal",
        OUTCOME_TONES[outcome] ?? "border-destructive/40 text-destructive",
      )}
    >
      {outcome}
    </Badge>
  );
}

export function UserStatusBadge({ status }: { status: "active" | "blocked" }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        status === "blocked"
          ? "border-destructive/40 text-destructive"
          : "border-border text-muted-foreground",
      )}
    >
      {status}
    </Badge>
  );
}
