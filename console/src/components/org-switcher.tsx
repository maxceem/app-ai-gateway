import { Building2, Check, ChevronsUpDown, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useConsoleSession } from "@/lib/console-session";
import { ROLE_LABELS, shouldShowOrganizationSwitcher } from "@/lib/permissions";
import { useSelectOrganization } from "@/lib/queries";

/**
 * Switches the acting organization.
 *
 * Only rendered when the operator actually belongs to more than one; a single
 * membership makes the control pure noise, so the shell shows a plain label
 * instead. Available to every role — a read-only member still needs to move
 * between their organizations.
 */
export function OrganizationSwitcher() {
  const { organization, memberships } = useConsoleSession();
  const select = useSelectOrganization();

  if (!shouldShowOrganizationSwitcher(memberships.length)) {
    return organization ? (
      <span className="hidden items-center gap-1.5 text-sm text-muted-foreground sm:flex">
        <Building2 className="size-3.5" />
        {organization.name}
      </span>
    ) : null;
  }

  const switchTo = async (organizationId: string) => {
    if (organizationId === organization?.id) return;
    try {
      await select.mutateAsync(organizationId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not switch organization");
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1.5" disabled={select.isPending}>
          {select.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Building2 className="size-3.5" />
          )}
          <span className="max-w-40 truncate">{organization?.name ?? "Select organization"}</span>
          <ChevronsUpDown className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuLabel>Organizations</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {memberships.map((membership) => {
          const active = membership.organization.id === organization?.id;
          return (
            <DropdownMenuItem
              key={membership.organization.id}
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
