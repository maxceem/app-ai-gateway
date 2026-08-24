import type { ComponentProps, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useConsoleSession } from "@/lib/console-session";
import { READ_ONLY_REASON } from "@/lib/permissions";

/**
 * Explains why an action is unavailable instead of hiding it.
 *
 * A disabled button sets `pointer-events: none`, which would swallow the hover
 * that opens the tooltip, so the trigger is a focusable wrapper around it.
 */
export function DisabledReason({
  reason,
  children,
}: {
  reason: ReactNode;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex w-fit cursor-not-allowed">
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}

/**
 * A {@link Button} for actions that mutate gateway state.
 *
 * Read-only members keep seeing the control — hiding it would make the console
 * look broken rather than restricted — but it is disabled and explains itself.
 * `reason` overrides the default copy for finer-grained rules such as
 * last-owner protection.
 */
export function GuardedButton({
  reason,
  disabled,
  ...props
}: ComponentProps<typeof Button> & { reason?: string }) {
  const { readOnly } = useConsoleSession();
  const blockedReason = reason ?? (readOnly ? READ_ONLY_REASON : undefined);

  if (!blockedReason) return <Button disabled={disabled} {...props} />;

  return (
    <DisabledReason reason={blockedReason}>
      <Button {...props} disabled />
    </DisabledReason>
  );
}
