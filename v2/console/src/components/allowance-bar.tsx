import { cn } from "@/lib/utils";
import type { QuotaMeter } from "@/lib/billing";

/** The fill for each state of the allowance, shared by every place it is drawn. */
const METER_FILL: Record<QuotaMeter["tone"], string> = {
  normal: "bg-primary",
  warning: "bg-amber-500",
  destructive: "bg-destructive",
};

/**
 * This plan period's requests against the plan's allowance. One component for
 * the billing page and the sidebar, so the two never draw the same figure
 * differently.
 */
export function AllowanceBar({ meter, className }: { meter: QuotaMeter; className?: string }) {
  return (
    <div
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}
      role="progressbar"
      aria-label="Monthly request allowance used"
      aria-valuemin={0}
      aria-valuemax={meter.limit}
      aria-valuenow={meter.used}
      aria-valuetext={meter.label}
    >
      {/* A sliver of a percent would round to nothing, so any use keeps a visible bar. */}
      <div
        className={cn("h-full rounded-full", METER_FILL[meter.tone])}
        style={{ width: `${meter.used > 0 ? Math.max(meter.ratio * 100, 2) : 0}%` }}
      />
    </div>
  );
}
