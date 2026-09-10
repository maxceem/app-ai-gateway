import { Badge } from "@/components/ui/badge";
import type { UsageStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

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

const EVENT_TONES: Record<UsageStatus, string> = {
  ok: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
  provider_error: "border-destructive/40 text-destructive",
  blocked_app_rate: "border-amber-500/40 text-amber-600 dark:text-amber-400",
  blocked_app_budget: "border-amber-500/40 text-amber-600 dark:text-amber-400",
  blocked_billing: "border-amber-500/40 text-amber-600 dark:text-amber-400",
  blocked_user: "border-amber-500/40 text-amber-600 dark:text-amber-400",
};

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
  blocked_app_rate: "Refused by this app's own rate limit, which you set",
  blocked_app_budget: "Refused by this app's own monthly budget, which you set",
  blocked_billing: "Refused: your plan's monthly request allowance was exhausted",
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
