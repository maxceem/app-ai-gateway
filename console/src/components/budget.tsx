import { cn } from "@/lib/utils";
import { formatCost } from "@/lib/format";

/** The fill tone for each state of the budget, shared by every place it is drawn. */
const BUDGET_FILL = {
  normal: "bg-primary",
  warning: "bg-amber-500",
  destructive: "bg-destructive",
} as const;

/**
 * Where the fill turns amber.
 *
 * Its own number rather than the plan meter's `QUOTA_WARNING_RATIO`, which is
 * the line a *billing* notice is raised on. The two happen to agree today, and
 * importing that one here would mean moving the plan's alerting threshold
 * silently re-toned every app's spending bar.
 */
const BUDGET_WARNING_RATIO = 0.8;

/**
 * An app's spend this month drawn against the budget its organization set for
 * the whole app.
 *
 * Deliberately not {@link AllowanceBar}, which the two look alike enough to
 * invite. That one is requests against the plan the organization pays for; this
 * one is dollars against a ceiling the organization chose for one of its own
 * apps. They are the two unrelated quota systems, and one component would put
 * the first's wording, tone and thresholds on the second the moment either
 * moved.
 *
 * Renders nothing for an app with no budget: there is no share of an unlimited
 * one to draw, and an empty track would read as an untouched budget rather than
 * an absent one — which is why the figure beside it says so with a sign.
 *
 * Fills its container unless the caller says otherwise. A list of these is only
 * comparable at one width, so a caller drawing several gives them all the same
 * one rather than letting each take the width of the figures above it.
 */
export function BudgetBar({
  spent,
  budget,
  className,
}: {
  spent: number;
  /** `null` is unlimited, as everywhere in limits. */
  budget: number | null;
  className?: string;
}) {
  if (budget === null) return null;
  // A budget of zero admits no spending at all, and dividing by it would leave
  // the bar with no reading, so it reads as fully spent — which it is.
  const ratio = budget > 0 ? Math.min(spent / budget, 1) : 1;
  const tone = ratio >= 1 ? "destructive" : ratio >= BUDGET_WARNING_RATIO ? "warning" : "normal";

  return (
    <div
      className={cn("h-1 w-full overflow-hidden rounded-full bg-muted", className)}
      role="progressbar"
      aria-label="Monthly budget used"
      aria-valuemin={0}
      aria-valuemax={budget}
      aria-valuenow={spent}
      aria-valuetext={`${formatCost(spent)} of ${formatCost(budget)}`}
    >
      {/*
        A sliver of a percent would round away to nothing, leaving a budget that
        has been spent against indistinguishable from an untouched one, so any
        non-zero spend keeps a visible bar.
      */}
      <div
        className={cn("h-full rounded-full", BUDGET_FILL[tone])}
        style={{ width: `${spent > 0 ? Math.max(ratio * 100, 2) : 0}%` }}
      />
    </div>
  );
}

/**
 * How wide every budget bar is drawn.
 *
 * One number for both tables. A bar as wide as its own figures would make two
 * rows at the same share of their budgets look like different readings, and two
 * tables at different widths would do the same across pages.
 */
const BAR_WIDTH = "w-28";

/**
 * The month's spend, the budget it is measured against, and the bar between
 * them — the whole of a budget column's cell.
 *
 * One component for the apps list and an app's users, which show the same
 * measurement at two scopes: a whole app against its budget, and one user
 * against theirs. Drawing them separately is how the two come to disagree about
 * what an absent budget looks like.
 */
export function BudgetCell({
  spent,
  budget,
}: {
  spent: number;
  /** `null` is unlimited, as everywhere in limits. */
  budget: number | null;
}) {
  return (
    <div className="inline-flex flex-col items-end gap-1">
      <div className="whitespace-nowrap">
        {formatCost(spent)}
        <span className="text-muted-foreground">
          {" / "}
          {budget === null ? (
            // No budget is set, so there is nothing to spend against — the sign
            // says so without a number.
            <span title="No monthly budget">&#8734;</span>
          ) : (
            formatCost(budget)
          )}
        </span>
      </div>
      <BudgetBar spent={spent} budget={budget} className={BAR_WIDTH} />
    </div>
  );
}
