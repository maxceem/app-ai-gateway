import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { call, isUnauthorized } from "./api";
import type { OperationResponse } from "@contracts/catalog";
import { checkoutAccountFrom, checkoutSucceeded, pathWithoutCheckout, planKeyFrom } from "./auth-redirect";
import { useConsoleSession } from "./console-session";
import { keys } from "./queries";
import { tabAccount } from "./tab-account";

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
  /** The session has ended: there is nothing more to confirm on this page. */
  | { readonly kind: "signed_out" }
  /** Failed or too slow: counts as not yet confirmed. */
  | { readonly kind: "none" };

/**
 * One read of the plan for the confirmation (Sol 7b-8). Each is its own
 * request, outside the billing page's cached status, so no other read's answer
 * is ever taken for it. It reads this tab's account, which is the one the
 * checkout was for. It is never retried, and is stopped at its deadline or
 * when the page goes.
 */
async function readPlanOnce(stop: AbortSignal): Promise<PlanRead> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  stop.addEventListener("abort", abort);
  const timer = setTimeout(abort, PLAN_CONFIRM_READ_MS);
  try {
    const status = await call("getBillingStatus", { signal: controller.signal });
    return { kind: "plan", status };
  } catch (error) {
    if (isUnauthorized(error)) return { kind: "signed_out" };
    return { kind: "none" };
  } finally {
    clearTimeout(timer);
    stop.removeEventListener("abort", abort);
  }
}

/** One toast for the whole return, updated in place. */
const TOAST_ID = "checkout-return";

/** The confirmation running on this page, if any: one per page, however often React mounts the shell. */
let running: { readonly stop: () => void } | null = null;

/**
 * Confirms a payment: says it is being confirmed, reads the plan up to
 * `PLAN_CONFIRM_CHECKS` times, and says "Payment complete" once a read shows
 * the plan bought, or "Payment received" past the last read. Before each read
 * and each notice it checks the tab still acts in the account the checkout was
 * for; if not, it stops and takes its notice down.
 */
function confirmPayment(client: QueryClient, checkoutAccount: string, planKey: string | null): void {
  if (running !== null) return;
  const reads = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = () => {
    clearTimeout(timer);
    reads.abort();
    running = null;
  };
  const stop = () => {
    finish();
    toast.dismiss(TOAST_ID);
  };
  running = { stop };
  const forThisAccount = () => tabAccount() === checkoutAccount;
  const received = () => {
    finish();
    toast.info("Payment received", {
      id: TOAST_ID,
      description: "Your new plan is still being confirmed. Reload the billing page in a minute to see it.",
    });
  };
  if (!forThisAccount()) return finish();
  if (planKey === null) return received();
  toast.loading("Confirming your payment…", { id: TOAST_ID });

  const check = async (left: number): Promise<void> => {
    if (!forThisAccount()) return stop();
    const read = await readPlanOnce(reads.signal);
    if (reads.signal.aborted) return;
    if (read.kind === "signed_out" || !forThisAccount()) return stop();
    const access = read.kind === "plan" ? read.status.access : null;
    const bought = access?.state === "billed" && access.plan?.planKey === planKey ? access.plan : null;
    if (bought !== null) {
      finish();
      toast.success("Payment complete", { id: TOAST_ID, description: `You're on the ${bought.planName} plan.` });
      void client.invalidateQueries({ queryKey: keys.billingStatusPrefix });
      return;
    }
    if (left <= 1) return received();
    timer = setTimeout(() => void check(left - 1), PLAN_CONFIRM_INTERVAL_MS);
  };
  void check(PLAN_CONFIRM_CHECKS);
}

/** Ends a payment confirmation in progress and takes its notice down (signing out). */
export function stopPaymentConfirmation(): void {
  running?.stop();
}

/**
 * Handles the page the provider sends the person back to after a checkout.
 * The marker in the address says only that the provider sent them back, not
 * that anything was bought: so on a hosted console it confirms the payment
 * (`confirmPayment`). A console without billing, or a tab acting in another
 * account than the checkout was for, announces nothing. Either way the marker
 * is stripped at once, so a reload or a shared link never acts on it again.
 */
export function useCheckoutSuccessToast(): void {
  const location = useLocation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const { capabilities, account } = useConsoleSession();
  const succeeded = checkoutSucceeded(location.search);

  useEffect(() => {
    if (!succeeded) return;
    const planKey = planKeyFrom(location.search);
    // A return is only this account's to confirm when it names this account.
    // One read in another account's console, or naming no account, says
    // nothing: it could announce a plan the account already held (Sol 7b-8).
    const checkoutAccount = checkoutAccountFrom(location.search);
    void navigate(pathWithoutCheckout(location.pathname, location.search), { replace: true });
    if (!capabilities.billing || checkoutAccount === null || checkoutAccount !== account.id) return;
    confirmPayment(client, checkoutAccount, planKey);
  }, [succeeded, capabilities.billing, account.id, client, navigate, location.pathname, location.search]);
}
