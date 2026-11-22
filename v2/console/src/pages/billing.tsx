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
import type { BillingAccess, BillingPlan, BillingPrice, PlanAllowance, SubscriptionActions } from "@/lib/types";

type Period = "month" | "year";

export function BillingPage() {
  const { capabilities, account } = useConsoleSession();
  const [period, setPeriod] = useState<Period>("month");
  const [confirmCancel, setConfirmCancel] = useState(false);
  // The plan a change was asked for, with the exact price it is made at, held
  // until it is confirmed: unlike a checkout, which asks for the card on the
  // provider's own page, a change on a live subscription bills without
  // another screen in between.
  const [confirmChange, setConfirmChange] = useState<{ plan: BillingPlan; price: BillingPrice } | null>(null);

  const status = useBillingStatus(capabilities.billing);
  const plans = useBillingPlans(capabilities.billing);
  const checkout = useStartCheckout();
  const change = useChangePlan();
  const cancel = useCancelSubscription();
  const resume = useResumeSubscription();

  const access = status.data?.access;
  const allowance = status.data?.allowance;
  const catalog = plans.data?.plans ?? [];
  // Every write names the account and subscription this page showed: the
  // gateway refuses one that has changed since (another tab, another admin).
  const shown = { accountId: account.id, subscriptionId: subscriptionOf(access)?.subscriptionId ?? null };
  // A change keeps the subscription's own period, never the page's toggle: a
  // yearly subscription must not move onto a monthly schedule. The card shows
  // the price for that period, so what is shown is what is submitted.
  const changePeriod: Period = subscriptionOf(access)?.billingPeriod ?? period;

  const subscribe = async (plan: BillingPlan) => {
    try {
      const { url } = await checkout.mutateAsync({ planKey: plan.planKey, billingPeriod: period, accountId: account.id });
      window.location.assign(url);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not start checkout");
    }
  };

  const doChange = async () => {
    if (!confirmChange) return;
    try {
      const result = await change.mutateAsync({
        planKey: confirmChange.plan.planKey,
        billingPeriod: confirmChange.price.billingPeriod,
        ...shown,
      });
      setConfirmChange(null);
      if (result.requiredActionUrl) {
        window.location.assign(result.requiredActionUrl);
        return;
      }
      toast.success(`Moved to ${confirmChange.plan.name}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not change the plan");
    }
  };

  // A plan card acts on whichever route the billing contract serves for it.
  const act = (plan: BillingPlan, action: PlanAction) => {
    if (action.intent === "checkout") return void subscribe(plan);
    if (action.intent === "change") {
      const price = priceFor(plan, changePeriod);
      return price ? setConfirmChange({ plan, price }) : undefined;
    }
    if (action.intent === "cancel") return setConfirmCancel(true);
  };

  const doCancel = async () => {
    try {
      await cancel.mutateAsync(shown);
      toast.success("Subscription canceled");
      setConfirmCancel(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not cancel the subscription");
    }
  };

  const doResume = async () => {
    // Resuming acts on the subscription, which is not necessarily the plan the
    // account is currently entitled to.
    const subscription = subscriptionOf(access);
    if (!subscription) return;
    try {
      const result = await resume.mutateAsync({
        planKey: subscription.planKey,
        billingPeriod: subscription.billingPeriod ?? period,
        ...shown,
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
  const notice = billingNotice(access, status.data?.limits);

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
        allowance={allowance}
        actions={status.data?.actions}
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
            const action = planAction(plan, catalog, access, status.data?.actions);
            return (
              <PlanCard
                key={plan.planKey}
                plan={plan}
                period={action.intent === "change" ? changePeriod : period}
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
        title={`Move to ${confirmChange?.plan.name ?? ""}`}
        description={
          <p>
            Your subscription changes to {confirmChange?.plan.name} at{" "}
            <span className="tabular font-medium text-foreground">
              {confirmChange ? formatPrice(confirmChange.price) : ""}
            </span>
            , and its allowance applies from the change. The billing provider settles the
            difference, charging an upgrade right away and putting a downgrade on your next invoice.
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
            Your plan stays until the end of the current period, then the account moves to the free
            plan and its allowance.
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
  allowance,
  actions,
  pending,
  cancelPending,
  resumePending,
  onCancel,
  onResume,
}: {
  access: BillingAccess | undefined;
  allowance: PlanAllowance | null | undefined;
  /** What the gateway says a person may do about the subscription. */
  actions: SubscriptionActions | undefined;
  pending: boolean;
  cancelPending: boolean;
  resumePending: boolean;
  onCancel: () => void;
  onResume: () => void;
}) {
  const plan = entitledPlan(access);
  const subscription = subscriptionOf(access);
  const timeline = subscription ? subscriptionTimeline(subscription) : null;
  const meter = quotaMeter(allowance);

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
          account dropped onto the free default plan may still have a
          cancelled subscription to resume, and one holding a paid plan through
          a manual grant has nothing to cancel.
        */}
        {!pending && subscription ? (
          <div className="flex flex-wrap gap-2">
            {actions?.resume ? (
              <GuardedButton
                variant="outline"
                size="sm"
                disabled={resumePending}
                onClick={onResume}
              >
                {resumePending ? <Loader2 className="size-4 animate-spin" /> : null}
                Resume subscription
              </GuardedButton>
            ) : actions?.cancel ? (
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
 * in the gateway's limiter object, not in the usage tables, so without this an
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
              {...(action.reason
                ? { reason: action.reason }
                : !free && !price
                  ? { reason: `This plan has no ${period === "year" ? "yearly" : "monthly"} price.` }
                  : {})}
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
