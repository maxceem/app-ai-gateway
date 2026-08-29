import { useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState, Field, SectionHeader } from "@/components/field";
import { GuardedButton } from "@/components/guarded-button";
import { ApiError } from "@/lib/api";
import { useConsoleSession } from "@/lib/console-session";
import { PROVIDERS, PROVIDER_LABELS, type Provider } from "@/lib/config-types";
import { formatDateTime } from "@/lib/format";
import {
  useCreateProvider,
  useCreateProviderGateway,
  useDeleteProvider,
  useDeleteProviderGateway,
  useProviderGateways,
  useProviders,
  useRenameProviderGateway,
  useRotateProviderGateway,
  useUpdateProvider,
} from "@/lib/queries";
import type { ProviderCredential, ProviderGateway, ProviderPricing } from "@/lib/types";

/**
 * Browsers ignore `autocomplete="off"` on anything that looks like a sign-in
 * form: a text input next to a password input is heuristically username +
 * password, so the operator's own saved site credentials get filled into a
 * provider name and its API key. `new-password` is the value Chrome and Safari
 * actually honour, and the `data-*` opt-outs cover 1Password and LastPass.
 */
const NO_AUTOFILL = {
  "data-1p-ignore": "true",
  "data-lpignore": "true",
};

/** Text fields that sit beside a credential and must not be read as a username. */
const PLAIN_FIELD = { autoComplete: "off", ...NO_AUTOFILL };

/** Every field that accepts a provider credential. */
const SECRET_FIELD = {
  type: "password",
  autoComplete: "new-password",
  spellCheck: false,
  ...NO_AUTOFILL,
} as const;

/** A repeatable pricing row while it is still being typed. */
interface PricingDraft {
  model: string;
  input: string;
  output: string;
}

function toDrafts(pricing: ProviderPricing | null): PricingDraft[] {
  return Object.entries(pricing ?? {}).map(([model, entry]) => ({
    model,
    input: String(entry.input),
    output: String(entry.output),
  }));
}

/**
 * Returns the object to send, or a message naming the first unusable row.
 *
 * A row left entirely blank is dropped, so an operator can leave a spare one
 * lying around. Anything else must be complete: `Number("")` is 0, and a price
 * of $0 has to be a deliberate answer rather than an empty field, because
 * entering a price is what allows a model to be proxied at all.
 */
