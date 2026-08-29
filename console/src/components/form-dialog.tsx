import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { GuardedButton } from "@/components/guarded-button";
import { useConsoleSession } from "@/lib/console-session";

/**
 * The shell every "create a thing" modal in the console shares: a titled
 * dialog whose body is a form, so Enter submits, and whose primary action is
 * guarded for read-only members and shows its own pending state.
 *
 * Creation stays in the modal from the first field to the last confirmation —
 * pages keep a single "New …" button rather than an inline form.
 */
export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  submitLabel,
  pending,
  disabled,
  onSubmit,
  className,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  submitLabel: string;
  pending?: boolean;
  disabled?: boolean;
  onSubmit: () => void;
  className?: string;
  children: ReactNode;
}) {
  // Enter submits the form, which would bypass the guarded button that is the
  // only visible control a read-only member sees disabled.
  const { readOnly } = useConsoleSession();
  const blocked = readOnly || disabled || pending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={className ?? "sm:max-w-md"}>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (blocked) return;
            onSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle className="text-balance">{title}</DialogTitle>
            {description ? (
              <DialogDescription className="text-pretty">{description}</DialogDescription>
            ) : null}
          </DialogHeader>

          {children}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <GuardedButton type="submit" disabled={disabled || pending}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              {submitLabel}
            </GuardedButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
