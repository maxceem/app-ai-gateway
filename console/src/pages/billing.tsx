import { useState } from "react";
import { AlertCircle, Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { PageHeader } from "@/components/field";
import { GuardedButton } from "@/components/guarded-button";
import { useConsoleSession } from "@/lib/console-session";
import {
  billingNotice,
  canResume,
  formatPrice,
  priceFor,
  quotaMeter,
  subscriptionTimeline,
  type QuotaMeter,
} from "@/lib/billing";
import { cn } from "@/lib/utils";
import {
  useBillingPlans,
  useBillingStatus,
  useCancelSubscription,
  useResumeSubscription,
  useStartCheckout,
} from "@/lib/queries";
import type { BillingAccess, BillingPlan, OrganizationQuota } from "@/lib/types";

type Period = "month" | "year";

export function BillingPage() {
  const { capabilities } = useConsoleSession();
  const [period, setPeriod] = useState<Period>("month");
  const [confirmCancel, setConfirmCancel] = useState(false);

  const status = useBillingStatus(capabilities.billing);
  const plans = useBillingPlans(capabilities.billing);
  const checkout = useStartCheckout();
  const cancel = useCancelSubscription();
  const resume = useResumeSubscription();

  const access = status.data?.access;
  const quota = status.data?.quota;

  const subscribe = async (plan: BillingPlan) => {
    try {
      const { url } = await checkout.mutateAsync({ planKey: plan.planKey, billingPeriod: period });
      window.location.assign(url);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not start checkout");
    }
  };

  const doCancel = async () => {
    try {
      await cancel.mutateAsync();
      toast.success("Subscription canceled");
      setConfirmCancel(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not cancel the subscription");
    }
  };

  const doResume = async () => {
    if (!access?.planKey) return;
    try {
      const result = await resume.mutateAsync({
        planKey: access.planKey,
        billingPeriod: access.billingPeriod ?? period,
      });
      if (result.requiredActionUrl) {
        window.location.assign(result.requiredActionUrl);
        return;
      }
      toast.success("Subscription resumed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not resume the subscription");
    }
  };

  // The page already renders the allowance in full below, so a banner repeating
  // it would be noise; only a subscription problem is worth restating here.
  const notice = billingNotice(access);

  return (
    <div className="space-y-6">
      <PageHeader title="Billing" description="Manage this organization’s subscription." />

      {status.isError ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Could not load billing status</AlertTitle>
          <AlertDescription>
            {status.error instanceof Error ? status.error.message : "Unknown error"}
          </AlertDescription>
        </Alert>
      ) : null}

      {notice ? (
        <Alert variant={notice.tone === "destructive" ? "destructive" : "default"}>
          <AlertCircle />
          <AlertTitle>{notice.title}</AlertTitle>
          <AlertDescription>{notice.description}</AlertDescription>
        </Alert>
      ) : null}

      <SubscriptionCard
        access={access}
        quota={quota}
        pending={status.isPending}
        cancelPending={cancel.isPending}
        resumePending={resume.isPending}
        onCancel={() => setConfirmCancel(true)}
        onResume={() => void doResume()}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">Plans</h2>
        <Tabs value={period} onValueChange={(value) => setPeriod(value as Period)}>
          <TabsList>
            <TabsTrigger value="month">Monthly</TabsTrigger>
            <TabsTrigger value="year">Yearly</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {plans.isPending ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((entry) => (
            <Skeleton key={entry} className="h-52 w-full" />
          ))}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(plans.data?.plans ?? []).map((plan) => (
            <PlanCard
              key={plan.planKey}
              plan={plan}
              period={period}
              current={access?.planKey === plan.planKey}
              pending={checkout.isPending}
              onSubscribe={() => void subscribe(plan)}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="Cancel subscription"
        description={
          <p>
            Gateway traffic keeps working until the end of the current period, then stops until you
            resubscribe.
          </p>
        }
        confirmLabel="Cancel subscription"
        destructive
        pending={cancel.isPending}
        onConfirm={() => void doCancel()}
      />
    </div>
  );
}

function SubscriptionCard({
  access,
  quota,
  pending,
  cancelPending,
  resumePending,
  onCancel,
  onResume,
}: {
  access: BillingAccess | undefined;
  quota: OrganizationQuota | null | undefined;
  pending: boolean;
  cancelPending: boolean;
  resumePending: boolean;
  onCancel: () => void;
  onResume: () => void;
}) {
  const timeline = access ? subscriptionTimeline(access) : null;
  const resumable = access ? canResume(access) : false;
  const meter = quotaMeter(quota);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Current subscription</CardTitle>
        <CardDescription>
          {pending ? "Loading…" : (access?.planName ?? access?.planKey ?? "No plan")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {pending ? (
          <Skeleton className="h-6 w-40" />
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <StatusBadge access={access} />
            {timeline ? (
              <span className="text-sm text-muted-foreground">
                {timeline.label} <span className="tabular text-foreground">{timeline.value}</span>
              </span>
            ) : null}
          </div>
        )}

        {meter && !pending ? <AllowanceMeter meter={meter} /> : null}

        {access && !pending ? (
          <div className="flex flex-wrap gap-2">
            {resumable ? (
              <GuardedButton
                variant="outline"
                size="sm"
                disabled={resumePending || !access.planKey}
                onClick={onResume}
              >
                {resumePending ? <Loader2 className="size-4 animate-spin" /> : null}
                Resume subscription
              </GuardedButton>
            ) : access.status !== "inactive" ? (
              <GuardedButton
                variant="outline"
                size="sm"
                disabled={cancelPending}
                onClick={onCancel}
              >
                Cancel subscription
              </GuardedButton>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

const METER_FILL: Record<QuotaMeter["tone"], string> = {
  normal: "bg-primary",
  warning: "bg-amber-500",
  destructive: "bg-destructive",
};

/**
 * The month's requests against the plan's allowance.
 *
 * The only place either number is visible: the count lives in the gateway's
 * quota object, not in the usage tables, so without this an operator learns the
 * allowance is gone from their users rather than from here.
 */
function AllowanceMeter({ meter }: { meter: QuotaMeter }) {
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm text-muted-foreground">Requests this month</span>
        <span className="tabular text-sm font-medium">{meter.label}</span>
      </div>
      {meter.ratio === null ? null : (
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
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
      )}
      <p className="text-xs text-muted-foreground">{meter.caption}</p>
    </div>
  );
}

function StatusBadge({ access }: { access: BillingAccess | undefined }) {
  if (!access) return <Badge variant="secondary">Unknown</Badge>;
  if (access.status === "active") return <Badge>Active</Badge>;
  if (access.status === "trialing") return <Badge variant="secondary">Trialing</Badge>;
  return <Badge variant="destructive">Inactive</Badge>;
}

function PlanCard({
  plan,
  period,
  current,
  pending,
  onSubscribe,
}: {
  plan: BillingPlan;
  period: Period;
  current: boolean;
  pending: boolean;
  onSubscribe: () => void;
}) {
  const price = priceFor(plan, period);

  return (
    <Card className={current ? "border-primary" : undefined}>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm">{plan.name}</CardTitle>
          {current ? <Badge variant="secondary">Current</Badge> : null}
        </div>
        <CardDescription>{plan.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="tabular text-2xl font-semibold">
          {price ? formatPrice(price) : "—"}
        </p>
        {plan.trialDays > 0 && !current ? (
          <p className="text-xs text-muted-foreground">{plan.trialDays}-day free trial</p>
        ) : null}
        {plan.features.length > 0 ? (
          <ul className="space-y-1.5">
            {plan.features.map((feature) => (
              <li key={feature} className="flex items-start gap-2 text-sm text-muted-foreground">
                <Check className="mt-0.5 size-3.5 shrink-0 text-foreground" />
                {feature}
              </li>
            ))}
          </ul>
        ) : null}
        <GuardedButton
          className="w-full"
          variant={current ? "outline" : "default"}
          disabled={pending || !price}
          onClick={onSubscribe}
        >
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          {current ? "Change billing period" : "Subscribe"}
        </GuardedButton>
      </CardContent>
    </Card>
  );
}
