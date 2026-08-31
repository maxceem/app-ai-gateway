import { useId, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DisabledReason } from "@/components/guarded-button";
import { useConsoleSession } from "@/lib/console-session";
import { READ_ONLY_REASON } from "@/lib/permissions";

/**
 * The actions of a table row, behind one trigger.
 *
 * Spelling every action out as a button in the row makes the actions column
 * wider than the data the table is actually about, and the widths shift as soon
 * as one row offers an action another does not. A menu keeps the column one
 * icon wide, and gives each action room for a label that says what it acts on.
 *
 * `label` names the row so screen readers, and tests, can tell one row's
 * trigger from the next.
 */
export function RowActions({ label, children }: { label: string; children: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${label}`}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * An action inside a {@link RowActions} menu that mutates gateway state.
 *
 * The read-only rule and its wording are the same as {@link GuardedButton}'s:
 * the action stays visible and explains itself rather than disappearing.
 * `reason` overrides the default copy for a row-specific rule, such as a
 * credential that can only be rotated through its gateway. Actions that merely
 * open a read-only view belong in a plain `DropdownMenuItem`.
 */
export function RowAction({
  reason,
  destructive,
  onSelect,
  children,
}: {
  reason?: string;
  destructive?: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  const { readOnly } = useConsoleSession();
  const reasonId = useId();
  const blockedReason = reason ?? (readOnly ? READ_ONLY_REASON : undefined);
  const variant = destructive ? "destructive" : "default";

  if (!blockedReason) {
    return (
      <DropdownMenuItem variant={variant} onSelect={onSelect}>
        {children}
      </DropdownMenuItem>
    );
  }

  return (
    <DisabledReason reason={blockedReason} reasonId={reasonId} className="w-full">
      <DropdownMenuItem variant={variant} disabled aria-describedby={reasonId} className="w-full">
        {children}
      </DropdownMenuItem>
    </DisabledReason>
  );
}
