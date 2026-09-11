import { cn } from "@/lib/utils";
import type { QuotaMeter } from "@/lib/billing";

/** The fill tone for each state of the allowance, shared by every place it is drawn. */
const METER_FILL: Record<QuotaMeter["tone"], string> = {
  normal: "bg-primary",
  warning: "bg-amber-500",
  destructive: "bg-destructive",
};

/**
 * The current plan period's requests drawn against the plan's allowance.
 *
 * One component rather than one per surface: the billing page and the sidebar
 * both report the same number, and a bar that filled differently in the two
 * places would be read as two different readings. The caller supplies only the
 * height it wants; everything the figure means — tone, rounding, the reading
 * announced to assistive technology — is decided here.
 *
 * Renders nothing for a plan with no ceiling: there is no share of an unlimited
 * allowance to draw, and an empty track would read as an untouched one.
 */
export function AllowanceBar({
  meter,
  className,
}: {
  meter: QuotaMeter;
  className?: string;
}) {
  if (meter.ratio === null) return null;

  return (
    <div
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}
      role="progressbar"
      aria-label="Monthly request allowance used"
      aria-valuemin={0}
      aria-valuemax={meter.limit ?? undefined}
      aria-valuenow={meter.used}
      aria-valuetext={meter.label}
    >
      {/*
        A sliver of a percent would round away to nothing, leaving a spent
        allowance indistinguishable from an untouched one, so any non-zero
        count keeps a visible bar.
      */}
      <div
        className={cn("h-full rounded-full", METER_FILL[meter.tone])}
        style={{ width: `${meter.used > 0 ? Math.max(meter.ratio * 100, 2) : 0}%` }}
      />
    </div>
  );
}
