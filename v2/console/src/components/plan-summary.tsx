import { Link, useLocation } from "react-router-dom";
import { AlertCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AllowanceBar } from "@/components/allowance-bar";
import { billingNotice, entitledPlan, QUOTA_WARNING_RATIO, quotaMeter, quotaNotice } from "@/lib/billing";
import { useConsoleSession } from "@/lib/console-session";
import { useBillingStatus } from "@/lib/queries";
import { cn } from "@/lib/utils";

/**
 * The plan and this period's allowance, at the foot of the sidebar (v1's
 * meter). Only with the billing capability: a self-hosted deployment has no
 * plan. Silent while the reading is missing or unreadable, rather than
 * guessing at a plan.
 */
export function PlanSummary({ onNavigate }: { onNavigate?: () => void }) {
  const { capabilities, canManage, account } = useConsoleSession();
  const status = useBillingStatus(capabilities.billing, account.id);
  const location = useLocation();
  if (!capabilities.billing || !status.data) return null;

  const plan = entitledPlan(status.data.access);
  const meter = quotaMeter(status.data.allowance);
  if (!plan && !meter) return null;

  const current = location.pathname === "/billing";
  // Offered on the free plan, with no plan, or with the allowance nearly gone:
  // otherwise a paying account is told what it has, and sold nothing.
  const nearlySpent = meter !== null && meter.ratio >= QUOTA_WARNING_RATIO;
  const changeable = plan === null || plan.isDefault || nearlySpent;

  return (
    <div className={cn("rounded-lg px-3 py-2.5 transition-colors", current ? "bg-sidebar-accent text-sidebar-accent-foreground" : "bg-sidebar-accent/40")}>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium">{plan ? `${plan.planName} plan` : "No plan"}</span>
        {changeable ? (
          <Link
            to="/billing"
            onClick={onNavigate}
            aria-current={current ? "page" : undefined}
            className="shrink-0 rounded-sm text-xs font-medium underline underline-offset-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {canManage ? "Upgrade" : "View plan"}
          </Link>
        ) : null}
      </div>
      {meter ? (
        <div className="mt-1.5 space-y-1">
          <p className="tabular text-[11px] text-muted-foreground">{meter.label}</p>
          <AllowanceBar meter={meter} className="h-1" />
        </div>
      ) : null}
    </div>
  );
}

/**
 * A billing warning above every page: an allowance nearly or entirely spent,
 * no plan, an ended subscription, or a payment past due. Never with billing
 * off, and not on the billing page, which states all of it beside its controls.
 */
export function BillingBanner() {
  const { capabilities, account } = useConsoleSession();
  const status = useBillingStatus(capabilities.billing, account.id);
  const location = useLocation();
  if (!capabilities.billing || !status.data || location.pathname === "/billing") return null;
  const notice = quotaNotice(status.data.allowance) ?? billingNotice(status.data.access, status.data.limits);
  if (!notice) return null;
  return (
    <Alert variant={notice.tone === "destructive" ? "destructive" : "default"} className="mb-6">
      <AlertCircle />
      <AlertTitle>{notice.title}</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center gap-3">
        <span>{notice.description}</span>
        {notice.actionable ? (
          <Button asChild size="sm" variant="outline">
            <Link to="/billing">View plans</Link>
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
