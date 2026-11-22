import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { checkoutSucceeded, pathWithoutCheckout } from "./auth-redirect";
import { keys } from "./queries";

/**
 * How long after the return the plan is read a second time. The provider sends
 * the browser back the moment payment clears, but the subscription reaches the
 * billing service on a webhook, and the two race.
 */
const PLAN_SETTLE_MS = 4_000;

/**
 * Announces a purchase on the page the provider sends the person back to, then
 * strips the marker, so a reload or a shared link never announces it again.
 * Nothing here decides whether the purchase succeeded: the billing service's
 * webhook moves the account onto the plan. This only says so and reads it again.
 */
export function useCheckoutSuccessToast(): void {
  const location = useLocation();
  const navigate = useNavigate();
  const client = useQueryClient();
  // Set before the work: under StrictMode the effect runs twice on one instance.
  const announced = useRef(false);
  const settle = useRef<ReturnType<typeof setTimeout>>(undefined);
  const succeeded = checkoutSucceeded(location.search);

  useEffect(() => () => clearTimeout(settle.current), []);

  useEffect(() => {
    if (!succeeded || announced.current) return;
    announced.current = true;
    toast.success("Payment complete", { description: "Your new plan is being activated." });
    const refresh = () => {
      void client.invalidateQueries({ queryKey: keys.billingStatus });
      void client.invalidateQueries({ queryKey: keys.session });
    };
    refresh();
    settle.current = setTimeout(refresh, PLAN_SETTLE_MS);
    void navigate(pathWithoutCheckout(location.pathname, location.search), { replace: true });
  }, [succeeded, client, navigate, location.pathname, location.search]);
}
