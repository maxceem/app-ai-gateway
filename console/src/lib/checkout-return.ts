import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { checkoutSucceeded, pathWithoutCheckout } from "./auth-redirect";
import { keys } from "./queries";

/**
 * How long after the return leg the plan is read a second time.
 *
 * The provider redirects the browser the moment payment clears, but the
 * subscription only reaches this deployment on a webhook, and the two race.
 * The immediate refetch therefore often still reads the previous plan; without
 * a second one the sidebar can name it until the five-minute poll comes round,
 * directly under a toast saying the purchase went through.
 */
const PLAN_SETTLE_MS = 4_000;

/**
 * Announces a purchase on the page the provider sends the operator back to.
 *
 * The redirect carries no body, so the only evidence a checkout completed is
 * the marker on the URL. Spending it — announcing once, then replacing the
 * entry without it — is what keeps a reload or a shared link from reporting a
 * purchase that is not happening now.
 *
 * Nothing here decides whether the purchase succeeded: the provider redirects
 * to the cancel URL when it did not, and the webhook, not this, is what moves
 * the organization onto the plan. This only says so and asks for the reading
 * again.
 */
export function useCheckoutSuccessToast(): void {
  const location = useLocation();
  const navigate = useNavigate();
  const client = useQueryClient();
  // Set before the work rather than after it: under StrictMode the effect runs
  // twice against the same instance, and a flag set on completion would let the
  // second pass raise a second toast.
  const announced = useRef(false);
  const settle = useRef<ReturnType<typeof setTimeout>>(undefined);
  const succeeded = checkoutSucceeded(location.search);

  // Cleared on unmount alone. Tying this to the announcing effect would cancel
  // the settle refetch the moment that effect re-ran on the stripped URL, which
  // is immediately.
  useEffect(() => () => clearTimeout(settle.current), []);

  useEffect(() => {
    if (!succeeded || announced.current) return;
    announced.current = true;

    toast.success("Payment complete", { description: "Your new plan is being activated." });

    const refresh = () => void client.invalidateQueries({ queryKey: keys.billingStatus });
    refresh();
    settle.current = setTimeout(refresh, PLAN_SETTLE_MS);

    void navigate(pathWithoutCheckout(location.pathname, location.search), { replace: true });
  }, [succeeded, client, navigate, location.pathname, location.search]);
}