export function draftsToPricing(
  drafts: PricingDraft[],
): { pricing: ProviderPricing } | { error: string } {
  const pricing: ProviderPricing = {};
  for (const draft of drafts) {
    const model = draft.model.trim();
    const input = draft.input.trim();
    const output = draft.output.trim();
    if (!model && !input && !output) continue;
    if (!model) return { error: "Every pricing row needs a model name" };
    if (!input || !output) {
      return { error: `Enter both prices for ${model} — use 0 only if it is genuinely free` };
    }
    const inputPrice = Number(input);
    const outputPrice = Number(output);
    if (
      !Number.isFinite(inputPrice) || inputPrice < 0
      || !Number.isFinite(outputPrice) || outputPrice < 0
    ) {
      return { error: `Prices for ${model} must be numbers of 0 or more` };
    }
    // Two rows for one model would otherwise let the last one win in silence.
    if (Object.hasOwn(pricing, model)) {
      return { error: `${model} is priced twice — remove the duplicate row` };
    }
    pricing[model] = { input: inputPrice, output: outputPrice };
  }
  return { pricing };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/** Anchors the Gateways section's row for a gateway, so a provider can link to it. */
const gatewayAnchor = (id: string) => `gateway-${id}`;

/**
 * Why this gateway cannot be deleted, mirroring the API's `gateway_in_use`
 * message. Revoked rows are kept for audit and still hold the foreign key, so a
 * gateway serving no traffic can still be undeletable — saying "active" there
 * would be a lie the operator cannot act on.
 */
function deleteBlockedReason(gateway: ProviderGateway): string | undefined {
  if (gateway.referencedCount === 0) return undefined;
  if (gateway.providerCount === 0) {
    return "Revoked provider instances still reference this gateway; delete them to release it";
  }
  return gateway.referencedCount > gateway.providerCount
    ? "Delete the active and revoked provider instances routed through this gateway first"
    : "Delete every active provider instance routed through this gateway first";
}

/**
 * The gateway's own name, not its Cloudflare IDs: an operator recognises "Prod
 * CF gateway" but not the opaque gateway id it was created with. The name links
 * to that gateway's row, where its connection and actions live.
 */
function RoutedVia({
  row,
  gateways,
}: {
  row: ProviderCredential;
  gateways: ProviderGateway[];
}) {
  if (row.providerGatewayId === null) return <>Direct</>;
  const gateway = gateways.find((entry) => entry.id === row.providerGatewayId);
  if (!gateway) return <>Gateway</>;
  return (
    <a
      className="underline underline-offset-4"
      href={`#${gatewayAnchor(gateway.id)}`}
      onClick={() => {
        document
          .getElementById(gatewayAnchor(gateway.id))
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      }}
    >
      {gateway.name}
    </a>
  );
}

export function ProvidersPage() {
  const { readOnly } = useConsoleSession();
  const list = useProviders();
  const gatewayList = useProviderGateways();
  const deleteProvider = useDeleteProvider();

  const [editing, setEditing] = useState<ProviderCredential | null>(null);
  const [rotating, setRotating] = useState<ProviderCredential | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProviderCredential | null>(null);

  const providers = list.data?.providers ?? [];
  const gateways = gatewayList.data?.gateways ?? [];

  const remove = async () => {
    if (!pendingDelete) return;
    try {
      await deleteProvider.mutateAsync(pendingDelete.id);
      toast.success(`Deleted ${pendingDelete.name}`);
      setPendingDelete(null);
    } catch (error) {
      toast.error(errorMessage(error, "Could not delete the provider"));
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Providers</h1>
        <p className="text-sm text-muted-foreground">
          Your own credentials for the model providers this organization uses. They are encrypted
          before storage and never shown again — only the last few characters.
        </p>
      </div>

      {list.isError ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Could not load providers</AlertTitle>
          <AlertDescription>{errorMessage(list.error, "Unknown error")}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardContent>
          <AddProviderForm readOnly={readOnly} providers={providers} gateways={gateways} />
        </CardContent>
      </Card>

      <Card className="overflow-hidden py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Provider</TableHead>
              <TableHead>Slug</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Key</TableHead>
              <TableHead>Routed via</TableHead>
              <TableHead>Custom pricing</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.isPending ? (
              [0, 1, 2].map((row) => (
                <TableRow key={row}>
                  <TableCell colSpan={8}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : providers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                  No providers yet. Add a key per provider, or route one through a gateway.
                </TableCell>
              </TableRow>
            ) : (
              providers.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <Badge variant="secondary">{PROVIDER_LABELS[row.type]}</Badge>
                  </TableCell>
                  {/* The slug is a URL segment, so it is shown exactly as typed. */}
                  <TableCell className="font-mono text-xs">{row.slug}</TableCell>
                  <TableCell className="font-medium">{row.name}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {row.secretHint === null ? "—" : `…${row.secretHint}`}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    <RoutedVia row={row} gateways={gateways} />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {Object.keys(row.pricing ?? {}).length || "—"}
                  </TableCell>
                  <TableCell className="tabular text-muted-foreground">
                    {formatDateTime(row.createdAt)}
                  </TableCell>
                  <TableCell className="space-x-2 text-right">
                    <Button variant="outline" size="sm" onClick={() => setEditing(row)}>
                      Pricing
                    </Button>
                    <GuardedButton
                      variant="outline"
                      size="sm"
                      reason={
                        row.providerGatewayId === null
                          ? undefined
                          : "This instance authenticates with the gateway token — rotate the gateway instead"
                      }
                      onClick={() => setRotating(row)}
                    >
                      Rotate
                    </GuardedButton>
                    <GuardedButton
                      variant="outline"
                      size="sm"
                      aria-label={`Delete ${row.name}`}
                      onClick={() => setPendingDelete(row)}
                    >
                      <Trash2 className="size-4" />
                    </GuardedButton>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      <GatewaysSection
        gateways={gateways}
        pending={gatewayList.isPending}
        error={gatewayList.isError ? gatewayList.error : null}
      />

      <RotateDialog provider={rotating} onClose={() => setRotating(null)} />
      <PricingDialog provider={editing} onClose={() => setEditing(null)} readOnly={readOnly} />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title="Delete provider"
        description={
          <>
            <p>
              Apps using{" "}
              <span className="font-medium text-foreground">
                {pendingDelete ? PROVIDER_LABELS[pendingDelete.type] : ""}
              </span>{" "}
              start failing within a minute, and any custom pricing on this provider is deleted with
              it.
            </p>
            <p>This cannot be undone. Rotate the key instead if you only want to replace it.</p>
          </>
        }
        confirmLabel="Delete provider"
        destructive
        pending={deleteProvider.isPending}
        onConfirm={() => void remove()}
      />
    </div>
  );
}

function validationNotice(validated: boolean | null): string | undefined {
  return validated === false
    ? "Saved, but the provider did not confirm the credential. Check it if requests start failing."
    : undefined;
}

/** The gateway select's sentinel value, which opens the gateway modal instead. */
const NEW_GATEWAY = "__new__";

/**
 * One provider-first form. The connection choice decides what the row carries:
 * its own API key, or a reference to a gateway whose token authenticates it.
 */
function AddProviderForm({
  readOnly,
  providers,
  gateways,
}: {
  readOnly: boolean;
  providers: ProviderCredential[];
  gateways: ProviderGateway[];
}) {
  const createProvider = useCreateProvider();
  const [type, setType] = useState<Provider>("openai");
  const [name, setName] = useState("");
  const [connection, setConnection] = useState<"key" | "gateway">("key");
  const [secret, setSecret] = useState("");
  const [gatewayId, setGatewayId] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTaken, setSlugTaken] = useState(false);
  const [gatewayOpen, setGatewayOpen] = useState(false);
  // A gateway created from this form, kept until the refetched list contains it:
  // a select whose value has no option would drop the pre-selection.
  const [created, setCreated] = useState<ProviderGateway | null>(null);

  const slugInput = useRef<HTMLInputElement>(null);
  // Focus follows the operator's own action — opening the page must not steal it.
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
  const defaultSlugTaken = (candidate: Provider) =>
    providers.some((row) => row.status === "active" && row.slug === candidate);
  const slugRequired = slugTaken || defaultSlugTaken(type);

  const chooseType = (next: Provider) => {
    setType(next);
    setSlugTaken(false);
    if (defaultSlugTaken(next)) {
      focusSlug.current = true;
    } else {
      // The field is about to disappear; a hidden value must not be submitted.
      setSlug("");
    }
  };

  const credentialReady = connection === "key" ? Boolean(secret) : Boolean(gatewayId);
  const ready = Boolean(name.trim()) && credentialReady && (!slugRequired || Boolean(slug.trim()));

  const submit = async () => {
    if (!ready) return;
    try {
      const result = await createProvider.mutateAsync({
        type,
        name: name.trim(),
        ...(slug.trim() ? { slug: slug.trim() } : {}),
        ...(connection === "key" ? { secret } : { providerGatewayId: gatewayId }),
      });
      // The plaintext leaves component state and the mutation cache immediately;
      // the server never returns it again.
      setSecret("");
      setName("");
      setSlug("");
      setSlugTaken(false);
      createProvider.reset();
      toast.success(`Added ${PROVIDER_LABELS[type]}`, {
        description: validationNotice(result.validated),
      });
    } catch (error) {
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
      <form
        className="grid gap-4 sm:grid-cols-3"
        autoComplete="off"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field
          label="Provider"
          htmlFor="provider-type"
          // With no slug of its own the instance takes the default one, so the
          // URL callers already use is the promise being made here.
          hint={
            slugRequired ? undefined : (
              <>
                Callers reach it at <code className="font-mono">/proxy/{type}/…</code>
              </>
            )
          }
        >
          <Select value={type} onValueChange={(next) => chooseType(next as Provider)}>
            <SelectTrigger id="provider-type" className="w-full" disabled={readOnly}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROVIDERS.map((entry) => (
                <SelectItem key={entry} value={entry}>
                  {PROVIDER_LABELS[entry]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Name" htmlFor="provider-name" hint="How this credential appears in the list.">
          <Input
            id="provider-name"
            {...PLAIN_FIELD}
            value={name}
            placeholder="Prod OpenAI"
            disabled={readOnly}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field
          label="Connection"
          htmlFor="provider-connection"
          hint="How the gateway authenticates to this provider."
        >
          <Select
            value={connection}
            onValueChange={(next) => setConnection(next as "key" | "gateway")}
          >
            <SelectTrigger id="provider-connection" className="w-full" disabled={readOnly}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="key">API key</SelectItem>
              <SelectItem value="gateway">Via gateway</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {connection === "key" ? (
          <Field
            label="API key"
            htmlFor="provider-secret"
            hint="Checked against the provider before it is stored."
          >
            <Input
              id="provider-secret"
              {...SECRET_FIELD}
              value={secret}
              placeholder="sk-…"
              disabled={readOnly}
              onChange={(event) => setSecret(event.target.value)}
            />
          </Field>
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
              }}
            >
              <SelectTrigger id="provider-gateway" className="w-full" disabled={readOnly}>
                <SelectValue placeholder="Choose a gateway" />
              </SelectTrigger>
              <SelectContent>
                {active.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {entry.name}
                  </SelectItem>
                ))}
                <SelectItem value={NEW_GATEWAY}>Configure new gateway…</SelectItem>
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
                Another instance already uses <code className="font-mono">{type}</code>, so this one
                needs its own <code className="font-mono">/proxy/&lt;slug&gt;/…</code> segment.
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
              disabled={readOnly}
              onChange={(event) => setSlug(event.target.value)}
            />
          </Field>
        ) : null}
        <div className="sm:col-span-3">
          <GuardedButton type="submit" disabled={!ready || createProvider.isPending}>
            {createProvider.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Add provider
          </GuardedButton>
        </div>
      </form>

      {/* Outside the form: a dialog rendered inside it would bubble its own
          submit through the React tree and add the provider prematurely. */}
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

function GatewaysSection({
  gateways,
  pending,
  error,
}: {
  gateways: ProviderGateway[];
  pending: boolean;
  error: unknown;
}) {
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<ProviderGateway | null>(null);
  const [rotating, setRotating] = useState<ProviderGateway | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProviderGateway | null>(null);
  const deleteGateway = useDeleteProviderGateway();

  const remove = async () => {
    if (!pendingDelete) return;
    try {
      await deleteGateway.mutateAsync(pendingDelete.id);
      toast.success(`Deleted ${pendingDelete.name}`);
      setPendingDelete(null);
    } catch (deleteError) {
      toast.error(errorMessage(deleteError, "Could not delete the gateway"));
    }
  };

  return (
    <div className="space-y-3">
      <SectionHeader
        title="Gateways"
        description={
          <>
            Reusable connections to your own Cloudflare AI Gateway. The provider keys themselves
            live in that gateway&rsquo;s stored-keys (BYOK) store — only the gateway token is kept
            here, encrypted once and shared by every provider routed through it.{" "}
            <a
              className="underline underline-offset-4"
              href="https://developers.cloudflare.com/ai-gateway/configuration/authentication/"
              target="_blank"
              rel="noreferrer"
            >
              How to create the token
            </a>
            .
          </>
        }
        action={
          <GuardedButton size="sm" onClick={() => setAdding(true)}>
            Add gateway
          </GuardedButton>
        }
      />

      {error ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Could not load gateways</AlertTitle>
          <AlertDescription>{errorMessage(error, "Unknown error")}</AlertDescription>
        </Alert>
      ) : null}

      <Card className="overflow-hidden py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Gateway</TableHead>
              <TableHead>Token</TableHead>
              <TableHead>Providers</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pending ? (
              [0, 1].map((row) => (
                <TableRow key={row}>
                  <TableCell colSpan={5}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : gateways.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                  No gateways yet. Add one to route providers through it.
                </TableCell>
              </TableRow>
            ) : (
              gateways.map((row) => (
                <TableRow key={row.id} id={gatewayAnchor(row.id)}>
                  <TableCell className="font-medium">{row.name}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {row.config.accountId} · {row.config.gatewayId}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    …{row.secretHint}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {row.providerCount}
                  </TableCell>
                  <TableCell className="space-x-2 text-right">
                    <GuardedButton variant="outline" size="sm" onClick={() => setRotating(row)}>
                      Rotate
                    </GuardedButton>
                    <GuardedButton variant="outline" size="sm" onClick={() => setRenaming(row)}>
                      Rename
                    </GuardedButton>
                    <GuardedButton
                      variant="outline"
                      size="sm"
                      aria-label={`Delete ${row.name}`}
                      reason={deleteBlockedReason(row)}
                      onClick={() => setPendingDelete(row)}
                    >
                      <Trash2 className="size-4" />
                    </GuardedButton>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      <GatewayDialog open={adding} onOpenChange={setAdding} />
      <RenameGatewayDialog gateway={renaming} onClose={() => setRenaming(null)} />
      <RotateGatewayDialog gateway={rotating} onClose={() => setRotating(null)} />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title="Delete gateway"
        description={
          <p>
            The stored token for{" "}
            <span className="font-medium text-foreground">{pendingDelete?.name}</span> is destroyed.
            Nothing routes through it, so no traffic changes.
          </p>
        }
        confirmLabel="Delete gateway"
        destructive
        pending={deleteGateway.isPending}
        onConfirm={() => void remove()}
      />
    </div>
  );
}

/**
 * The one place gateway details are entered, whether the operator started from
 * the add-provider form or from the gateways section.
 */
function GatewayDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (gateway: ProviderGateway) => void;
}) {
  const createGateway = useCreateProviderGateway();
  const [name, setName] = useState("Our CF gateway");
  const [accountId, setAccountId] = useState("");
  const [gatewayId, setGatewayId] = useState("");
  const [token, setToken] = useState("");

  const ready = Boolean(name.trim() && accountId.trim() && gatewayId.trim() && token);

  const clear = () => {
    setName("Our CF gateway");
    setAccountId("");
    setGatewayId("");
    setToken("");
    createGateway.reset();
  };

  const close = () => {
    clear();
    onOpenChange(false);
  };

  const submit = async () => {
    if (!ready) return;
    try {
      const result = await createGateway.mutateAsync({
        type: "cf_aig",
        name: name.trim(),
        accountId: accountId.trim(),
        gatewayId: gatewayId.trim(),
        token,
      });
      clear();
      toast.success(`Added ${result.gateway.name}`, {
        description: validationNotice(result.validated ?? null),
      });
      onCreated?.(result.gateway);
      onOpenChange(false);
    } catch (error) {
      setToken("");
      toast.error(errorMessage(error, "Could not add the gateway"));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add gateway</DialogTitle>
          <DialogDescription>
            A Cloudflare AI Gateway this organization already owns. Providers are attached to it one
            at a time, from the add-provider form.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="gateway-name">
            <Input
              id="gateway-name"
              {...PLAIN_FIELD}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label="Account ID" htmlFor="gateway-account">
            <Input
              id="gateway-account"
              {...PLAIN_FIELD}
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
            />
          </Field>
          <Field label="Gateway ID" htmlFor="gateway-gateway">
            <Input
              id="gateway-gateway"
              {...PLAIN_FIELD}
              value={gatewayId}
              onChange={(event) => setGatewayId(event.target.value)}
            />
          </Field>
          <Field label="Gateway token" htmlFor="gateway-token">
            <Input
              id="gateway-token"
              {...SECRET_FIELD}
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <GuardedButton
            disabled={!ready || createGateway.isPending}
            onClick={() => void submit()}
          >
            {createGateway.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Save gateway
          </GuardedButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RenameGatewayDialog({
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
      await renameGateway.mutateAsync({ id: gateway.id, name: name.trim() });
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
          <DialogDescription>
            Only the display name changes. Nothing about the connection or the providers routed
            through it moves.
          </DialogDescription>
        </DialogHeader>
        <Field label="Name" htmlFor="gateway-rename">
          <Input
            id="gateway-rename"
            {...PLAIN_FIELD}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
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

function RotateGatewayDialog({
  gateway,
  onClose,
}: {
  gateway: ProviderGateway | null;
  onClose: () => void;
}) {
  const rotateGateway = useRotateProviderGateway();
  const [token, setToken] = useState("");

  const close = () => {
    setToken("");
    rotateGateway.reset();
    onClose();
  };

  const submit = async () => {
    if (!gateway || !token) return;
    try {
      const result = await rotateGateway.mutateAsync({ id: gateway.id, token });
      setToken("");
      rotateGateway.reset();
      toast.success(`Rotated ${gateway.name}`, {
        description: validationNotice(result.validated ?? null),
      });
      onClose();
    } catch (error) {
      setToken("");
      toast.error(errorMessage(error, "Could not rotate the gateway token"));
    }
  };

  return (
    <Dialog open={gateway !== null} onOpenChange={(open) => (open ? undefined : close())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rotate {gateway?.name}</DialogTitle>
          <DialogDescription>
            One token authenticates every provider routed through this gateway, so all{" "}
            {gateway?.providerCount ?? 0} of them pick the new one up within a minute.
          </DialogDescription>
        </DialogHeader>
        <Field label="New gateway token" htmlFor="gateway-rotate-token">
          <Input
            id="gateway-rotate-token"
            {...SECRET_FIELD}
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button disabled={!token || rotateGateway.isPending} onClick={() => void submit()}>
            {rotateGateway.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Rotate token
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RotateDialog({
  provider,
  onClose,
}: {
  provider: ProviderCredential | null;
  onClose: () => void;
}) {
  const updateProvider = useUpdateProvider();
  const [secret, setSecret] = useState("");

  const close = () => {
    setSecret("");
    updateProvider.reset();
    onClose();
  };

  const submit = async () => {
    if (!provider || !secret) return;
    try {
      const result = await updateProvider.mutateAsync({ id: provider.id, body: { secret } });
      setSecret("");
      updateProvider.reset();
      toast.success(`Rotated ${provider.name}`, {
        description: validationNotice(result.validated),
      });
      onClose();
    } catch (error) {
      setSecret("");
      toast.error(errorMessage(error, "Could not rotate the credential"));
    }
  };

  return (
    <Dialog open={provider !== null} onOpenChange={(open) => (open ? undefined : close())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rotate {provider?.name}</DialogTitle>
          <DialogDescription>
            The new credential replaces the old one in place. Custom pricing is kept, and requests
            pick it up within a minute.
          </DialogDescription>
        </DialogHeader>
        <Field label="New API key" htmlFor="rotate-secret">
          <Input
            id="rotate-secret"
            {...SECRET_FIELD}
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
          />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button disabled={!secret || updateProvider.isPending} onClick={() => void submit()}>
            {updateProvider.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Rotate key
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Pricing is ordinary non-secret data, so it is shown and edited normally —
 * none of the write-only handling the credential needs applies here.
 */
function PricingDialog({
  provider,
  onClose,
  readOnly,
}: {
  provider: ProviderCredential | null;
  onClose: () => void;
  readOnly: boolean;
}) {
  const updateProvider = useUpdateProvider();
  const [drafts, setDrafts] = useState<PricingDraft[]>([]);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  if (provider && loadedFor !== provider.id) {
    setLoadedFor(provider.id);
    setDrafts(toDrafts(provider.pricing));
  }

  const setRow = (index: number, patch: Partial<PricingDraft>) => {
    setDrafts((current) =>
      current.map((row, position) => (position === index ? { ...row, ...patch } : row)),
    );
  };

  const submit = async () => {
    if (!provider) return;
    const result = draftsToPricing(drafts);
    if ("error" in result) {
      toast.error(result.error);
      return;
    }
    try {
      await updateProvider.mutateAsync({
        id: provider.id,
        body: { pricing: Object.keys(result.pricing).length ? result.pricing : null },
      });
      toast.success(`Updated pricing for ${provider.name}`);
      onClose();
    } catch (error) {
      toast.error(errorMessage(error, "Could not save the pricing"));
    }
  };

  return (
    <Dialog
      open={provider !== null}
      onOpenChange={(open) => {
        if (!open) {
          setLoadedFor(null);
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Custom model pricing</DialogTitle>
          <DialogDescription>
            For models the built-in catalog does not cover, or prices it in a way you disagree with.
            Requests for unpriced models are rejected until a price is set here. Enter $0 for a model
            that is genuinely free.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {drafts.length === 0 ? (
            <EmptyState>No custom prices for this provider.</EmptyState>
          ) : (
            <>
              {/* One header row instead of a label per input: the rows repeat, so
                  the columns are named once and each field carries its own
                  accessible name. */}
              <div
                aria-hidden
                className="grid grid-cols-[2fr_1fr_1fr_auto] gap-2 text-xs text-muted-foreground"
              >
                <span>Model</span>
                <span>Input $/1M</span>
                <span>Output $/1M</span>
                <span className="w-9" />
              </div>
              {drafts.map((row, index) => (
                <div key={index} className="grid grid-cols-[2fr_1fr_1fr_auto] items-center gap-2">
                  <Input
                    aria-label={`Model ${index + 1}`}
                    value={row.model}
                    placeholder="gpt-brand-new"
                    disabled={readOnly}
                    onChange={(event) => setRow(index, { model: event.target.value })}
                  />
                  <Input
                    aria-label={`Input price ${index + 1}`}
                    inputMode="decimal"
                    value={row.input}
                    placeholder="1.25"
                    disabled={readOnly}
                    onChange={(event) => setRow(index, { input: event.target.value })}
                  />
                  <Input
                    aria-label={`Output price ${index + 1}`}
                    inputMode="decimal"
                    value={row.output}
                    placeholder="10"
                    disabled={readOnly}
                    onChange={(event) => setRow(index, { output: event.target.value })}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove pricing row ${index + 1}`}
                    disabled={readOnly}
                    onClick={() =>
                      setDrafts((current) => current.filter((_row, position) => position !== index))
                    }
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
            </>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={readOnly}
            onClick={() => setDrafts((current) => [...current, { model: "", input: "", output: "" }])}
          >
            <Plus className="size-4" />
            Add model
          </Button>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <GuardedButton disabled={updateProvider.isPending} onClick={() => void submit()}>
            {updateProvider.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Save pricing
          </GuardedButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
