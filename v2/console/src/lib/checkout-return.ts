import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError, call } from "./api";
import type { OperationResponse } from "@contracts/catalog";
import { checkoutAccountFrom, checkoutSucceeded, pathWithoutCheckout, planKeyFrom } from "./auth-redirect";
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
/** How long one check may take; a stalled read counts as one not yet confirmed. */
export const PLAN_CONFIRM_READ_MS = 2_500;

type PlanRead =
  | { readonly kind: "plan"; readonly status: OperationResponse<"getBillingStatus"> }
  /** The console's account is no longer the one the checkout was for. */
  | { readonly kind: "account_changed" }
  /** Failed or too slow: counts as not yet confirmed. */
  | { readonly kind: "none" };

/**
 * One read of the plan for the confirmation (Sol 7b-8). Each is its own
 * request, outside the billing page's cached status, so no other read's answer
 * is ever taken for it. It names the account the checkout was for, and the
 * gateway refuses with `account_changed` if another account is selected. It
 * is never retried, and is stopped at its deadline or when the page goes.
 */
async function readPlanOnce(accountId: string, stop: AbortSignal): Promise<PlanRead> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  stop.addEventListener("abort", abort);
  const timer = setTimeout(abort, PLAN_CONFIRM_READ_MS);
  try {
    const status = await call("getBillingStatus", { query: { account: accountId }, signal: controller.signal });
    return { kind: "plan", status };
  } catch (error) {
    if (error instanceof ApiError && error.status === 409 && error.code === "account_changed") return { kind: "account_changed" };
    return { kind: "none" };
  } finally {
    clearTimeout(timer);
    stop.removeEventListener("abort", abort);
  }
}

/** One toast for the whole return, updated in place. */
const TOAST_ID = "checkout-return";

/**
 * Handles the page the provider sends the person back to after a checkout.
 * The marker in the address says only that the provider sent them back, not
 * that anything was bought: so on a hosted console it says the payment is
 * being confirmed, reads the plan from the billing service a few times, and
 * says "Payment complete" only once a fresh read for the same account shows
 * the plan bought. A console without billing, or one showing another account
 * than the checkout was for, announces nothing. Either way the marker is
 * stripped at once, so a reload or a shared link never acts on it again.
 */
export function useCheckoutSuccessToast(): void {
  const location = useLocation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const { capabilities, account } = useConsoleSession();
  // Set before the work: under StrictMode the effect runs twice on one instance.
  const handled = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const reads = useRef<AbortController>(undefined);
  const succeeded = checkoutSucceeded(location.search);

  useEffect(() => {
    const controller = new AbortController();
    reads.current = controller;
    return () => {
      controller.abort();
      clearTimeout(timer.current);
    };
  }, []);

  useEffect(() => {
    if (!succeeded || handled.current) return;
    handled.current = true;
    const planKey = planKeyFrom(location.search);
    // A return is only this account's to confirm when it names this account.
    // One read in another account's console, or naming no account, says
    // nothing: it could announce a plan the account already held (Sol 7b-8).
    const checkoutAccount = checkoutAccountFrom(location.search);
    void navigate(pathWithoutCheckout(location.pathname, location.search), { replace: true });
    if (!capabilities.billing || checkoutAccount === null || checkoutAccount !== account.id) return;

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
      // The page's reads stop when it goes. Under StrictMode the component is
      // mounted twice: a read stopped by the first unmount is asked again
      // under the second mount, and one stopped by a real unmount ends here.
      const stop = reads.current;
      if (stop === undefined || stop.signal.aborted) return;
      const read = await readPlanOnce(checkoutAccount, stop.signal);
      if (stop.signal.aborted) {
        void check(left);
        return;
      }
      if (read.kind === "account_changed") {
        toast.dismiss(TOAST_ID);
        return;
      }
      if (read.kind === "plan") {
        const access = read.status.access;
        if (access.state === "billed" && access.plan?.planKey === planKey) {
          toast.success("Payment complete", { id: TOAST_ID, description: `You're on the ${access.plan.planName} plan.` });
          void client.invalidateQueries({ queryKey: keys.session });
          void client.invalidateQueries({ queryKey: keys.billingStatus });
          return;
        }
      }
      if (left <= 1) {
        received();
        return;
      }
      timer.current = setTimeout(() => void check(left - 1), PLAN_CONFIRM_INTERVAL_MS);
    };
    void check(PLAN_CONFIRM_CHECKS);
  }, [succeeded, capabilities.billing, account.id, client, navigate, location.pathname, location.search]);
}
