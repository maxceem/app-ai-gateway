import { useState, type ReactNode } from "react";
import { Check, Copy, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * The last step of a creation flow that mints a credential.
 *
 * The plaintext exists only in the response that opened this dialog, so it
 * closes on the acknowledgement alone: Escape and outside clicks are ignored,
 * and a copy failure stays recoverable because the value is still on screen.
 */
export function SecretRevealDialog({
  open,
  title,
  description,
  label,
  secret,
  acknowledgeLabel = "I’ve saved this key",
  footnote,
  onAcknowledge,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  label: string;
  secret: string;
  acknowledgeLabel?: string;
  footnote?: ReactNode;
  onAcknowledge: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Could not copy. Select the value and copy it manually.");
    }
  };

  const acknowledge = () => {
    setCopied(false);
    onAcknowledge();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) acknowledge();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-lg"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <div className="mb-1 flex size-11 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
            <KeyRound className="size-5" />
          </div>
          <DialogTitle className="text-balance">{title}</DialogTitle>
        </DialogHeader>

        <DialogBody className="space-y-4">
          <DialogDescription className="text-pretty">{description}</DialogDescription>
          <div className="space-y-2">
            <Label htmlFor="revealed-secret">{label}</Label>
            <div className="flex gap-2">
              <Input
                id="revealed-secret"
                value={secret}
                readOnly
                className="font-mono text-xs"
                onFocus={(event) => event.currentTarget.select()}
              />
              <Button
                type="button"
                variant="outline"
                className="min-w-24 active:scale-[0.96]"
                onClick={() => void copy()}
              >
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            {footnote ? <p className="text-xs text-muted-foreground">{footnote}</p> : null}
          </div>
        </DialogBody>

        <DialogFooter>
          <Button className="active:scale-[0.96]" onClick={acknowledge}>
            {acknowledgeLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
