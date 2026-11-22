/**
 * The days a filtered list reads, and the buttons that move them.
 *
 * A filter with no index of its own reads at most 31 days at a time; without
 * a range the gateway reads the last 30 (Sol 7b-6). So a filtered list says
 * which days it shows, and steps back through the 90 days kept, one slice of
 * at most 31 UTC days at a time, rather than quietly hiding older records.
 */
import { useState } from "react";
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
  earlier: () => void;
  later: () => void;
  reset: () => void;
}

/** The newest slice first; each step back is the 31 days before it, cut at the oldest day kept. */
export function useDateWindow(): DateWindow {
  const [step, setStep] = useState(0);
  const oldest = daysAgo(KEPT_DAYS - 1);
  const to = daysAgo(step * WINDOW_DAYS);
  const start = daysAgo(step * WINDOW_DAYS + WINDOW_DAYS - 1);
  const from = start < oldest ? oldest : start;
  return {
    from,
    to,
    canEarlier: from > oldest,
    canLater: step > 0,
    earlier: () => setStep((current) => current + 1),
    later: () => setStep((current) => Math.max(0, current - 1)),
    reset: () => setStep(0),
  };
}

/** The window's days, and buttons to move it. `onMove` runs on every move, for the list to start its pages again. */
export function DateWindowNav({ range, disabled, onMove }: { range: DateWindow; disabled?: boolean; onMove: () => void }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span>
        {range.from} to {range.to}
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={disabled || !range.canEarlier}
        onClick={() => {
          range.earlier();
          onMove();
        }}
      >
        Earlier days
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={disabled || !range.canLater}
        onClick={() => {
          range.later();
          onMove();
        }}
      >
        Later days
      </Button>
    </div>
  );
}
