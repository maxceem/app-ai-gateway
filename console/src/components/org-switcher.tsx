import { Check } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useConsoleSession } from "@/lib/console-session";
import { ROLE_LABELS, shouldShowOrganizationSwitcher } from "@/lib/permissions";
import { useSelectOrganization } from "@/lib/queries";

/**
 * Switches the acting organization, as a section of the account menu.
 *
 * Renders nothing unless the operator actually belongs to more than one; a
 * single membership makes the control pure noise, and the sidebar names only
 * the operator. Available to every role — a read-only member still needs to
 * move between their organizations.
 */
export function OrganizationMenuItems() {
  const { organization, memberships } = useConsoleSession();
  const select = useSelectOrganization();

  if (!shouldShowOrganizationSwitcher(memberships.length)) return null;

  const switchTo = async (organizationId: string) => {
    if (organizationId === organization?.id) return;
    try {
      await select.mutateAsync(organizationId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not switch organization");
    }
  };

  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
        Organizations
      </DropdownMenuLabel>
      {memberships.map((membership) => {
        const active = membership.organization.id === organization?.id;
        return (
          <DropdownMenuItem
            key={membership.organization.id}
            disabled={select.isPending}
            onSelect={() => void switchTo(membership.organization.id)}
          >
            <Check className={active ? "size-4" : "size-4 opacity-0"} />
            <span className="flex-1 truncate">{membership.organization.name}</span>
            <span className="text-xs text-muted-foreground">
              {ROLE_LABELS[membership.role]}
            </span>
          </DropdownMenuItem>
        );
      })}
    </>
  );
}
