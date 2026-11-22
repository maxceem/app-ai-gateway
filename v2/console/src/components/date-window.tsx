/**
 * The days a filtered list reads, and the buttons that move them.
 *
 * A filter with no index of its own reads at most 31 days at a time; without
 * a range the gateway reads the last 30 (Sol 7b-6). So a filtered list says
 * which days it shows, and steps back through the 90 days kept, one slice of
 * at most 31 UTC days at a time, rather than quietly hiding older records.
 */
import { Button } from "@/components/ui/button";
import { daysAgo } from "@/lib/format";

/** How long charges and sign-in records are kept. */
export const KEPT_DAYS = 90;
/** The most days one filtered read covers. */
export const WINDOW_DAYS = 31;

export interface DateWindow {
  from: string;
  to: string;
  canEarlier: boolean;
  canLater: boolean;
}

/**
 * The oldest UTC day the gateway still keeps: the day {@link KEPT_DAYS} before
 * today, as its retention cuts it (`detailCutoffDay`, and events dropped only
 * once older than 90 days to the millisecond). A list must reach it (Sol 7b-6 round 2).
 */
export const oldestKeptDay = () => daysAgo(KEPT_DAYS);

/**
 * The days a list reads at window `step` (0 is the newest): the newest slice
 * first, each step back the 31 days before it, cut at the oldest day kept.
 */
export function windowAt(step: number): DateWindow {
  const oldest = oldestKeptDay();
  const to = daysAgo(step * WINDOW_DAYS);
  const start = daysAgo(step * WINDOW_DAYS + WINDOW_DAYS - 1);
  const from = start < oldest ? oldest : start;
  return { from, to, canEarlier: from > oldest, canLater: step > 0 };
}

/** The window's days, and buttons to move it. */
export function DateWindowNav({
  range,
  disabled,
  onEarlier,
  onLater,
}: {
  range: DateWindow;
  disabled?: boolean;
  onEarlier: () => void;
  onLater: () => void;
}) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span>
        {range.from} to {range.to}
      </span>
      <Button variant="outline" size="sm" disabled={disabled || !range.canEarlier} onClick={onEarlier}>
        Earlier days
      </Button>
      <Button variant="outline" size="sm" disabled={disabled || !range.canLater} onClick={onLater}>
        Later days
      </Button>
    </div>
  );
}
