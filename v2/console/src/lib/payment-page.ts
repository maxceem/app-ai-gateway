import { toast } from "sonner";
import { tabAccount } from "./tab-account";

/**
 * Opens a payment page the gateway answered for an action started in
 * `startedFor`, only while this tab still names that account. If the tab has
 * switched account since, the page belongs to the account left: it is not
 * opened, and the person is told why.
 */
export function openPaymentPage(url: string, startedFor: string | null): boolean {
  if (tabAccount() !== startedFor) {
    toast.info("You switched account, so the payment page was not opened.");
    return false;
  }
  window.location.assign(url);
  return true;
}
