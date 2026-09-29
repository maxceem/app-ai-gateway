import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { GatewayName } from "@/components/brand-icon";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import {
  GATEWAY_TYPES,
  gatewayBody,
  gatewayDescriptor,
  type GatewayType,
} from "@shared/gateways";
import { gatewayOutcome, type TestOutcome } from "@/lib/provider-probe";
import { useCreateProviderGateway, useTestProviderGateway } from "@/lib/queries";
import type { ProviderGateway } from "@/lib/types";
import {
  PLAIN_FIELD,
  SECRET_FIELD,
  TestResult,
  errorMessage,
} from "./shared";

const FIRST_TYPE = GATEWAY_TYPES[0];

/**
 * The one place gateway details are entered, whether the operator started from
 * the add-provider modal or from the gateways section.
 */
export function GatewayDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (gateway: ProviderGateway) => void;
}) {
  const createGateway = useCreateProviderGateway();
  const testGateway = useTestProviderGateway();
  // The descriptors are what make a second gateway type a data change: the
  // selector below appears only once there is something to select, and each
  // type's descriptor says which connection fields it needs.
  const [type, setType] = useState<GatewayType>(FIRST_TYPE);
  const descriptor = gatewayDescriptor(type);
  const [name, setName] = useState<string>(descriptor.defaultName);
  const [connection, setConnection] = useState<Record<string, string>>({});
  const [token, setToken] = useState("");
  const [tested, setTested] = useState<TestOutcome | null>(null);

  // The name is the operator's label; only the rest reaches the gateway, and
  // which of those it needs is the chosen type's own answer.
  const connectionReady = Boolean(
    token && descriptor.connectionFields.every((field) => connection[field.key]?.trim()),
  );
  const ready = Boolean(name.trim()) && connectionReady;

  /** The connection values as sent: trimmed, and only the chosen type's own. */
  const trimmed = () =>
    Object.fromEntries(Object.entries(connection).map(([key, value]) => [key, value.trim()]));

  const clear = () => {
    setType(FIRST_TYPE);
    setName(gatewayDescriptor(FIRST_TYPE).defaultName);
    setConnection({});
    setToken("");
    setTested(null);
    createGateway.reset();
    testGateway.reset();
  };

  /**
   * The only thing that ever calls the gateway. Saving does not: a connection
   * can be stored while the gateway side of it is still being built, and the
   * probe cannot tell an unfinished gateway from a wrong token anyway.
   */
  const test = async () => {
    if (!connectionReady) return;
    setTested(null);
    try {
      const result = await testGateway.mutateAsync(gatewayBody(type, trimmed(), { token }));
      setTested(gatewayOutcome(result));
    } catch (error) {
      setTested({
        status: "failed",
        message: errorMessage(error, "The connection could not be checked"),
      });
    } finally {
      // The submitted token also sits in the mutation's variables; drop it.
      testGateway.reset();
    }
  };

  /** A type switch carries none of the previous type's fields with it. */
  const chooseType = (next: GatewayType) => {
    setType(next);
    setName(gatewayDescriptor(next).defaultName);
    setConnection({});
    setToken("");
    setTested(null);
  };

  const close = () => {
    clear();
    onOpenChange(false);
  };

  const submit = async () => {
    if (!ready) return;
    try {
      // Each gateway's request body is exactly its own: the API rejects a field
      // the chosen type has no use for, so only its own connection fields go.
      const result = await createGateway.mutateAsync(
        gatewayBody(type, trimmed(), { name: name.trim(), token }),
      );
      clear();
      toast.success(`Added ${result.gateway.name}`);
      onCreated?.(result.gateway);
      onOpenChange(false);
    } catch (error) {
      setToken("");
      toast.error(errorMessage(error, "Could not add the gateway"));
    }
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      title="Add gateway"
      submitLabel="Add gateway"
      pending={createGateway.isPending}
      disabled={!ready}
      onSubmit={() => void submit()}
      secondaryAction={
        <Button
          type="button"
          variant="secondary"
          // Away from Cancel and Add gateway: a dry run is not a way out of the
          // form, and it should not read as one.
          className="sm:mr-auto"
          disabled={!connectionReady || testGateway.isPending}
          onClick={() => void test()}
        >
          {testGateway.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
          Test gateway
        </Button>
      }
    >
      <div className="space-y-4">
        {GATEWAY_TYPES.length > 1 ? (
          <Field label="Gateway type" htmlFor="gateway-type">
            {/* The same listbox the provider picker uses, for the same reason:
                a native <select> cannot carry the gateway's mark, and the type
                is exactly the field a brand identifies fastest. */}
            <Select
              value={type}
              onValueChange={(next) => chooseType(next as GatewayType)}
            >
              <SelectTrigger id="gateway-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GATEWAY_TYPES.map((entry) => (
                  <SelectItem key={entry} value={entry}>
                    <GatewayName type={entry} />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}
        <Field label="Name" htmlFor="gateway-name">
          <Input
            id="gateway-name"
            {...PLAIN_FIELD}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        {descriptor.connectionFields.map((field) => (
          <Field
            key={field.key}
            label={field.label}
            htmlFor={`gateway-${field.key}`}
            hint={field.hint}
          >
            <Input
              id={`gateway-${field.key}`}
              {...PLAIN_FIELD}
              placeholder={field.placeholder}
              value={connection[field.key] ?? ""}
              onChange={(event) => {
                const value = event.target.value;
                setConnection((current) => ({ ...current, [field.key]: value }));
                setTested(null);
              }}
            />
          </Field>
        ))}
        <Field
          label="Gateway token"
          htmlFor="gateway-token"
          hint={
            <a
              className="underline underline-offset-4"
              href={descriptor.tokenDocsUrl}
              target="_blank"
              rel="noreferrer"
            >
              How to create the token
            </a>
          }
        >
          <Input
            id="gateway-token"
            {...SECRET_FIELD}
            value={token}
            onChange={(event) => {
              setToken(event.target.value);
              setTested(null);
            }}
          />
        </Field>
        <p className="text-xs text-muted-foreground">{descriptor.credentialNote}</p>
        {tested ? <TestResult outcome={tested} /> : null}
      </div>
    </FormDialog>
  );
}
