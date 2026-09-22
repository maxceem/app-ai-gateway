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
import { gatewayOutcome, type TestOutcome } from "@/lib/provider-probe";
import { useRotateProviderGateway, useTestProviderGateway } from "@/lib/queries";
import type { ProviderGateway } from "@/lib/types";
import { SECRET_FIELD, TestResult, errorMessage } from "./shared";

export function RotateGatewayDialog({
  gateway,
  onClose,
}: {
  gateway: ProviderGateway | null;
  onClose: () => void;
}) {
  const rotateGateway = useRotateProviderGateway();
  const testGateway = useTestProviderGateway();
  const [token, setToken] = useState("");
  const [tested, setTested] = useState<TestOutcome | null>(null);

  const close = () => {
    setToken("");
    setTested(null);
    rotateGateway.reset();
    testGateway.reset();
    onClose();
  };

  /** The same dry run the add form offers, against the token about to replace. */
  const test = async () => {
    if (!gateway || !token) return;
    setTested(null);
    try {
      const result = await testGateway.mutateAsync(
        gateway.type === "cf_aig"
          ? {
              type: "cf_aig",
              accountId: gateway.config.accountId,
              gatewayId: gateway.config.gatewayId,
              token,
            }
          : { type: "vercel", token },
      );
      setTested(gatewayOutcome(result));
    } catch (error) {
      setTested({
        status: "failed",
        message: errorMessage(error, "The connection could not be checked"),
      });
    } finally {
      testGateway.reset();
    }
  };

  const submit = async () => {
    if (!gateway || !token) return;
    try {
      await rotateGateway.mutateAsync({ id: gateway.id, token, revision: gateway.revision });
      setToken("");
      setTested(null);
      rotateGateway.reset();
      toast.success(`Updated the token for ${gateway.name}`);
      onClose();
    } catch (error) {
      setToken("");
      toast.error(errorMessage(error, "Could not update the gateway token"));
    }
  };

  return (
    <Dialog open={gateway !== null} onOpenChange={(open) => (open ? undefined : close())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Update the token for {gateway?.name}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <DialogDescription>
            One token authenticates every provider routed through this gateway, so all{" "}
            {gateway?.providerCount ?? 0} of them pick the new one up within a minute.
          </DialogDescription>
          <Field label="New gateway token" htmlFor="gateway-rotate-token">
            <Input
              id="gateway-rotate-token"
              {...SECRET_FIELD}
              value={token}
              onChange={(event) => {
                setToken(event.target.value);
                setTested(null);
              }}
            />
          </Field>
          {tested ? <TestResult outcome={tested} /> : null}
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            className="sm:mr-auto"
            disabled={!token || testGateway.isPending}
            onClick={() => void test()}
          >
            {testGateway.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Test token
          </Button>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button disabled={!token || rotateGateway.isPending} onClick={() => void submit()}>
            {rotateGateway.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Update token
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
