import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { call } from "./api";
import { checkoutSucceeded, pathWithoutCheckout, planKeyFrom } from "./auth-redirect";
import { useConsoleSession } from "./console-session";
import { keys } from "./queries";

/**
 * How often, and how many times, the plan is read after the return. The
 * provider sends the browser back the moment payment clears, but the
 * subscription reaches the billing service on a webhook, and the two race. A
 * short, capped run of reads covers the usual delay; past it the person is
 * told to look again later rather than being polled for.
 */
export const PLAN_CONFIRM_INTERVAL_MS = 3_000;
export const PLAN_CONFIRM_CHECKS = 5;

/** One toast for the whole return, updated in place. */
const TOAST_ID = "checkout-return";

/**
 * Handles the page the provider sends the person back to after a checkout.
 * The marker in the address says only that the provider sent them back, not
 * that anything was bought: so on a hosted console it says the payment is
 * being confirmed, reads the plan from the billing service a few times, and
 * says "Payment complete" only once the account is on the plan bought. A
 * console without billing never announces anything. Either way the marker is
 * stripped at once, so a reload or a shared link never acts on it again.
 */
export function useCheckoutSuccessToast(): void {
  const location = useLocation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const { capabilities } = useConsoleSession();
  // Set before the work: under StrictMode the effect runs twice on one instance.
  const handled = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const unmounted = useRef(false);
  const succeeded = checkoutSucceeded(location.search);

  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      clearTimeout(timer.current);
    };
  }, []);

  useEffect(() => {
    if (!succeeded || handled.current) return;
    handled.current = true;
    const planKey = planKeyFrom(location.search);
    void navigate(pathWithoutCheckout(location.pathname, location.search), { replace: true });
    if (!capabilities.billing) return;

    const received = () =>
      toast.info("Payment received", {
        id: TOAST_ID,
        description: "Your new plan is still being confirmed. Reload the billing page in a minute to see it.",
      });
    if (planKey === null) {
      received();
      return;
    }
    toast.loading("Confirming your payment…", { id: TOAST_ID });

    const check = async (left: number): Promise<void> => {
      try {
        const status = await client.fetchQuery({ queryKey: keys.billingStatus, queryFn: () => call("getBillingStatus"), staleTime: 0 });
        if (unmounted.current) return;
        const access = status.access;
        if (access.state === "billed" && access.plan?.planKey === planKey) {
          toast.success("Payment complete", { id: TOAST_ID, description: `You're on the ${access.plan.planName} plan.` });
          void client.invalidateQueries({ queryKey: keys.session });
          return;
        }
      } catch {
        // A read that fails counts as one not yet confirmed.
        if (unmounted.current) return;
      }
      if (left <= 1) {
        received();
        return;
      }
      timer.current = setTimeout(() => void check(left - 1), PLAN_CONFIRM_INTERVAL_MS);
    };
    void check(PLAN_CONFIRM_CHECKS);
  }, [succeeded, capabilities.billing, client, navigate, location.pathname, location.search]);
}
