import { useEffect, useRef, useState } from "react";
import { AlertCircle, CircleCheck, Info, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
  SelectSeparator,
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
import { EmptyState, Field, PageHeader } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { GuardedButton } from "@/components/guarded-button";
import { ApiError } from "@/lib/api";
import { useConsoleSession } from "@/lib/console-session";
import {
  CREATABLE_GATEWAY_TYPES,
  GATEWAY_TYPE_LABELS,
  PROVIDERS,
  PROVIDER_LABELS,
  type CreatableGatewayType,
  type Provider,
} from "@/lib/config-types";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  useCreateProvider,
  useCreateProviderGateway,
  useDeleteProvider,
  useDeleteProviderGateway,
  useProviderGateways,
  useProviders,
  useRenameProviderGateway,
  useRotateProviderGateway,
  useTestProvider,
  useUpdateProvider,
} from "@/lib/queries";
import type {
  ProviderCredential,
  ProviderGateway,
  ProviderPricing,
  ProviderTestResult,
} from "@/lib/types";

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
 * What identifies a gateway connection, which is per type: Cloudflare's is the
 * account and gateway pair, and a gateway with no configuration of its own has
 * only its type to show.
 */
function gatewayIdentity(gateway: ProviderGateway): string {
  return gateway.type === "cf_aig"
    ? `${gateway.config.accountId} · ${gateway.config.gatewayId}`
    : GATEWAY_TYPE_LABELS[gateway.type];
}

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

  const [adding, setAdding] = useState(false);
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
      <PageHeader
        title="Providers"
        description="Set up the AI providers your apps use. API keys are encrypted and can never be read again."
        action={
          <GuardedButton size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-4" />
            New provider
          </GuardedButton>
        }
      />

      {list.isError ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Could not load providers</AlertTitle>
          <AlertDescription>{errorMessage(list.error, "Unknown error")}</AlertDescription>
        </Alert>
      ) : null}

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

      <AddProviderDialog
        open={adding}
        onOpenChange={setAdding}
        providers={providers}
        gateways={gateways}
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

/** The gateway select's sentinel value, which opens the gateway modal instead. */
const NEW_GATEWAY = "__new__";

/**
 * What a dry run of a credential can say. "Unconfirmed" is its own answer, not
 * a failure: a provider outage, or a provider with no probe of its own, proves
 * nothing about a key the operator may well know is right.
 */
type TestOutcome =
  | { status: "works" }
  | { status: "unconfirmed"; message: string }
  | { status: "failed"; message: string };

const TEST_STYLES = {
  works: {
    icon: CircleCheck,
    className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  },
  unconfirmed: { icon: Info, className: "bg-muted text-muted-foreground" },
  failed: { icon: AlertCircle, className: "bg-destructive/10 text-destructive" },
} as const;

/**
 * A refusal the operator can act on, as opposed to a check that could not be
 * made. 5xx and 429 are the upstream having a moment and say nothing about the
 * credential; every other status means something rejected the request.
 */
function isRefusal(result: ProviderTestResult): boolean {
  return (
    result.reason === "unexpected_status"
    && result.status !== undefined
    && result.status < 500
    && result.status !== 429
  );
}

/**
 * Says what stopped the check rather than that it was inconclusive.
 *
 * A gateway that holds no key for this provider, or a wrong gateway id, answers
 * with a status of its own — naming it is the difference between an operator
 * knowing where to look and being told nothing at all.
 */
function testMessage(result: ProviderTestResult, type: Provider, viaGateway: boolean): string {
  const label = PROVIDER_LABELS[type];
  const responder = viaGateway ? "The gateway" : label;
  switch (result.reason) {
    case "no_probe":
      return `There is no test call for ${label}, so nothing was checked. Add it if you know it is right.`;
    case "unreachable":
      return `${responder} did not answer in time, so nothing is proven either way.`;
    case "unexpected_status":
      if (!isRefusal(result)) {
        return `${responder} answered with HTTP ${result.status}, so nothing is proven either way.`;
      }
      return viaGateway
        ? `The gateway answered with HTTP ${result.status}. Check that it holds a stored key for ${label}.`
        : `${label} answered with HTTP ${result.status}, so this key could not be used.`;
    default:
      return "Nothing is proven either way. Add it if you know it is right.";
  }
}

/** The verdict, with a refusal shown as the error it is. */
function testOutcome(
  result: ProviderTestResult,
  type: Provider,
  viaGateway: boolean,
): TestOutcome {
  if (result.validated) return { status: "works" };
  const message = testMessage(result, type, viaGateway);
  return isRefusal(result) ? { status: "failed", message } : { status: "unconfirmed", message };
}

function TestResult({ outcome }: { outcome: TestOutcome }) {
  const { icon: Icon, className } = TEST_STYLES[outcome.status];
  return (
    <p
      // The operator pressed a button and is waiting for this line to appear.
      aria-live="polite"
      className={cn("flex items-start gap-2 rounded-md px-3 py-2 text-xs", className)}
    >
      <Icon className="mt-px size-3.5 shrink-0" />
      {outcome.status === "works"
        ? "Works. The provider accepted this credential."
        : outcome.message}
    </p>
  );
}

