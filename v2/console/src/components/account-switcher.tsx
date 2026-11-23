import { Check } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useConsoleSession } from "@/lib/console-session";
import { ROLE_LABELS, shouldShowAccountSwitcher } from "@/lib/permissions";
import { useIsMutating } from "@tanstack/react-query";
import { PAYMENT_ACTION_KEY, useSelectAccount } from "@/lib/queries";

/**
 * Switches the account the console acts in, as a section of the account menu.
 *
 * Renders nothing unless the operator actually belongs to more than one; a
 * single account makes the control pure noise, and the sidebar names only
 * the operator. Available to every role: a read-only member still needs to
 * move between their accounts.
 */
export function AccountMenuItems() {
  const { account, accounts } = useConsoleSession();
  const select = useSelectAccount();
  // A checkout, change or resume that may still send the page to a payment
  // page belongs to this account: no switch until it has finished.
  const paying = useIsMutating({ mutationKey: PAYMENT_ACTION_KEY }) > 0;

  if (!shouldShowAccountSwitcher(accounts.length)) return null;

  const switchTo = async (accountId: string) => {
    if (accountId === account.id) return;
    try {
      await select.mutateAsync(accountId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not switch account");
    }
  };

  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
        Accounts
      </DropdownMenuLabel>
      {accounts.map((membership) => {
        const active = membership.id === account.id;
        return (
          <DropdownMenuItem
            key={membership.id}
            disabled={select.isPending || paying}
            onSelect={() => void switchTo(membership.id)}
          >
            <Check className={active ? "size-4" : "size-4 opacity-0"} />
            <span className="flex-1 truncate">{membership.name}</span>
            <span className="text-xs text-muted-foreground">
              {ROLE_LABELS[membership.role]}
            </span>
          </DropdownMenuItem>
        );
      })}
    </>
  );
}
