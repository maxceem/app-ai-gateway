import { useState } from "react";
import { AlertCircle, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState, Field } from "@/components/field";
import { GuardedButton } from "@/components/guarded-button";
import { useConsoleSession } from "@/lib/console-session";
import { PROVIDERS, PROVIDER_LABELS, type Provider } from "@/lib/config-types";
import { formatDateTime } from "@/lib/format";
import {
  useCreateCfAigPreset,
  useCreateProvider,
  useDeleteProvider,
  useProviders,
  useUpdateProvider,
} from "@/lib/queries";
import type { ProviderCredential, ProviderPricing } from "@/lib/types";

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

function routedVia(row: ProviderCredential): string {
  if (row.gateway !== "cf_aig") return "Direct";
  const config = row.gatewayConfig;
  return config ? `Cloudflare AI Gateway · ${config.gatewayId}` : "Cloudflare AI Gateway";
}

export function ProvidersPage() {
  const { readOnly } = useConsoleSession();
  const list = useProviders();
  const deleteProvider = useDeleteProvider();

  const [editing, setEditing] = useState<ProviderCredential | null>(null);
  const [rotating, setRotating] = useState<ProviderCredential | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProviderCredential | null>(null);

  const providers = list.data?.providers ?? [];

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
          <Tabs defaultValue="key">
            <TabsList>
              <TabsTrigger value="key">Add a provider key</TabsTrigger>
              <TabsTrigger value="cf-aig">Connect Cloudflare AI Gateway</TabsTrigger>
            </TabsList>
            <TabsContent value="key" className="pt-4">
              <AddProviderForm readOnly={readOnly} />
            </TabsContent>
            <TabsContent value="cf-aig" className="pt-4">
              <ConnectCfAigForm readOnly={readOnly} />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <Card className="overflow-hidden py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Provider</TableHead>
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
                  <TableCell colSpan={7}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : providers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                  No providers yet. Add a key per provider, or connect your Cloudflare AI Gateway.
                </TableCell>
              </TableRow>
            ) : (
              providers.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <Badge variant="secondary">{PROVIDER_LABELS[row.type]}</Badge>
                  </TableCell>
                  <TableCell className="font-medium">{row.name}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    …{row.secretHint}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{routedVia(row)}</TableCell>
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
                    <GuardedButton variant="outline" size="sm" onClick={() => setRotating(row)}>
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

function AddProviderForm({ readOnly }: { readOnly: boolean }) {
  const createProvider = useCreateProvider();
  const [type, setType] = useState<Provider>("openai");
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");

  const submit = async () => {
    if (!name.trim() || !secret) return;
    try {
      const result = await createProvider.mutateAsync({ type, name: name.trim(), secret });
      // The plaintext leaves component state and the mutation cache immediately;
      // the server never returns it again.
      setSecret("");
      setName("");
      createProvider.reset();
      toast.success(`Added ${PROVIDER_LABELS[type]}`, {
        description: validationNotice(result.validated),
      });
    } catch (error) {
      setSecret("");
      toast.error(errorMessage(error, "Could not store the credential"));
    }
  };

  return (
    <form
      className="grid gap-4 sm:grid-cols-3"
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Field label="Provider" htmlFor="provider-type">
        <Select value={type} onValueChange={(next) => setType(next as Provider)}>
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
      <div className="sm:col-span-3">
        <GuardedButton type="submit" disabled={!name.trim() || !secret || createProvider.isPending}>
          {createProvider.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
          Add provider
        </GuardedButton>
      </div>
    </form>
  );
}

function ConnectCfAigForm({ readOnly }: { readOnly: boolean }) {
  const createPreset = useCreateCfAigPreset();
  const [accountId, setAccountId] = useState("");
  const [gatewayId, setGatewayId] = useState("");
  const [token, setToken] = useState("");
  const [name, setName] = useState("Via our CF gateway");
  const [types, setTypes] = useState<Provider[]>([]);

  const toggle = (entry: Provider, checked: boolean) => {
    setTypes((current) =>
      checked ? [...current, entry] : current.filter((value) => value !== entry),
    );
  };

  const ready = accountId.trim() && gatewayId.trim() && token && name.trim() && types.length > 0;

  const submit = async () => {
    if (!ready) return;
    try {
      const result = await createPreset.mutateAsync({
        accountId: accountId.trim(),
        gatewayId: gatewayId.trim(),
        token,
        types,
        name: name.trim(),
      });
      setToken("");
      setTypes([]);
      createPreset.reset();
      const conflicts = result.conflicts.length
        ? `Already configured: ${result.conflicts.map((entry) => PROVIDER_LABELS[entry]).join(", ")}.`
        : undefined;
      toast.success(`Connected ${result.providers.length} providers`, {
        description: [conflicts, validationNotice(result.validated)].filter(Boolean).join(" "),
      });
    } catch (error) {
      setToken("");
      toast.error(errorMessage(error, "Could not connect the gateway"));
    }
  };

  return (
    <form
      className="space-y-4"
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p className="text-sm text-muted-foreground">
        Routes the selected providers through your own Cloudflare AI Gateway instead of calling them
        directly. The provider keys themselves must already be in that gateway&rsquo;s stored-keys
        (BYOK) store — this gateway only sends the authentication token.{" "}
        <a
          className="underline underline-offset-4"
          href="https://developers.cloudflare.com/ai-gateway/configuration/authentication/"
          target="_blank"
          rel="noreferrer"
        >
          How to create the token
        </a>
        .
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Account ID" htmlFor="cf-aig-account">
          <Input
            id="cf-aig-account"
            {...PLAIN_FIELD}
            value={accountId}
            disabled={readOnly}
            onChange={(event) => setAccountId(event.target.value)}
          />
        </Field>
        <Field label="Gateway ID" htmlFor="cf-aig-gateway">
          <Input
            id="cf-aig-gateway"
            {...PLAIN_FIELD}
            value={gatewayId}
            disabled={readOnly}
            onChange={(event) => setGatewayId(event.target.value)}
          />
        </Field>
        <Field label="Gateway token" htmlFor="cf-aig-token">
          <Input
            id="cf-aig-token"
            {...SECRET_FIELD}
            value={token}
            disabled={readOnly}
            onChange={(event) => setToken(event.target.value)}
          />
        </Field>
        <Field label="Name" htmlFor="cf-aig-name">
          <Input
            id="cf-aig-name"
            {...PLAIN_FIELD}
            value={name}
            disabled={readOnly}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Providers to route</legend>
        <div className="flex flex-wrap gap-4">
          {PROVIDERS.map((entry) => (
            <Label key={entry} className="flex items-center gap-2 text-sm font-normal">
              <Checkbox
                checked={types.includes(entry)}
                disabled={readOnly}
                onCheckedChange={(checked) => toggle(entry, checked === true)}
              />
              {PROVIDER_LABELS[entry]}
            </Label>
          ))}
        </div>
      </fieldset>
      <GuardedButton type="submit" disabled={!ready || createPreset.isPending}>
        {createPreset.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
        Connect gateway
      </GuardedButton>
    </form>
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
