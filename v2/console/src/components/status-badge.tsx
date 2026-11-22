import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** Waits and recoveries read amber; anything else that is not `ok` reads as a failure. */
const OUTCOME_TONES: Record<string, string> = {
  ok: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
  issuer_claims_missing: "border-amber-500/40 text-amber-600 dark:text-amber-400",
  issuer_verification_unavailable: "border-amber-500/40 text-amber-600 dark:text-amber-400",
  service_unavailable: "border-amber-500/40 text-amber-600 dark:text-amber-400",
  // The app reported a failure it got past by itself, such as a key lost to a
  // reinstall: worth seeing, not a sign-in that failed.
  client_recovered: "border-amber-500/40 text-amber-600 dark:text-amber-400",
};

/** A sign-in attempt's outcome, or a failure cause in the summary, as v1 shows it. */
export function AuthOutcomeBadge({ outcome }: { outcome: string }) {
  return (
    <Badge
      variant="outline"
      className={cn("font-mono text-[11px] font-normal", OUTCOME_TONES[outcome] ?? "border-destructive/40 text-destructive")}
    >
      {outcome}
    </Badge>
  );
}
