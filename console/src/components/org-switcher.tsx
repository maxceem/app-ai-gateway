import { Building2, Check, ChevronsUpDown, Loader2 } from "lucide-react";
import { toast } from "sonner";
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
import { cn } from "@/lib/utils";

/** Shared geometry so the static label and the switcher occupy the same row. */
const ROW = "flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-xs";

/**
 * Switches the acting organization.
 *
 * Only rendered when the operator actually belongs to more than one; a single
 * membership makes the control pure noise, so the sidebar shows a plain label
 * instead. Available to every role — a read-only member still needs to move
 * between their organizations.
 */
export function OrganizationSwitcher() {
  const { organization, memberships } = useConsoleSession();
  const select = useSelectOrganization();

  if (!shouldShowOrganizationSwitcher(memberships.length)) {
    return organization ? (
      <div className={cn(ROW, "text-muted-foreground")}>
        <Building2 className="size-4 shrink-0" />
        <span className="truncate">{organization.name}</span>
      </div>
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
      <DropdownMenuTrigger
        disabled={select.isPending}
        className={cn(
          ROW,
          "text-muted-foreground transition-colors",
          "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          "data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground",
          "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
          "disabled:pointer-events-none disabled:opacity-50",
        )}
      >
        {select.isPending ? (
          <Loader2 className="size-4 shrink-0 animate-spin" />
        ) : (
          <Building2 className="size-4 shrink-0" />
        )}
        <span className="flex-1 truncate text-left">
          {organization?.name ?? "Select organization"}
        </span>
        <ChevronsUpDown className="size-4 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
      >
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
