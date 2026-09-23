import { useEffect, useRef, useState } from "react";
import { Cable, KeyRound, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { GatewayIcon, ProviderName } from "@/components/brand-icon";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { GuardedButton } from "@/components/guarded-button";
import { ApiError } from "@/lib/api";
import { PROVIDERS, PROVIDER_LABELS, type Provider } from "@/lib/config-types";
import { testOutcome, type TestOutcome } from "@/lib/provider-probe";
import {
  useCreateProvider,
  useProviderGateways,
  useProviders,
  useTestProvider,
} from "@/lib/queries";
import type { ProviderCredential, ProviderGateway } from "@/lib/types";
import { GatewayDialog } from "./gateway-dialog";
import {
  PLAIN_FIELD,
  SECRET_FIELD,
  TestResult,
  errorMessage,
} from "./shared";

/** The gateway select's sentinel value, which opens the gateway modal instead. */
const NEW_GATEWAY = "__new__";

/**
 * The whole add-provider flow, from the first field to the created row.
 *
 * The connection choice decides what the row carries: its own API key, or a
 * reference to a gateway whose token authenticates it. Choosing a gateway that
 * does not exist yet opens the gateway modal on top of this one, so the
 * provider being described is never thrown away to go and create it.
 *
 * Exported so the first-run checklist on the apps page can open the very same
 * modal rather than sending an operator here mid-task, or growing a second copy
 * of a form that holds a provider credential. {@link AddProviderButton} is the
 * wrapper that owns the open state for those callers.
 */
export function AddProviderDialog({
  open,
  onOpenChange,
  providers,
  gateways,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providers: ProviderCredential[];
  gateways: ProviderGateway[];
}) {
  const createProvider = useCreateProvider();
  const testProvider = useTestProvider();
  const [type, setType] = useState<Provider>("openai");
  const [name, setName] = useState("");
  const [connection, setConnection] = useState<"key" | "gateway">("key");
  const [secret, setSecret] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [gatewayId, setGatewayId] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTaken, setSlugTaken] = useState(false);
  const [gatewayOpen, setGatewayOpen] = useState(false);
  // A gateway created from this modal, kept until the refetched list contains
  // it: a select whose value has no option would drop the pre-selection.
  const [created, setCreated] = useState<ProviderGateway | null>(null);
  const [tested, setTested] = useState<TestOutcome | null>(null);

  const slugInput = useRef<HTMLInputElement>(null);
  // Focus follows the operator's own action — opening the modal must not take
  // it off the first field.
  const focusSlug = useRef(false);
  useEffect(() => {
    if (!focusSlug.current || !slugInput.current) return;
    focusSlug.current = false;
    slugInput.current.focus();
  });

  const listed = gateways.filter((entry) => entry.status === "active");
  const active = created && !listed.some((entry) => entry.id === created.id)
    ? [...listed, created]
    : listed;
  // Only the default slug being taken forces a manual one — an existing
  // instance created under a custom slug leaves `openai` free for the next one.
  // A 409 asks for a slug in every case the client cannot see.
  //
  // Status is not part of it: a row holds its slug until it is deleted, so a
  // disabled instance blocks the default exactly as an active one does.
  const defaultSlugTaken = (candidate: Provider) =>
    providers.some((row) => row.slug === candidate);
  const slugRequired = slugTaken || defaultSlugTaken(type);

  const chooseType = (next: Provider) => {
    setType(next);
    setSlugTaken(false);
    // A verdict belongs to the credential that was probed, not to the next one.
    setTested(null);
    if (defaultSlugTaken(next)) {
      focusSlug.current = true;
    } else {
      // The field is about to disappear; a hidden value must not be submitted.
      setSlug("");
    }
  };

  const credentialReady = connection === "key" ? Boolean(secret) : Boolean(gatewayId);
  const ready = Boolean(name.trim()) && credentialReady && (!slugRequired || Boolean(slug.trim()));

  const clear = () => {
    setType("openai");
    setName("");
    setConnection("key");
    setSecret("");
    setBaseUrl("");
    setGatewayId("");
    setSlug("");
    setSlugTaken(false);
    setCreated(null);
    setTested(null);
    createProvider.reset();
    testProvider.reset();
  };

  const close = () => {
    clear();
    onOpenChange(false);
  };

  /** The origin fields to send, present only on a direct row that set one. */
  const baseUrlBody = connection === "key" && baseUrl.trim()
    ? { baseUrl: baseUrl.trim() }
    : {};

  /**
   * The only thing that ever calls the provider. Storing the key does not, so a
   * probe that proves nothing — an outage, a provider with no test call — never
   * stands between an operator and a key they trust.
   */
  const test = async () => {
    if (!credentialReady) return;
    setTested(null);
    try {
      const result = await testProvider.mutateAsync({
        type,
        ...(connection === "key" ? { secret, ...baseUrlBody } : { providerGatewayId: gatewayId }),
      });
      setTested(testOutcome(result, type, connection === "gateway"));
    } catch (error) {
      setTested({
        status: "failed",
        message: errorMessage(error, "The credential could not be checked"),
      });
    } finally {
      // The submitted secret also sits in the mutation's variables; drop it.
      testProvider.reset();
    }
  };

  const submit = async () => {
    if (!ready) return;
    try {
      await createProvider.mutateAsync({
        type,
        name: name.trim(),
        ...(slug.trim() ? { slug: slug.trim() } : {}),
        ...(connection === "key" ? { secret, ...baseUrlBody } : { providerGatewayId: gatewayId }),
      });
      // The plaintext leaves component state and the mutation cache immediately;
      // the server never returns it again.
      close();
      toast.success(`Added ${PROVIDER_LABELS[type]}`);
    } catch (error) {
      // Everything but the credential survives, so the operator only retypes
      // the one field the failure could have burned.
      setSecret("");
      if (error instanceof ApiError && error.code === "slug_taken") {
        setSlugTaken(true);
        focusSlug.current = true;
      }
      toast.error(errorMessage(error, "Could not store the credential"));
    }
  };

  return (
    <>
      <FormDialog
        open={open}
        onOpenChange={(next) => (next ? onOpenChange(true) : close())}
        title="Add a provider"
        submitLabel="Add provider"
        pending={createProvider.isPending}
        disabled={!ready}
        onSubmit={() => void submit()}
        secondaryAction={
          <Button
            type="button"
            variant="secondary"
            // Away from Cancel and Add provider: a dry run is not a way out of
            // the form, and it should not read as one.
            className="sm:mr-auto"
            disabled={!credentialReady || testProvider.isPending}
            onClick={() => void test()}
          >
            {testProvider.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Test provider
          </Button>
        }
      >
        {/* One field per row, in the order they are decided: what to call it,
            which provider it is, and only then how it authenticates. */}
        <div className="space-y-4">
          <Field
            label="Name"
            htmlFor="provider-name"
            hint="How this provider is named in the list."
          >
            <Input
              id="provider-name"
              {...PLAIN_FIELD}
              value={name}
              placeholder="Prod OpenAI"
              autoFocus
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label="Provider" htmlFor="provider-type">
            <Select value={type} onValueChange={(next) => chooseType(next as Provider)}>
              <SelectTrigger id="provider-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDERS.map((entry) => (
                  <SelectItem key={entry} value={entry}>
                    <ProviderName type={entry} />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field
            label="Authentication"
            htmlFor="provider-authentication"
            hint="Call the provider directly, or route through a gateway."
          >
            <Select
              value={connection}
              onValueChange={(next) => {
                setConnection(next as "key" | "gateway");
                // A gateway owns its own origin, so a base URL typed for the
                // direct case must not be carried into the request invisibly.
                if (next === "gateway") setBaseUrl("");
                setTested(null);
              }}
            >
              <SelectTrigger id="provider-authentication" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {/* Glyphs, not brand marks: the two answers are ways of
                    reaching a provider, and neither belongs to a vendor. The
                    routed one carries the sidebar's Gateways glyph, so the
                    answer and the destination it points at look alike. */}
                <SelectItem value="key">
                  <KeyRound />
                  API key
                </SelectItem>
                <SelectItem value="gateway">
                  <Cable />
                  Use gateway
                </SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {connection === "key" ? (
            <>
              <Field label="API key" htmlFor="provider-secret">
                <Input
                  id="provider-secret"
                  {...SECRET_FIELD}
                  value={secret}
                  placeholder="sk-…"
                  onChange={(event) => {
                    setSecret(event.target.value);
                    setTested(null);
                  }}
                />
              </Field>
              {/* Optional, and only on the direct route: a gateway supplies its
                  own origin, so the field is not rendered at all in that mode. */}
              <Field
                label="Base URL (optional)"
                htmlFor="provider-base-url"
                hint="Point this instance at an OpenAI-compatible endpoint you control — Azure OpenAI, vLLM, a proxy. HTTPS, port 443, no path-only tweaks beyond the base. Leave empty to use the provider's own API."
              >
                <Input
                  id="provider-base-url"
                  {...PLAIN_FIELD}
                  className="font-mono"
                  value={baseUrl}
                  placeholder="https://my-vllm.example.com/v1/"
                  onChange={(event) => {
                    setBaseUrl(event.target.value);
                    setTested(null);
                  }}
                />
              </Field>
            </>
          ) : (
            <Field
              label="Gateway"
              htmlFor="provider-gateway"
              hint="The provider's own key lives in that gateway; this row carries no secret."
            >
              <Select
                value={gatewayId}
                onValueChange={(next) => {
                  // Radix echoes an empty value from its hidden native select for
                  // one commit after a freshly created gateway is pre-selected,
                  // before that option is registered. No item is ever empty.
                  if (!next) return;
                  if (next === NEW_GATEWAY) {
                    setGatewayOpen(true);
                    return;
                  }
                  setGatewayId(next);
                  setTested(null);
                }}
              >
                <SelectTrigger id="provider-gateway" className="w-full">
                  <SelectValue
                    placeholder={active.length ? "Choose a gateway" : "No gateways yet"}
                  />
                </SelectTrigger>
                <SelectContent>
                  {active.map((entry) => (
                    <SelectItem key={entry.id} value={entry.id}>
                      <span className="inline-flex items-center gap-1.5">
                        <GatewayIcon type={entry.type} />
                        {entry.name}
                      </span>
                    </SelectItem>
                  ))}
                  {/* Last, behind a rule, in the accent colour and led by a
                      plus: everything above is a gateway to pick, this one is
                      an action that opens a form. The ellipsis says so too. */}
                  {active.length ? <SelectSeparator /> : null}
                  <SelectItem
                    value={NEW_GATEWAY}
                    className="font-medium text-primary-ink focus:text-primary-ink"
                  >
                    <Plus className="size-4 text-primary-ink" />
                    New gateway…
                  </SelectItem>
                </SelectContent>
              </Select>
            </Field>
          )}
          {slugRequired ? (
            <Field
              label="Slug"
              htmlFor="provider-slug"
              hint={
                <>
                  Another instance already uses <code className="font-mono">{type}</code>, so this
                  one needs its own <code className="font-mono">/proxy/&lt;slug&gt;/…</code>{" "}
                  segment.
                </>
              }
            >
              <Input
                id="provider-slug"
                ref={slugInput}
                {...PLAIN_FIELD}
                className="font-mono"
                value={slug}
                placeholder={`${type}-dev`}
                onChange={(event) => setSlug(event.target.value)}
              />
            </Field>
          ) : null}
          {tested ? <TestResult outcome={tested} /> : null}
        </div>
      </FormDialog>

      {/* A sibling of the dialog, not a child: rendered inside it, this form
          would bubble its own submit through the React tree and add the
          provider prematurely. */}
      <GatewayDialog
        open={gatewayOpen}
        onOpenChange={setGatewayOpen}
        onCreated={(gateway) => {
          setCreated(gateway);
          setGatewayId(gateway.id);
        }}
      />
    </>
  );
}

/**
 * The add-provider modal plus the control that opens it.
 *
 * For callers that offer adding a provider as one step among others and have no
 * page header to hang a button on — the first-run checklist on the apps page.
 * The state, the lists the form needs and the read-only guard all stay here, so
 * such a caller adds a provider without knowing anything about how one is made.
 */
export function AddProviderButton({ label = "Add provider" }: { label?: string }) {
  const [open, setOpen] = useState(false);
  const list = useProviders();
  // Only the open modal has any use for them, and most visitors never open it.
  const gatewayList = useProviderGateways(open);

  return (
    <>
      <GuardedButton size="sm" onClick={() => setOpen(true)}>
        {label}
      </GuardedButton>
      <AddProviderDialog
        open={open}
        onOpenChange={setOpen}
        providers={list.data?.providers ?? []}
        gateways={gatewayList.data?.gateways ?? []}
      />
    </>
  );
}
