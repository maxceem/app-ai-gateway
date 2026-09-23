import { useState } from "react";
import { Loader2 } from "lucide-react";
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
import { Field } from "@/components/field";
import { useUpdateProvider } from "@/lib/queries";
import type { ProviderCredential } from "@/lib/types";
import { PLAIN_FIELD, SECRET_FIELD, errorMessage } from "./shared";

/**
 * The one place a direct instance's credential — and therefore its origin — is
 * changed.
 *
 * The base URL lives here rather than in a form of its own because the API only
 * accepts a new origin together with a new key: the stored key is write-only and
 * is never sent to a host it has not been sent to before. So an operator who
 * wants to move a row is going to be asked for the key either way, and asking
 * once, in the dialog that is already about the key, is the honest shape.
 */
export function RotateDialog({
  provider,
  onClose,
}: {
  provider: ProviderCredential | null;
  onClose: () => void;
}) {
  const updateProvider = useUpdateProvider();
  const [secret, setSecret] = useState("");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");

  const close = () => {
    setSecret("");
    updateProvider.reset();
    onClose();
  };

  // Sent only when it actually changed: an untouched field must not turn a key
  // rotation into a move, and an emptied one clears the override with `null`.
  const trimmed = baseUrl.trim();
  const movedTo = provider && trimmed !== (provider.baseUrl ?? "")
    ? { baseUrl: trimmed === "" ? null : trimmed }
    : {};

  const submit = async () => {
    if (!provider || !secret) return;
    try {
      await updateProvider.mutateAsync({ id: provider.id, body: { secret, ...movedTo, revision: provider.revision } });
      setSecret("");
      updateProvider.reset();
      toast.success(`Updated the key for ${provider.name}`);
      onClose();
    } catch (error) {
      setSecret("");
      toast.error(errorMessage(error, "Could not update the credential"));
    }
  };

  return (
    <Dialog open={provider !== null} onOpenChange={(open) => (open ? undefined : close())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Update the key for {provider?.name}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <DialogDescription>
            The new credential replaces the old one in place. Custom pricing is kept, and requests
            pick it up within a minute.
          </DialogDescription>
          <Field label="New API key" htmlFor="rotate-secret">
            <Input
              id="rotate-secret"
              {...SECRET_FIELD}
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
            />
          </Field>
          <Field
            label="Base URL"
            htmlFor="rotate-base-url"
            hint="Changing the origin needs the key above, because the stored key is never sent to a new origin. Leave empty to use the provider's own API."
          >
            <Input
              id="rotate-base-url"
              {...PLAIN_FIELD}
              className="font-mono"
              value={baseUrl}
              placeholder="https://my-vllm.example.com/v1/"
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button disabled={!secret || updateProvider.isPending} onClick={() => void submit()}>
            {updateProvider.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Update key
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
