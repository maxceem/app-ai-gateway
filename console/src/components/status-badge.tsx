import { Badge } from "@/components/ui/badge";
import type { UsageStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

export function AppStatusBadge({ status }: { status: "active" | "disabled" }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5",
        status === "active"
          ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
          : "border-muted-foreground/30 text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          status === "active" ? "bg-emerald-500" : "bg-muted-foreground",
        )}
      />
      {status}
    </Badge>
  );
}

const EVENT_TONES: Record<UsageStatus, string> = {
  ok: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
  provider_error: "border-destructive/40 text-destructive",
  blocked_rate: "border-amber-500/40 text-amber-600 dark:text-amber-400",
  blocked_budget: "border-amber-500/40 text-amber-600 dark:text-amber-400",
  blocked_user: "border-amber-500/40 text-amber-600 dark:text-amber-400",
};

/**
 * What each stored status means, in words.
 *
 * The badge keeps showing the raw value, because that is what the API filters
 * on and what a log line says; the sentence is the hover. `blocked_rate` is the
 * one worth spelling out — the name predates the gateway having a single
 * organization-wide allowance, and it is that allowance it now reports.
 *
 * `blocked_budget` is only ever read, never written: it belongs to events
 * recorded while the gateway still had per-scope spending budgets. Old rows
 * keep rendering, and its label says why it cannot recur.
 */
export const USAGE_STATUS_LABELS: Record<UsageStatus, string> = {
  ok: "Served by the provider",
  provider_error: "The provider refused or failed the request",
  blocked_rate: "Refused: the organization's monthly request allowance was exhausted",
  blocked_budget: "Refused by a spending budget, a quota the gateway no longer has",
  blocked_user: "Refused: this user is blocked",
};

export function EventStatusBadge({ status }: { status: UsageStatus }) {
  return (
    <Badge
      variant="outline"
      className={cn("font-mono text-[11px] font-normal", EVENT_TONES[status])}
      title={USAGE_STATUS_LABELS[status]}
    >
      {status}
    </Badge>
  );
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