/**
 * The whole add-provider flow, from the first field to the created row.
 *
 * The connection choice decides what the row carries: its own API key, or a
 * reference to a gateway whose token authenticates it. Choosing a gateway that
 * does not exist yet opens the gateway modal on top of this one, so the
 * provider being described is never thrown away to go and create it.
 */
function AddProviderDialog({
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
  const defaultSlugTaken = (candidate: Provider) =>
    providers.some((row) => row.status === "active" && row.slug === candidate);
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

  /**
   * Optional, and deliberately not a gate on adding the provider: a probe that
   * proves nothing must not stand between an operator and a key they trust.
   */
  const test = async () => {
    if (!credentialReady) return;
    setTested(null);
    try {
      const result = await testProvider.mutateAsync({
        type,
        ...(connection === "key" ? { secret } : { providerGatewayId: gatewayId }),
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
        ...(connection === "key" ? { secret } : { providerGatewayId: gatewayId }),
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
                    {PROVIDER_LABELS[entry]}
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
                setTested(null);
              }}
            >
              <SelectTrigger id="provider-authentication" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="key">API key</SelectItem>
                <SelectItem value="gateway">Use gateway</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {connection === "key" ? (
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
                      {entry.name}
                    </SelectItem>
                  ))}
                  {/* Last, behind a rule, in the accent colour and led by a
                      plus: everything above is a gateway to pick, this one is
                      an action that opens a form. The ellipsis says so too. */}
                  {active.length ? <SelectSeparator /> : null}
                  <SelectItem
                    value={NEW_GATEWAY}
                    className="font-medium text-primary focus:text-primary"
                  >
                    <Plus className="size-4 text-primary" />
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
      {/* The console's other section headers sit inside cards, where a smaller
          description is right. This one is a section of the page itself, under
          the page header, so its description is set like the page's own. */}
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-3">
        <div className="min-w-0 flex-1 basis-80 space-y-1">
          <h2 className="text-sm font-semibold">Gateways</h2>
          <p className="text-sm text-muted-foreground">
            Set up the gateways you use to reach AI providers.
          </p>
        </div>
        <GuardedButton size="sm" onClick={() => setAdding(true)}>
          <Plus className="size-4" />
          Add gateway
        </GuardedButton>
      </div>

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
                    {gatewayIdentity(row)}
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
 * the add-provider modal or from the gateways section.
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
  // The list is what makes a second gateway type a data change: the selector
  // below appears only once there is something to select, so today's form is
  // exactly the Cloudflare one it has always been.
  const [type, setType] = useState<CreatableGatewayType>(CREATABLE_GATEWAY_TYPES[0].value);
  const gatewayType = CREATABLE_GATEWAY_TYPES.find((entry) => entry.value === type)
    ?? CREATABLE_GATEWAY_TYPES[0];
  const [name, setName] = useState<string>(gatewayType.defaultName);
  const [accountId, setAccountId] = useState("");
  const [gatewayId, setGatewayId] = useState("");
  const [token, setToken] = useState("");

  const ready = Boolean(name.trim() && accountId.trim() && gatewayId.trim() && token);

  const clear = () => {
    setType(CREATABLE_GATEWAY_TYPES[0].value);
    setName(CREATABLE_GATEWAY_TYPES[0].defaultName);
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
        type: gatewayType.value,
        name: name.trim(),
        accountId: accountId.trim(),
        gatewayId: gatewayId.trim(),
        token,
      });
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
    >
      <div className="space-y-4">
        {CREATABLE_GATEWAY_TYPES.length > 1 ? (
          <Field label="Gateway type" htmlFor="gateway-type">
            <select
              id="gateway-type"
              className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
              value={type}
              onChange={(event) => setType(event.target.value as CreatableGatewayType)}
            >
              {CREATABLE_GATEWAY_TYPES.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </select>
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
        <Field label="Cloudflare Account ID" htmlFor="gateway-account">
          <Input
            id="gateway-account"
            {...PLAIN_FIELD}
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
          />
        </Field>
        <Field label="Cloudflare Gateway ID" htmlFor="gateway-gateway">
          <Input
            id="gateway-gateway"
            {...PLAIN_FIELD}
            value={gatewayId}
            onChange={(event) => setGatewayId(event.target.value)}
          />
        </Field>
        <Field
          label="Gateway token"
          htmlFor="gateway-token"
          hint={
            <a
              className="underline underline-offset-4"
              href={gatewayType.tokenDocsUrl}
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
            onChange={(event) => setToken(event.target.value)}
          />
        </Field>
      </div>
    </FormDialog>
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
      await rotateGateway.mutateAsync({ id: gateway.id, token });
      setToken("");
      rotateGateway.reset();
      toast.success(`Rotated ${gateway.name}`);
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
      await updateProvider.mutateAsync({ id: provider.id, body: { secret } });
      setSecret("");
      updateProvider.reset();
      toast.success(`Rotated ${provider.name}`);
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
