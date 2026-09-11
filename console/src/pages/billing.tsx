import { useState } from "react";
import { AlertCircle, Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AllowanceBar } from "@/components/allowance-bar";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { PageHeader } from "@/components/field";
import { GuardedButton } from "@/components/guarded-button";
import { useConsoleSession } from "@/lib/console-session";
import {
  billingNotice,
  canCancel,
  canResume,
  entitledPlan,
  formatPrice,
  planAction,
  priceFor,
  quotaMeter,
  subscriptionOf,
  subscriptionTimeline,
  type PlanAction,
  type QuotaMeter,
} from "@/lib/billing";
import { cn } from "@/lib/utils";
import {
  useBillingPlans,
  useBillingStatus,
  useCancelSubscription,
  useChangePlan,
  useResumeSubscription,
  useStartCheckout,
} from "@/lib/queries";
import type { BillingAccess, BillingPlan, OrganizationQuota } from "@/lib/types";

type Period = "month" | "year";

export function BillingPage() {
  const { capabilities } = useConsoleSession();
  const [period, setPeriod] = useState<Period>("month");
  const [confirmCancel, setConfirmCancel] = useState(false);
  // The plan a change was asked for, held until it is confirmed: unlike a
  // checkout, which asks for the card on the provider's own page, a change on a
  // live subscription bills without another screen in between.
  const [confirmChange, setConfirmChange] = useState<BillingPlan | null>(null);

  const status = useBillingStatus(capabilities.billing);
  const plans = useBillingPlans(capabilities.billing);
  const checkout = useStartCheckout();
  const change = useChangePlan();
  const cancel = useCancelSubscription();
  const resume = useResumeSubscription();

  const access = status.data?.access;
  const quota = status.data?.quota;
  const catalog = plans.data?.plans ?? [];

  const subscribe = async (plan: BillingPlan) => {
    try {
      const { url } = await checkout.mutateAsync({ planKey: plan.planKey, billingPeriod: period });
      window.location.assign(url);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not start checkout");
    }
  };

  const doChange = async () => {
    if (!confirmChange) return;
    try {
      // The subscription's own period, not the page's: a change must not
      // silently move a yearly subscription onto a monthly schedule.
      const result = await change.mutateAsync({
        planKey: confirmChange.planKey,
        billingPeriod: subscriptionOf(access)?.billingPeriod ?? period,
      });
      setConfirmChange(null);
      if (result.requiredActionUrl) {
        window.location.assign(result.requiredActionUrl);
        return;
      }
      toast.success(`Moved to ${confirmChange.name}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not change the plan");
    }
  };

  // A plan card acts on whichever route the billing contract serves for it.
  const act = (plan: BillingPlan, action: PlanAction) => {
    if (action.intent === "checkout") return void subscribe(plan);
    if (action.intent === "change") return setConfirmChange(plan);
    if (action.intent === "cancel") return setConfirmCancel(true);
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
    // Resuming acts on the subscription, which is not necessarily the plan the
    // organization is currently entitled to.
    const subscription = subscriptionOf(access);
    if (!subscription) return;
    try {
      const result = await resume.mutateAsync({
        planKey: subscription.planKey,
        billingPeriod: subscription.billingPeriod ?? period,
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
      <PageHeader title="Billing" />

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
        {/* The catalog is monthly-only today; a period toggle whose Yearly tab
            prices every plan as "—" reads as a broken purchase path. */}
        {catalog.some((plan) => priceFor(plan, "year")) ? (
          <Tabs value={period} onValueChange={(value) => setPeriod(value as Period)}>
            <TabsList>
              <TabsTrigger value="month">Monthly</TabsTrigger>
              <TabsTrigger value="year">Yearly</TabsTrigger>
            </TabsList>
          </Tabs>
        ) : null}
      </div>

      {plans.isPending ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((entry) => (
            <Skeleton key={entry} className="h-52 w-full" />
          ))}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {catalog.map((plan) => {
            const action = planAction(plan, catalog, access);
            return (
              <PlanCard
                key={plan.planKey}
                plan={plan}
                period={period}
                action={action}
                pending={checkout.isPending || change.isPending}
                onAct={() => act(plan, action)}
              />
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={confirmChange !== null}
        onOpenChange={(open) => setConfirmChange(open ? confirmChange : null)}
        title={`Move to ${confirmChange?.name ?? ""}`}
        description={
          <p>
            Your subscription changes to this plan and its allowance applies from the change. The
            billing provider settles the difference, charging an upgrade right away and putting a
            downgrade on your next invoice.
          </p>
        }
        confirmLabel="Change plan"
        pending={change.isPending}
        onConfirm={() => void doChange()}
      />

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
  const plan = entitledPlan(access);
  const subscription = subscriptionOf(access);
  const timeline = subscription ? subscriptionTimeline(subscription) : null;
  const meter = quotaMeter(quota);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 text-sm">
          Current plan:
          {pending
            ? <Skeleton className="h-4 w-24" />
            : <span>{plan?.planName ?? "No plan"}</span>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {pending ? <Skeleton className="h-6 w-40" /> : null}

        {meter && !pending ? <AllowanceMeter meter={meter} timeline={timeline} /> : null}
        {/* Without an allowance to sit under, the date still belongs on the card. */}
        {!meter && !pending && timeline ? <TimelineLine timeline={timeline} /> : null}

        {/*
          Both buttons act on the subscription, never on the entitled plan: an
          organization dropped onto the free default plan may still have a
          cancelled subscription to resume, and one holding a paid plan through
          a manual grant has nothing to cancel.
        */}
        {!pending && subscription ? (
          <div className="flex flex-wrap gap-2">
            {canResume(subscription) ? (
              <GuardedButton
                variant="outline"
                size="sm"
                disabled={resumePending}
                onClick={onResume}
              >
                {resumePending ? <Loader2 className="size-4 animate-spin" /> : null}
                Resume subscription
              </GuardedButton>
            ) : canCancel(subscription) ? (
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

/**
 * The current plan period's requests against the plan's allowance.
 *
 * The fullest statement of the figure the sidebar also carries: the count lives
 * in the gateway's quota object, not in the usage tables, so without this an
 * operator learns the allowance is gone from their users rather than from here.
 */
function AllowanceMeter({
  meter,
  timeline,
}: {
  meter: QuotaMeter;
  timeline: { label: string; value: string } | null;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm text-muted-foreground">Requests this period</span>
        <span className="tabular text-sm font-medium">{meter.label}</span>
      </div>
      <AllowanceBar meter={meter} />
      {timeline ? <TimelineLine timeline={timeline} /> : null}
    </div>
  );
}

/** The subscription's next date — "Renews Oct 10, 2026". */
function TimelineLine({ timeline }: { timeline: { label: string; value: string } }) {
  return (
    <p className="text-xs text-muted-foreground">
      {timeline.label} <span className="tabular text-foreground">{timeline.value}</span>
    </p>
  );
}

function PlanCard({
  plan,
  period,
  action,
  pending,
  onAct,
}: {
  plan: BillingPlan;
  period: Period;
  action: PlanAction;
  pending: boolean;
  onAct: () => void;
}) {
  const price = priceFor(plan, period);
  // A plan with no price rows at all is the service's free tier: it is not
  // something to buy, it is what a lapsed subscription falls back to.
  const free = plan.prices.length === 0;
  const current = action.intent === "current";

  return (
    <Card className={cn("h-full", current && "border-primary")}>
      <CardHeader>
        <CardTitle className="text-sm">{plan.name}</CardTitle>
        <CardDescription>{plan.description}</CardDescription>
      </CardHeader>
      {/* A column, so the button can sit at the bottom of every card in the row
          rather than wherever this plan's feature list happens to end. */}
      <CardContent className="flex flex-1 flex-col gap-4">
        <p className="tabular text-2xl font-semibold">
          {free ? "Free" : price ? formatPrice(price) : "—"}
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
        {/*
          Every card carries the same control in the same place, so the plans
          read as one row of choices: the plan already held states itself and
          stays inert, and the others name the plan they move you to.
        */}
        <div className="mt-auto pt-2">
          {current ? (
            <Button className="w-full" variant="outline" disabled>
              {action.label}
            </Button>
          ) : (
            <GuardedButton
              className="w-full"
              wrapperClassName="w-full"
              variant={action.variant}
              disabled={pending || (!free && !price)}
              {...(action.reason ? { reason: action.reason } : {})}
              onClick={onAct}
            >
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              {action.label}
            </GuardedButton>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
