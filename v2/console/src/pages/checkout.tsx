import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { AlertCircle, Loader2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { entitledPlan, priceFor } from "@/lib/billing";
import { DEFAULT_LANDING, planKeyFrom, FREE_PLAN_KEY } from "@/lib/auth-redirect";
import { useConsoleSession } from "@/lib/console-session";
import { isAccountChanged, useBillingPlans, useBillingStatus, useStartCheckout } from "@/lib/queries";

const BILLING_PATH = "/billing";

/**
 * The landing point for a plan chosen before the account existed.
 *
 * Someone presses a price on the marketing site, signs up, and arrives here
 * with `?plan=growth` still attached. This turns that into the checkout they
 * were already trying to start, so the intent survives account creation instead
 * of being spent on a sign-up form and then forgotten on the apps page.
 *
 * It is a waypoint, not a screen: everything it can conclude ends in a
 * redirect or a provider navigation, and the only thing it ever renders for
 * long is the moment between asking for a checkout URL and following it.
 *
 * Every refusal lands somewhere that answers the question instead of somewhere
 * that ignores it: without billing at all there is nothing to say, so the
 * operator goes to the console proper, and so does anyone who asked for the
 * free plan they already have. Everything else — an unknown key, a plan already
 * held, a member who may not buy — goes to the billing page, which states the
 * current plan and the catalog beside it.
 */
export function CheckoutPage() {
  const location = useLocation();
  const { capabilities, canManage, account } = useConsoleSession();
  const plans = useBillingPlans(capabilities.billing);
  const status = useBillingStatus(capabilities.billing, account.id);
  const billing = status.data?.access;
  const { mutateAsync: startCheckout } = useStartCheckout();
  // The account a checkout was started for. Set before the request rather
  // than after it: under StrictMode the effect runs twice against the same
  // instance, and a flag the response sets would let the second pass open a
  // second checkout for the same plan. It and the error belong to one
  // account: a switch to another (in this tab or another) starts afresh
  // (Sol 7b-8).
  const started = useRef<string | null>(null);
  const [failure, setFailure] = useState<{ accountId: string; message: string } | null>(null);
  const error = failure?.accountId === account.id ? failure.message : null;

  const planKey = planKeyFrom(location.search);
  const catalog = plans.data?.plans ?? [];
  const plan = planKey === null ? undefined : catalog.find((entry) => entry.planKey === planKey);
  const current = entitledPlan(billing);

  /*
   * Every refusal that does not need the catalog, settled before it answers: a
   * deployment without billing has no catalog to wait for, and a missing or
   * free key is decided by the URL alone. `null` means there is nothing to
   * refuse and the checkout may go ahead.
   */
  const landing = ((): string | null => {
    if (!capabilities.billing) return DEFAULT_LANDING;
    // Already every account's plan, and not something to buy.
    if (planKey === FREE_PLAN_KEY) return DEFAULT_LANDING;
    if (planKey === null) return BILLING_PATH;
    // A member cannot buy, but they can read what the account is on.
    if (!canManage) return BILLING_PATH;
    if (current?.planKey === planKey) return BILLING_PATH;
    return null;
  })();

  // The catalog is the only thing that can say a key names a real, purchasable
  // plan, so an unknown one is not concluded until it has answered.
  const unknownPlan = landing === null && plans.isSuccess && !plan;
  // The current plan is read first, and must have been read for this account:
  // buying the plan already held is sent to the plans instead, and a read the
  // gateway refused (another tab switched accounts) starts nothing until the
  // switch is followed (Sol 7b-8).
  const ready = landing === null && plan !== undefined && error === null && status.isSuccess;
  // The current plan could not be read for a reason other than an account switch.
  const statusFailed = landing === null && status.isError && !isAccountChanged(status.error);

  useEffect(() => {
    if (!ready || started.current === account.id || plan === undefined) return;
    const accountId = account.id;
    started.current = accountId;
    // The catalog is monthly-only today, but the period a plan is actually
    // sold on is the plan's to state, not this page's to assume.
    const billingPeriod = priceFor(plan, "month") ? "month" : "year";
    startCheckout({ planKey: plan.planKey, billingPeriod, accountId })
      .then(({ url }) => window.location.assign(url))
      .catch((cause: unknown) => {
        setFailure({ accountId, message: cause instanceof Error ? cause.message : "Could not start checkout" });
      });
  }, [ready, plan, startCheckout, account.id]);

  if (landing !== null) return <Navigate to={landing} replace />;
  if (unknownPlan) return <Navigate to={BILLING_PATH} replace />;

  // The catalog could not be read: say so, with a way to try again and a way
  // out, rather than wait on it for good (Sol 7b-8).
  if (landing === null && plans.isError && error === null) {
    return (
      <div className="mx-auto max-w-lg py-10">
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Could not load the plans</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span>{plans.error instanceof Error ? plans.error.message : "The plans could not be read."}</span>
            <Button size="sm" variant="outline" disabled={plans.isFetching} onClick={() => void plans.refetch()}>
              Try again
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link to={BILLING_PATH}>Go to plans</Link>
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (error !== null || statusFailed) {
    return (
      <div className="mx-auto max-w-lg py-10">
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Could not start checkout</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span>{error ?? (status.error instanceof Error ? status.error.message : "Your current plan could not be read.")}</span>
            <Button asChild size="sm" variant="outline">
              <Link to={BILLING_PATH}>Go to plans</Link>
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="flex min-h-60 flex-col items-center justify-center gap-3 py-10 text-center">
      <Loader2 className="size-5 animate-spin text-muted-foreground" />
      <p className="text-sm text-muted-foreground">
        {plan
          ? `Redirecting you to checkout for ${plan.name}…`
          : "Preparing your checkout…"}
      </p>
    </div>
  );
}
