import { useId, type ComponentProps, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useConsoleSession } from "@/lib/console-session";
import { READ_ONLY_REASON } from "@/lib/permissions";

/**
 * Explains why an action is unavailable instead of hiding it.
 *
 * A disabled control sets `pointer-events: none`, which would swallow the hover
 * that opens the tooltip, so the trigger is a focusable wrapper around it. The
 * wrapper deliberately has no role: giving it one would nest an interactive
 * element inside another and replace the action's own name with the reason.
 *
 * Pass `reasonId` to render the reason as a description the wrapped control can
 * point at with `aria-describedby`, so assistive tech announces the action and
 * then why it is unavailable.
 */
export function DisabledReason({
  reason,
  reasonId,
  children,
}: {
  reason: ReactNode;
  reasonId?: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex w-fit cursor-not-allowed">
          {children}
          {reasonId ? (
            <span id={reasonId} className="sr-only">
              {reason}
            </span>
          ) : null}
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
  const reasonId = useId();
  const blockedReason = reason ?? (readOnly ? READ_ONLY_REASON : undefined);

  if (!blockedReason) return <Button disabled={disabled} {...props} />;

  return (
    <DisabledReason reason={blockedReason} reasonId={reasonId}>
      <Button {...props} disabled aria-disabled="true" aria-describedby={reasonId} />
    </DisabledReason>
  );
}
