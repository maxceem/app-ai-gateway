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
import { useRenameProviderGateway } from "@/lib/queries";
import type { ProviderGateway } from "@/lib/types";
import { PLAIN_FIELD, errorMessage } from "./shared";

export function RenameGatewayDialog({
  gateway,
  onClose,
}: {
  gateway: ProviderGateway | null;
  onClose: () => void;
}) {
  const renameGateway = useRenameProviderGateway();
  const [name, setName] = useState("");
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  if (gateway && loadedFor !== gateway.id) {
    setLoadedFor(gateway.id);
    setName(gateway.name);
  }

  const close = () => {
    setLoadedFor(null);
    onClose();
  };

  const submit = async () => {
    if (!gateway || !name.trim()) return;
    try {
      await renameGateway.mutateAsync({ id: gateway.id, name: name.trim(), revision: gateway.revision });
      toast.success(`Renamed to ${name.trim()}`);
      close();
    } catch (error) {
      toast.error(errorMessage(error, "Could not rename the gateway"));
    }
  };

  return (
    <Dialog open={gateway !== null} onOpenChange={(open) => (open ? undefined : close())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rename gateway</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <DialogDescription>
            Only the display name changes. Nothing about the connection or the providers routed
            through it moves.
          </DialogDescription>
          <Field label="Name" htmlFor="gateway-rename">
            <Input
              id="gateway-rename"
              {...PLAIN_FIELD}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button disabled={!name.trim() || renameGateway.isPending} onClick={() => void submit()}>
            {renameGateway.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Save name
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
