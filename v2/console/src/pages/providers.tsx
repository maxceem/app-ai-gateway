import { useEffect, useRef, useState } from "react";
import { AlertCircle, Ban, CheckCircle2, Cloud, DollarSign, Globe, KeyRound, ListTree, Pencil, Plus, Power, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Field, PageHeader } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { GuardedButton } from "@/components/guarded-button";
import { RelativeTime } from "@/components/relative-time";
import { RowAction, RowActions } from "@/components/row-actions";
import { cloudflareCapable, keyDestinationText, PROVIDER_TYPES, providerLabel, suggestedPath } from "@/lib/providers";
import { cloudflareIdProblem, normalizedBaseUrl } from "@providers/destinations";
import { ApiError } from "@/lib/api";
import { useCreateProvider, useDeleteProvider, useFreshProvider, useProviders, useTestProvider, useUpdateProvider } from "@/lib/queries";
import { emptyRow, formCanShow, hiddenFields, jsonPriceProblem, pricingOf, rowProblems, rowsOf, severalUnits, TOKEN_FIELDS, UNIT_FIELDS, type PriceRow } from "@/lib/pricing-form";
import type { ProviderConnection, ProviderTestResult } from "@/lib/types";
import { parsePathLines, pathLine } from "@contracts/path-lines";

/**
 * Provider connections: one provider's key, saved once and used by every app
 * that names the connection. The key is write-only: the gateway never sends
 * it back, only its last characters.
 */
export function ProvidersPage() {
  const list = useProviders();
  const update = useUpdateProvider();
  const remove = useDeleteProvider();
  const [adding, setAdding] = useState(false);
  // By id, so the dialog always saves at the revision the list last read.
  const [rotatingId, setRotatingId] = useState<string | null>(null);
  const rotating = list.data?.providers.find((provider) => provider.id === rotatingId) ?? null;
  // A connection removed elsewhere ends the replace, so its draft never moves
  // to the next connection.
  useEffect(() => {
    if (rotatingId !== null && list.data && rotating === null) setRotatingId(null);
  }, [rotatingId, list.data, rotating]);
  // By id too, for the same reason.
  const [cloudflareId, setCloudflareId] = useState<string | null>(null);
  const routing = list.data?.providers.find((provider) => provider.id === cloudflareId) ?? null;
  useEffect(() => {
    if (cloudflareId !== null && list.data && routing === null) setCloudflareId(null);
  }, [cloudflareId, list.data, routing]);
  const [removing, setRemoving] = useState<ProviderConnection | null>(null);
  // By id too, for the same reason.
  const [pathsId, setPathsId] = useState<string | null>(null);
  const listing = list.data?.providers.find((provider) => provider.id === pathsId) ?? null;
  const [pricesId, setPricesId] = useState<string | null>(null);
  const pricing = list.data?.providers.find((provider) => provider.id === pricesId) ?? null;
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const renaming = list.data?.providers.find((provider) => provider.id === renamingId) ?? null;
  const [hostId, setHostId] = useState<string | null>(null);
  const hosting = list.data?.providers.find((provider) => provider.id === hostId) ?? null;
  useEffect(() => {
    if (pathsId !== null && list.data && listing === null) setPathsId(null);
  }, [pathsId, list.data, listing]);

  const providers = list.data?.providers ?? [];

  const toggle = async (provider: ProviderConnection) => {
    const status = provider.status === "active" ? "disabled" : "active";
    try {
      await update.mutateAsync({ id: provider.id, body: { revision: provider.revision, status } });
      toast.success(status === "active" ? "Connection turned on" : "Connection turned off");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not change the connection");
    }
  };

  const confirmRemove = async () => {
    if (!removing) return;
    try {
      await remove.mutateAsync(removing.id);
      toast.success("Connection removed");
      setRemoving(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove the connection");
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Providers"
        description="Your keys for AI providers. Apps call a provider through one of these connections."
        action={
          <GuardedButton size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-4" />
            Add provider
          </GuardedButton>
        }
      />

      {list.isError ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Could not load providers</AlertTitle>
          <AlertDescription>{list.error instanceof Error ? list.error.message : "Unknown error"}</AlertDescription>
        </Alert>
      ) : null}

      <Card className="overflow-hidden py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead>Slug</TableHead>
              <TableHead>Key</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Updated</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.isPending ? (
              [0, 1].map((row) => (
                <TableRow key={row}>
                  <TableCell colSpan={7}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : providers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                  No providers yet. Add one to let your apps call it.
                </TableCell>
              </TableRow>
            ) : (
              providers.map((provider) => (
                <TableRow key={provider.id}>
                  <TableCell className="font-medium">{provider.name}</TableCell>
                  <TableCell>{providerLabel(provider.type)}</TableCell>
                  <TableCell className="font-mono text-xs">{provider.slug}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {provider.secretHint ? `…${provider.secretHint}` : "—"}
                    {provider.cloudflareGateway ? <div className="font-sans">via Cloudflare AI Gateway</div> : null}
                  </TableCell>
                  <TableCell>{provider.status === "active" ? "On" : <span className="text-muted-foreground">Off</span>}</TableCell>
                  <TableCell className="text-muted-foreground">
                    <RelativeTime value={provider.updatedAt} />
                  </TableCell>
                  <TableCell className="text-right">
                    <RowActions label={provider.name}>
                      <RowAction onSelect={() => setRenamingId(provider.id)}>
                        <Pencil />
                        Rename
                      </RowAction>
                      <RowAction onSelect={() => setRotatingId(provider.id)}>
                        <KeyRound />
                        Replace key
                      </RowAction>
                      <RowAction onSelect={() => setPathsId(provider.id)}>
                        <ListTree />
                        {provider.type === "custom" ? "Paths" : "Passthrough paths"}
                      </RowAction>
                      <RowAction onSelect={() => setPricesId(provider.id)}>
                        <DollarSign />
                        Your prices
                      </RowAction>
                      {provider.type !== "custom" && !provider.cloudflareGateway ? (
                        <RowAction onSelect={() => setHostId(provider.id)}>
                          <Globe />
                          Host
                        </RowAction>
                      ) : null}
                      {cloudflareCapable(provider.type) ? (
                        <RowAction onSelect={() => setCloudflareId(provider.id)}>
                          <Cloud />
                          Cloudflare AI Gateway
                        </RowAction>
                      ) : null}
                      <RowAction onSelect={() => void toggle(provider)}>
                        {provider.status === "active" ? <Ban /> : <Power />}
                        {provider.status === "active" ? "Turn off" : "Turn on"}
                      </RowAction>
                      <RowAction destructive onSelect={() => setRemoving(provider)}>
                        <Trash2 />
                        Remove
                      </RowAction>
                    </RowActions>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      <AddProviderDialog open={adding} onOpenChange={setAdding} />
      {/* Keyed by connection, so each replace starts with an empty draft. */}
      <ReplaceKeyDialog key={rotatingId ?? "none"} provider={rotating} onClose={() => setRotatingId(null)} />
      <CloudflareDialog key={`cf-${cloudflareId ?? "none"}`} provider={routing} onClose={() => setCloudflareId(null)} />
      <PathsDialog key={`paths-${pathsId ?? "none"}`} provider={listing} onClose={() => setPathsId(null)} />
      <PricesDialog key={`prices-${pricesId ?? "none"}`} provider={pricing} onClose={() => setPricesId(null)} />
      <RenameDialog key={`rename-${renamingId ?? "none"}`} provider={renaming} onClose={() => setRenamingId(null)} />
      <HostDialog key={`host-${hostId ?? "none"}`} provider={hosting} onClose={() => setHostId(null)} />

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title="Remove provider"
        description={
          <p>
            Apps that name <span className="font-medium text-foreground">{removing?.slug}</span> stop reaching
            this provider at once. Their settings keep the name, so adding a connection with the same slug brings
            them back.
          </p>
        }
        confirmLabel="Remove"
        destructive
        pending={remove.isPending}
        onConfirm={() => void confirmRemove()}
      />
    </div>
  );
}

/**
 * What a key test found, in words. Only `rejected` suggests the key is wrong;
 * anything else proves nothing either way and never stops a save.
 */
export function testResultText(result: ProviderTestResult): { ok: boolean; text: string } {
  if (result.validated) return { ok: true, text: "The provider accepted this key." };
  switch (result.reason) {
    case "rejected":
      return { ok: false, text: "The provider refused this key. Check it, unless it is restricted so it cannot list models." };
    case "no_probe":
      return { ok: true, text: "This provider has no free call to test a key with. You can still save it." };
    case "unreachable":
      return { ok: true, text: "The provider did not answer in time, so the key is not proven. You can still save it." };
    default:
      return {
        ok: true,
        text: `The provider answered ${result.status ?? "unexpectedly"}, which proves nothing either way. You can still save it.`,
      };
  }
}

/** A test's answer, or `failed` when the test itself could not run. */
type TestOutcome = ProviderTestResult | "failed" | null;

function TestResult({ result }: { result: TestOutcome }) {
  if (!result) return null;
  if (result === "failed") {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        The key could not be tested just now. You can still save it.
      </p>
    );
  }
  const { ok, text } = testResultText(result);
  return (
    <p role="status" className={ok ? "flex items-start gap-1.5 text-sm text-muted-foreground" : "text-sm text-destructive"}>
      {result.validated ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : null}
      {text}
    </p>
  );
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/u;

/**
 * Runs a key test and keeps only its answer: the mutation, which holds the
 * key, is reset as soon as it settles.
 */
function useKeyTest() {
  const test = useTestProvider();
  const [result, setResult] = useState<TestOutcome>(null);
  // Each run and each clear starts a new generation, so an answer that comes
  // back after the key was edited or the dialog closed is dropped.
  const generation = useRef(0);
  const run = (body: {
    type: string;
    secret?: string;
    baseUrl?: string;
    cloudflareGateway?: Required<CloudflareBody>;
    auth?: { header: string; format: string };
  }) => {
    const mine = ++generation.current;
    setResult(null);
    const keep = (outcome: TestOutcome) => {
      if (generation.current === mine) setResult(outcome);
    };
    test
      .mutateAsync(body)
      .then(keep, () => keep("failed"))
      .finally(() => test.reset());
  };
  const clear = () => {
    generation.current += 1;
    setResult(null);
  };
  return { run, result, pending: test.isPending, clear };
}

/** A Cloudflare AI Gateway setting as a form holds it (D13). */
interface CloudflareDraft {
  on: boolean;
  accountId: string;
  gatewayId: string;
  token: string;
}

type CloudflareBody = { accountId: string; gatewayId: string; token?: string };

const NO_CLOUDFLARE: CloudflareDraft = { on: false, accountId: "", gatewayId: "", token: "" };

/** Complete enough to send: the ids, and a token unless the stored one may be kept. */
/** A connection's stored Cloudflare ids: kept as they are, they are not judged again. */
type StoredIds = { readonly accountId: string; readonly gatewayId: string } | null;

function cloudflareReady(draft: CloudflareDraft, tokenOptional: boolean, stored: StoredIds = null): boolean {
  return (
    !draft.on ||
    (draft.accountId.trim() !== "" &&
      draft.gatewayId.trim() !== "" &&
      idProblem(draft.accountId, stored?.accountId) === null &&
      idProblem(draft.gatewayId, stored?.gatewayId) === null &&
      (tokenOptional || draft.token !== ""))
  );
}

/** Why a typed Cloudflare id cannot be saved, by the gateway's own rule, said beside the field; null while it is empty or fine. */
function idProblem(text: string, stored?: string): string | null {
  const id = text.trim();
  // An older connection's id, kept as stored, keeps saving: the gateway judges only a new or changed one.
  if (id === "" || id === stored) return null;
  const problem = cloudflareIdProblem(id);
  return problem === null ? null : `This ID ${problem}.`;
}

function cloudflareBody(draft: CloudflareDraft): CloudflareBody {
  return { accountId: draft.accountId.trim(), gatewayId: draft.gatewayId.trim(), ...(draft.token ? { token: draft.token } : {}) };
}

function CloudflareFields({
  draft,
  onChange,
  tokenOptional = false,
  stored = null,
}: {
  draft: CloudflareDraft;
  onChange: (draft: CloudflareDraft) => void;
  tokenOptional?: boolean;
  stored?: StoredIds;
}) {
  return (
    <>
      <label className="flex items-center gap-2 text-sm font-medium">
        <Checkbox checked={draft.on} onCheckedChange={(checked) => onChange({ ...draft, on: checked === true, token: "" })} />
        Send through Cloudflare AI Gateway
      </label>
      {draft.on ? (
        <>
          <Field label="Cloudflare account ID" htmlFor="cloudflare-account">
            <Input
              id="cloudflare-account"
              value={draft.accountId}
              autoComplete="off"
              // The token belongs to the account and gateway it was typed for.
              onChange={(event) => onChange({ ...draft, accountId: event.target.value, token: "" })}
            />
            {idProblem(draft.accountId, stored?.accountId) === null ? null : <p className="text-sm text-destructive">{idProblem(draft.accountId, stored?.accountId)}</p>}
          </Field>
          <Field label="Cloudflare gateway ID" htmlFor="cloudflare-gateway">
            <Input
              id="cloudflare-gateway"
              value={draft.gatewayId}
              autoComplete="off"
              onChange={(event) => onChange({ ...draft, gatewayId: event.target.value, token: "" })}
            />
            {idProblem(draft.gatewayId, stored?.gatewayId) === null ? null : <p className="text-sm text-destructive">{idProblem(draft.gatewayId, stored?.gatewayId)}</p>}
          </Field>
          <Field
            label="Cloudflare token"
            htmlFor="cloudflare-token"
            hint={
              tokenOptional
                ? "Leave it empty to keep the stored token. A new account or gateway needs its token."
                : "Stored encrypted. It is never shown again, only its last characters."
            }
          >
            <Input
              id="cloudflare-token"
              type="password"
              value={draft.token}
              autoComplete="off"
              onChange={(event) => onChange({ ...draft, token: event.target.value })}
            />
          </Field>
        </>
      ) : null}
    </>
  );
}

function AddProviderDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const create = useCreateProvider();
  const test = useKeyTest();
  const [type, setType] = useState(PROVIDER_TYPES[0]?.type ?? "");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [cloudflare, setCloudflare] = useState<CloudflareDraft>(NO_CLOUDFLARE);
  const [custom, setCustom] = useState<CustomDraft>(NO_CUSTOM);
  const [host, setHost] = useState("");
  const slugInvalid = slug !== "" && !SLUG.test(slug);
  const isCustom = type === "custom";
  // Through Cloudflare, the key is optional: Cloudflare can use the keys it stores.
  const viaCloudflare = cloudflareCapable(type) && cloudflare.on;
  // The base URL is judged only on the route that uses it.
  const hostChecked = !isCustom && !viaCloudflare ? checkedHost(host) : null;
  const hostProblem = hostChecked !== null && !hostChecked.ok ? hostChecked.message : null;
  // Every host the key would be sent to, as the gateway routes it once it has saved the base URL. A key is kept only for these.
  const customChecked = isCustom ? checkedHost(custom.baseUrl) : null;
  const savedBase = (checked: ReturnType<typeof checkedHost>) => (checked !== null && checked.ok ? checked.baseUrl : null);
  const destinations = keyDestinationText(type, {
    baseUrl: isCustom ? savedBase(customChecked) : savedBase(hostChecked),
    cloudflareGateway: viaCloudflare ? { accountId: cloudflare.accountId.trim(), gatewayId: cloudflare.gatewayId.trim() } : null,
  });
  const [secret, setSecret] = useBoundSecret(JSON.stringify([type, destinations, isCustom ? [custom.header.trim().toLowerCase(), custom.format] : null]));
  // Through Cloudflare, the destination is named only once both ids say which gateway it is.
  const gatewayNamed = !viaCloudflare || (cloudflare.accountId.trim() !== "" && cloudflare.gatewayId.trim() !== "");
  const sentTo = destinations === "" || !gatewayNamed ? "" : ` Sent only to ${destinations}.`;

  const reset = () => {
    setHost("");
    setName("");
    setSlug("");
    setSecret("");
    setCloudflare(NO_CLOUDFLARE);
    setCustom(NO_CUSTOM);
    test.clear();
  };
  const ready = cloudflareReady(cloudflare, false) && (secret !== "" || viaCloudflare) && (!isCustom || customReady(custom)) && hostProblem === null;
  // A new setting always carries its token.
  const route = viaCloudflare
    ? { cloudflareGateway: { accountId: cloudflare.accountId.trim(), gatewayId: cloudflare.gatewayId.trim(), token: cloudflare.token } }
    : isCustom
      ? { baseUrl: custom.baseUrl.trim(), auth: { header: custom.header.trim().toLowerCase(), format: custom.format } }
      : host.trim() !== ""
        ? { baseUrl: host.trim() }
        : {};

  const submit = async () => {
    try {
      await create.mutateAsync({ type, name: name.trim(), ...(secret ? { secret } : {}), ...(slug ? { slug } : {}), ...route });
      toast.success("Provider added");
      reset();
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not add the provider");
    } finally {
      create.reset();
    }
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
      title="Add a provider"
      submitLabel="Add provider"
      pending={create.isPending}
      disabled={!type || !name.trim() || !ready || slugInvalid}
      onSubmit={() => void submit()}
    >
      <Field label="Provider" htmlFor="provider-type">
        <Select
          value={type}
          onValueChange={(value) => {
            setType(value);
            setCloudflare(NO_CLOUDFLARE);
            setCustom(NO_CUSTOM);
            setHost("");
            test.clear();
          }}
        >
          <SelectTrigger id="provider-type" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROVIDER_TYPES.map((entry) => (
              <SelectItem key={entry.type} value={entry.type}>
                {entry.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label="Name" htmlFor="provider-name" hint="Name it so you can tell connections apart.">
        <Input id="provider-name" value={name} maxLength={100} autoComplete="off" onChange={(event) => setName(event.target.value)} />
      </Field>
      <Field
        label="Slug"
        htmlFor="provider-slug"
        hint="How apps name this connection in their requests. Leave it empty to use the provider's own name."
      >
        <Input
          id="provider-slug"
          value={slug}
          placeholder={type}
          autoComplete="off"
          aria-invalid={slugInvalid || undefined}
          onChange={(event) => setSlug(event.target.value)}
        />
        {slugInvalid ? <p className="text-sm text-destructive">Use lowercase letters, digits and dashes.</p> : null}
      </Field>
      {cloudflareCapable(type) ? (
        <CloudflareFields
          draft={cloudflare}
          onChange={(next) => {
            setCloudflare(next);
            test.clear();
          }}
        />
      ) : null}
      {!isCustom && !viaCloudflare ? (
        <HostField
          id="provider-host"
          value={host}
          problem={hostProblem}
          onChange={(next) => {
            setHost(next);
            test.clear();
          }}
        />
      ) : null}
      {isCustom ? (
        <CustomFields
          draft={custom}
          onChange={(next) => {
            setCustom(next);
            test.clear();
          }}
        />
      ) : null}
      <Field
        label="API key"
        htmlFor="provider-secret"
        hint={
          (viaCloudflare
            ? "Optional through Cloudflare: leave it empty to use the keys stored in your Cloudflare AI Gateway. Stored encrypted if given."
            : isCustom
              ? "Stored encrypted, and sent in the header you name. It is never shown again, only its last characters."
              : "Stored encrypted. It is never shown again, only its last characters.") +
          sentTo +
          " Changing where requests go clears it."
        }
      >
        <div className="flex gap-2">
          <Input
            id="provider-secret"
            type="password"
            value={secret}
            autoComplete="off"
            onChange={(event) => {
              setSecret(event.target.value);
              test.clear();
            }}
          />
          <Button
            type="button"
            variant="outline"
            disabled={!ready || test.pending}
            onClick={() => test.run({ type, ...(secret ? { secret } : {}), ...route })}
          >
            Test key
          </Button>
        </div>
      </Field>
      <TestResult result={test.result} />
    </FormDialog>
  );
}

/** A custom provider's base URL and key header, as the add form holds them, and the trust choice. */
interface CustomDraft {
  baseUrl: string;
  header: string;
  format: string;
  trusted: boolean;
}

const NO_CUSTOM: CustomDraft = { baseUrl: "", header: "authorization", format: "Bearer {key}", trusted: false };

/** Complete enough to send: an https base URL, a header, a format with `{key}` once, and the trust choice made. */
function customReady(draft: CustomDraft): boolean {
  return (
    draft.trusted &&
    draft.baseUrl.trim().startsWith("https://") &&
    draft.header.trim() !== "" &&
    draft.format.split("{key}").length === 2
  );
}

/**
 * What passing paths through gives up (plan section 4.5), said where a person
 * makes the choice: listing paths on a provider, or adding a custom one.
 */
export function TrustNotice() {
  return (
    <Alert>
      <AlertCircle />
      <AlertTitle>Paths you list are passed through as they are</AlertTitle>
      <AlertDescription>
        <ul className="list-disc space-y-1 pl-4">
          <li>A path without a price is not priced, so your budgets do not limit it. Request limits still apply.</li>
          <li>
            Ids the provider returns, such as file or job ids, are not tied to the app. Another app with the same provider key
            could read them.
          </li>
          <li>For such paths, use a provider key of their own.</li>
        </ul>
      </AlertDescription>
    </Alert>
  );
}

function CustomFields({ draft, onChange }: { draft: CustomDraft; onChange: (draft: CustomDraft) => void }) {
  return (
    <>
      <Field
        label="Base URL"
        htmlFor="custom-base-url"
        hint="Public https only. The gateway cannot tell where a public name points, so name only a host you trust."
      >
        <Input
          id="custom-base-url"
          value={draft.baseUrl}
          placeholder="https://llm.example.com/v1/"
          autoComplete="off"
          onChange={(event) => onChange({ ...draft, baseUrl: event.target.value })}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Key header" htmlFor="custom-header">
          <Input id="custom-header" value={draft.header} autoComplete="off" onChange={(event) => onChange({ ...draft, header: event.target.value })} />
        </Field>
        <Field label="Key format" htmlFor="custom-format" hint="{key} is where the key goes.">
          <Input id="custom-format" value={draft.format} autoComplete="off" onChange={(event) => onChange({ ...draft, format: event.target.value })} />
        </Field>
      </div>
      <p className="text-sm text-muted-foreground">You list its paths after adding it. Every path it serves is one you list.</p>
      <TrustNotice />
      <label className="flex items-center gap-2 text-sm font-medium">
        <Checkbox checked={draft.trusted} onCheckedChange={(checked) => onChange({ ...draft, trusted: checked === true })} />
        I understand, and want to add this provider
      </label>
    </>
  );
}

type ListedPath = NonNullable<ProviderConnection["passthrough"]>[number];

type FieldSetting = NonNullable<ListedPath["set_fields"]>[number];

// Shared with `agw provider add --path`, so a path line reads the same wherever it is typed.
export { parsePathLines, pathLine };

/**
 * The key a listed path's field settings are kept under while its line is
 * edited: the method and the path, with each named part's name left out, so
 * renaming `{file_id}` to `{id}` keeps the same settings.
 */
export const pathKey = (path: { method: string; path: string }) => `${path.method} ${path.path.replace(/^\/+/u, "").replace(/\{[^}]*\}/gu, "{}")}`;

/** A field setting as a request sends it: without what an answer adds about it. */
function settingOnly({ label: _label, reason: _reason, suggested_value: _suggested, ...setting }: FieldSetting): FieldSetting {
  return setting;
}

/**
 * The paths to save: each line, with its field settings as they stand in
 * the draft. A path the draft has no settings for is sent without any, so a
 * newly listed one gets the provider's safe defaults and a kept one keeps
 * none; an empty list sets none.
 */
export function pathsToSave(paths: readonly ListedPath[], fields: Readonly<Record<string, readonly FieldSetting[]>>): ListedPath[] {
  return paths.map((path) => {
    const set = fields[pathKey(path)];
    return set === undefined ? path : { ...path, set_fields: set.map(settingOnly) };
  });
}

/** What a field's value reads as: JSON, and a time from now in seconds. */
function valueText(field: { value?: unknown; suggested_value?: unknown; as?: string }, value: unknown = field.value): string {
  const text = JSON.stringify(value);
  return field.as === "time_from_now" ? `${text} seconds from sending` : text;
}

/** The key a field's typed text is kept under in the dialog draft. */
const textKey = (path: ListedPath, field: { in: string; name: string }) => `${pathKey(path)}|${field.in}:${field.name}`;

/**
 * The field settings shown for a listed path: its own, or for a newly listed
 * path the provider's safe defaults that saving will write in.
 */
function shownFields(type: string, path: ListedPath, isNew: boolean, fields: readonly FieldSetting[] | undefined): FieldSetting[] {
  const suggested = suggestedPath(type, path.method, path.path);
  return fields !== undefined
      ? [...fields]
      : isNew && suggested !== null
        ? suggested.fields.map((field) => ({
            in: field.in,
            name: field.name,
            value: field.value,
            ...(field.as !== undefined ? { as: field.as } : {}),
            ...(field.aliases !== undefined ? { aliases: [...field.aliases] } : {}),
            label: field.label,
            reason: field.reason,
            suggested_value: field.value,
          }))
        : [];
}

/**
 * A listed path's field settings, and for a newly listed path the provider's
 * safe defaults that saving will write in (plan section 4.5): each with its
 * label, the reason, and its value, which a person can change or remove.
 */
function SafeDefaults({
  type,
  path,
  isNew,
  fields,
  onChange,
  textOf,
  onText,
}: {
  type: string;
  path: ListedPath;
  isNew: boolean;
  fields: readonly FieldSetting[] | undefined;
  onChange: (fields: FieldSetting[]) => void;
  /** A field's text as typed so far, kept in the dialog draft so it survives while a path line is briefly invalid. */
  textOf: (key: string) => string | undefined;
  onText: (key: string, text: string) => void;
}) {
  const shown = shownFields(type, path, isNew, fields);
  if (shown.length === 0) return null;
  return (
    <div className="space-y-2 rounded-md border p-3 text-sm" data-testid="safe-defaults">
      <p className="font-medium">
        Safe defaults · {path.method} {path.path}
      </p>
      {fields === undefined ? <p className="text-muted-foreground">Set when you save. You can change or remove them.</p> : null}
      {shown.map((field, index) => (
        <div key={`${field.in}:${field.name}`} className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span>
              <span className="font-medium">{field.label ?? field.name}</span>{" "}
              <code className="text-xs text-muted-foreground">
                {field.in} {field.name}
              </code>
            </span>
            <Button type="button" variant="ghost" size="sm" onClick={() => onChange(shown.filter((_, other) => other !== index))}>
              Remove
            </Button>
          </div>
          {field.reason !== undefined ? <p className="text-muted-foreground">{field.reason}</p> : null}
          <Input
            aria-label={`Value of ${field.label ?? field.name}`}
            className="font-mono text-xs"
            value={textOf(textKey(path, field)) ?? JSON.stringify(field.value)}
            // The draft follows every keystroke, so pressing Enter saves the value shown, not the last one read on blur.
            onChange={(event) => {
              onText(textKey(path, field), event.target.value);
              let value: unknown;
              try {
                value = JSON.parse(event.target.value) as unknown;
              } catch {
                return;
              }
              onChange(shown.map((other, at) => (at === index ? { ...other, value } : other)));
            }}
          />
          {field.suggested_value !== undefined && JSON.stringify(field.suggested_value) !== JSON.stringify(field.value) ? (
            <p className="text-xs text-muted-foreground">Suggested: {valueText(field, field.suggested_value)}</p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/**
 * What a live-session token path gives up (plan D4), said where a person
 * lists one. The known holes are named, not hidden.
 */
export function LiveTokenNotice() {
  return (
    <Alert>
      <AlertCircle />
      <AlertTitle>Live-session tokens are not metered, not capped</AlertTitle>
      <AlertDescription>
        <ul className="list-disc space-y-1 pl-4">
          <li>A path here mints a short-lived secret. The live call it starts goes straight to the provider, so the gateway cannot count its cost or end it.</li>
          <li>Each mint still needs the app's sign-in and counts toward its request limits.</li>
          <li>Its safe defaults let the secret start a call for 60 seconds only, where the provider lets the request set it.</li>
          <li>ElevenLabs' token carries a link that can start more calls within about 15 minutes.</li>
          <li>One OpenAI client secret can start several calls before it expires.</li>
        </ul>
      </AlertDescription>
    </Alert>
  );
}

/** The field settings a saved list holds, by path. */
function fieldsOf(listed: readonly ListedPath[]): Record<string, FieldSetting[]> {
  return Object.fromEntries(listed.filter((path) => path.set_fields !== undefined).map((path) => [pathKey(path), [...path.set_fields!]]));
}

/**
 * The paths a connection lists. On a built-in provider, listing the first one
 * is a trust choice, made here with what it gives up in view. A custom
 * provider's was made when it was added.
 */
function PathsDialog({ provider, onClose }: { provider: ProviderConnection | null; onClose: () => void }) {
  const update = useUpdateProvider();
  const custom = provider?.type === "custom";
  // The paths the draft was made from, saved at the revision it was opened at (`useOpenedRevision`).
  const [listed, setListed] = useState(provider?.passthrough ?? []);
  const [text, setText] = useState(listed.map(pathLine).join("\n"));
  const [trusted, setTrusted] = useState(false);
  const [fields, setFields] = useState<Record<string, FieldSetting[]>>(() => fieldsOf(listed));
  // Field values as typed so far, by path and field (`textKey`): saving checks the ones still shown.
  const [texts, setTexts] = useState<Record<string, string>>({});
  const opened = useOpenedRevision(
    provider,
    (latest) => {
      const now = latest.passthrough ?? [];
      setListed(now);
      setText(now.map(pathLine).join("\n"));
      setFields(fieldsOf(now));
      setTexts({});
    },
    onClose,
  );
  const parsed = parsePathLines(text, custom);
  // A first listing on a built-in provider needs the choice made; a custom provider made it when added.
  const choosing = !custom && listed.length === 0;
  const paths = "paths" in parsed ? parsed.paths : null;
  const type = provider?.type ?? "";
  const saved = new Set(listed.map(pathKey));
  const anyTokens = paths !== null && paths.some((path) => suggestedPath(type, path.method, path.path)?.liveToken === true);

  const save = async () => {
    if (!provider || paths === null) return;
    const unreadable = paths.some((path) =>
      shownFields(type, path, !saved.has(pathKey(path)), fields[pathKey(path)]).some((field) => {
        const typed = texts[textKey(path, field)];
        if (typed === undefined) return false;
        try {
          JSON.parse(typed);
          return false;
        } catch {
          return true;
        }
      }),
    );
    if (unreadable) {
      toast.error("Write each value as JSON, such as 60 or \"true\".");
      return;
    }
    try {
      await update.mutateAsync({ id: provider.id, body: { revision: opened.revision, passthrough: paths.length === 0 ? null : pathsToSave(paths, fields) } });
      if (!opened.mounted.current) return;
      toast.success(paths.length === 0 ? "No paths listed" : "Paths saved");
      onClose();
    } catch (error) {
      opened.failed(error, "Could not save the paths");
    } finally {
      update.reset();
    }
  };

  return (
    <FormDialog
      open={provider !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={custom ? "Paths" : "Passthrough paths"}
      description={
        custom
          ? "Every path this provider serves. A path with an API style is metered by it, at your prices for its models."
          : "Paths of this provider the gateway does not serve as an operation. Apps reach them once they allow passthrough."
      }
      submitLabel="Save paths"
      pending={update.isPending}
      disabled={opened.conflict || opened.reloading || paths === null || (choosing && paths.length > 0 && !trusted)}
      onSubmit={() => void save()}
    >
      {opened.conflict ? (
        <ConflictNotice
          reloading={opened.reloading}
          onReload={() => void opened.reload()}
          title="These paths changed since you opened them"
          body="Someone else saved this provider. Reload to see their paths, then make your change again."
          label="Reload paths"
        />
      ) : null}
      <Field
        label="One path per line"
        htmlFor="listed-paths"
        hint={
          custom
            ? "Method and path, then a price such as $0.002, or an API style such as openai-chat. {name} stands for an id, after two fixed parts, such as v1/files/{file_id}."
            : "Method and path, then a price such as $0.002 if you want one. {name} stands for an id, after the API version and an endpoint's name, such as v1/files/{file_id}."
        }
      >
        <Textarea
          id="listed-paths"
          rows={6}
          className="font-mono text-xs"
          value={text}
          placeholder={custom ? "POST chat/completions openai-chat\nGET models" : "GET v1/files/{file_id} $0.001"}
          onChange={(event) => setText(event.target.value)}
        />
      </Field>
      {"problem" in parsed ? (
        <p role="alert" className="text-sm text-destructive">
          {parsed.problem}
        </p>
      ) : null}
      <TrustNotice />
      {choosing ? (
        <label className="flex items-center gap-2 text-sm font-medium">
          <Checkbox checked={trusted} onCheckedChange={(checked) => setTrusted(checked === true)} />
          I understand, and want these paths passed through
        </label>
      ) : null}
      {paths?.map((path) => (
        <SafeDefaults
          key={pathKey(path)}
          type={type}
          path={path}
          isNew={!saved.has(pathKey(path))}
          fields={fields[pathKey(path)]}
          onChange={(next) => setFields((current) => ({ ...current, [pathKey(path)]: next }))}
          textOf={(key) => texts[key]}
          onText={(key, typed) => setTexts((current) => ({ ...current, [key]: typed }))}
        />
      ))}
      {anyTokens ? <LiveTokenNotice /> : null}
    </FormDialog>
  );
}

function ReplaceKeyDialog({ provider, onClose }: { provider: ProviderConnection | null; onClose: () => void }) {
  const update = useUpdateProvider();
  const test = useKeyTest();
  const opened = useOpenedRevision(provider, () => test.clear(), onClose);
  // Where the key goes, from the connection as the list now has it: a host moved elsewhere clears the key.
  const destinations = provider
    ? keyDestinationText(provider.type, { baseUrl: provider.baseUrl, cloudflareGateway: provider.cloudflareGateway ?? null })
    : "";
  const [secret, setSecret] = useBoundSecret(JSON.stringify([destinations, opened.revision, opened.conflict]));

  const submit = async () => {
    if (!provider) return;
    try {
      await update.mutateAsync({ id: provider.id, body: { revision: opened.revision, secret } });
      if (!opened.mounted.current) return;
      toast.success("Key replaced");
      onClose();
    } catch (error) {
      opened.failed(error, "Could not replace the key");
    } finally {
      update.reset();
    }
  };

  return (
    <FormDialog
      open={provider !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Replace the key"
      description={provider ? `Apps using ${provider.slug} switch to the new key at once.` : undefined}
      submitLabel="Replace key"
      pending={update.isPending}
      disabled={opened.conflict || opened.reloading || !secret}
      onSubmit={() => void submit()}
    >
      {opened.conflict ? <ConflictNotice reloading={opened.reloading} onReload={() => void opened.reload()} /> : null}
      <Field label="New API key" htmlFor="provider-new-secret" hint={destinations ? `Sent only to ${destinations}.` : undefined}>
        <div className="flex gap-2">
          <Input
            id="provider-new-secret"
            type="password"
            value={secret}
            autoComplete="off"
            disabled={opened.conflict}
            onChange={(event) => {
              setSecret(event.target.value);
              test.clear();
            }}
          />
          {/* Through Cloudflare the key goes to the gateway, whose token stays at the gateway: there is nothing to test it with here. */}
          {provider?.cloudflareGateway ? null : (
            <Button
              type="button"
              variant="outline"
              disabled={!secret || !provider || test.pending || opened.conflict}
              // Against the connection's own host, if it has one.
              onClick={() =>
                provider &&
                test.run({ type: provider.type, secret, ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}), ...(provider.auth ? { auth: provider.auth } : {}) })
              }
            >
              Test key
            </Button>
          )}
        </div>
      </Field>
      <TestResult result={test.result} />
    </FormDialog>
  );
}

/**
 * A built-in provider's own host, replaced: a self-hosted server, a regional
 * host or Azure OpenAI. Requests are still priced from our list.
 */
function HostField({ id, value, problem, onChange }: { id: string; value: string; problem: string | null; onChange: (value: string) => void }) {
  return (
    <Field
      label="Base URL (optional)"
      htmlFor={id}
      hint="Send requests to another host, such as a self-hosted server, a regional host or Azure OpenAI. Leave it empty to use the provider's own host. Prices still come from our list."
    >
      <Input
        id={id}
        value={value}
        placeholder="https://"
        autoComplete="off"
        aria-invalid={problem !== null || undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {problem !== null ? <p className="text-sm text-destructive">{problem}</p> : null}
    </Field>
  );
}

/** A typed base URL as the gateway would save it, or its refusal; null when empty. */
function checkedHost(typed: string, stored: string | null = null): ReturnType<typeof normalizedBaseUrl> | null {
  return typed.trim() === "" ? null : normalizedBaseUrl(typed, stored);
}

/**
 * A typed key, kept only for the binding it was typed under: where it would
 * go (every host the gateway can send it to) and, for an existing connection,
 * the revision the dialog holds and whether that revision was refused. Once
 * any of them changes, the key is deleted, not hidden: going back to an
 * earlier destination never brings it back, so a test or a save can only send
 * a key to where the person typed it for.
 */
function useBoundSecret(binding: string): [string, (value: string) => void] {
  const [state, setState] = useState({ binding, value: "" });
  const set = (value: string) => setState({ binding, value });
  if (state.binding !== binding) {
    setState({ binding, value: "" });
    return ["", set];
  }
  return [state.value, set];
}

/**
 * The revision a connection dialog was opened at, kept until the person
 * reloads: a save never takes a newer revision the list loaded since, so
 * another admin's change is refused rather than overwritten. `mounted` says
 * whether the dialog is still the one for this connection when an answer
 * comes back.
 */
function useOpenedRevision(provider: ProviderConnection | null, onLoaded: (latest: ProviderConnection) => void, onGone: () => void) {
  const fresh = useFreshProvider();
  const [revision, setRevision] = useState(provider?.revision ?? 0);
  const [conflict, setConflict] = useState(false);
  const [reloading, setReloading] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const reload = async () => {
    if (!provider) return;
    setReloading(true);
    try {
      const latest = await fresh(provider.id);
      if (!mounted.current) return;
      if (latest === null) {
        toast.error("This provider was deleted");
        onGone();
        return;
      }
      setRevision(latest.revision);
      onLoaded(latest);
      setConflict(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not reload the connection");
    } finally {
      if (mounted.current) setReloading(false);
    }
  };
  /** Records a save's failure: a conflict shows the reload, anything else a toast. */
  const failed = (error: unknown, fallback: string) => {
    if (!mounted.current) return;
    if (error instanceof ApiError && error.status === 409) setConflict(true);
    else toast.error(error instanceof Error ? error.message : fallback);
  };
  return { revision, conflict, reloading, reload, failed, mounted };
}

function ConflictNotice({
  reloading,
  onReload,
  title = "This connection changed since you opened it",
  body = "Someone else saved it. Reload to see their change, then make yours again.",
  label = "Reload",
}: {
  reloading: boolean;
  onReload: () => void;
  title?: string;
  body?: string;
  label?: string;
}) {
  return (
    <Alert variant="destructive">
      <AlertCircle />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{body}</p>
        <Button type="button" variant="outline" size="sm" disabled={reloading} onClick={onReload}>
          {label}
        </Button>
      </AlertDescription>
    </Alert>
  );
}

/** A new name for a connection. The slug apps use stays as it is. */
function RenameDialog({ provider, onClose }: { provider: ProviderConnection | null; onClose: () => void }) {
  const update = useUpdateProvider();
  const [name, setName] = useState(provider?.name ?? "");
  const [stored, setStored] = useState(provider?.name ?? "");
  const opened = useOpenedRevision(
    provider,
    (latest) => {
      setName(latest.name);
      setStored(latest.name);
    },
    onClose,
  );
  const trimmed = name.trim();

  const submit = async () => {
    if (!provider) return;
    try {
      await update.mutateAsync({ id: provider.id, body: { revision: opened.revision, name: trimmed } });
      if (!opened.mounted.current) return;
      toast.success("Connection renamed");
      onClose();
    } catch (error) {
      opened.failed(error, "Could not rename the connection");
    } finally {
      update.reset();
    }
  };

  return (
    <FormDialog
      open={provider !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Rename the connection"
      description={provider ? `Apps keep naming it ${provider.slug}: the slug does not change.` : undefined}
      submitLabel="Rename"
      pending={update.isPending}
      disabled={opened.conflict || opened.reloading || trimmed === "" || trimmed === stored}
      onSubmit={() => void submit()}
    >
      {opened.conflict ? <ConflictNotice reloading={opened.reloading} onReload={() => void opened.reload()} /> : null}
      <Field label="Name" htmlFor="provider-rename">
        <Input id="provider-rename" value={name} maxLength={100} autoComplete="off" readOnly={opened.reloading} onChange={(event) => setName(event.target.value)} />
      </Field>
    </FormDialog>
  );
}

/**
 * Where a built-in provider's requests go: its own host, or a base URL. A key
 * goes only where it was given: a new base URL needs a key typed for it, and
 * going back to the provider's own hosts sends the stored key there only when
 * the person says so, or takes a replacement key. Every confirmation names
 * every host the key would reach.
 */
function HostDialog({ provider, onClose }: { provider: ProviderConnection | null; onClose: () => void }) {
  const update = useUpdateProvider();
  const test = useKeyTest();
  const [stored, setStored] = useState(provider?.baseUrl ?? "");
  const [host, setHost] = useState(provider?.baseUrl ?? "");
  const [keepKey, setKeepKey] = useState(false);
  const opened = useOpenedRevision(
    provider,
    (latest) => {
      // Now through Cloudflare, whose own dialog sets where it goes.
      if (latest.cloudflareGateway) {
        toast.info("This connection now goes through Cloudflare AI Gateway");
        onClose();
        return;
      }
      setStored(latest.baseUrl ?? "");
      setHost(latest.baseUrl ?? "");
      setKeepKey(false);
      test.clear();
    },
    onClose,
  );
  const next = host.trim();
  const type = provider?.type ?? "";
  // As the gateway would save it: the hosts named, and the key's binding, follow the saved form.
  const checked = checkedHost(next, stored === "" ? null : stored);
  const invalid = checked !== null && !checked.ok;
  const saved = checked !== null && checked.ok ? checked.baseUrl : "";
  const destinations = keyDestinationText(type, { baseUrl: saved === "" ? null : saved, cloudflareGateway: null });
  const [secret, setSecret] = useBoundSecret(JSON.stringify([destinations, opened.revision, opened.conflict]));
  const changed = (next === "" ? "" : invalid ? next : saved) !== stored;
  // A new base URL needs a key typed for it.
  const needsKey = changed && next !== "";
  // Back to the provider's own hosts: the stored key goes there only when the person says so.
  const toOwnHost = changed && next === "";
  const ready = changed && !invalid && (needsKey ? secret !== "" : !toOwnHost || keepKey || secret !== "");

  const save = async () => {
    if (!provider) return;
    try {
      await update.mutateAsync({
        id: provider.id,
        body: { revision: opened.revision, baseUrl: next === "" ? null : next, ...(secret ? { secret } : {}) },
      });
      if (!opened.mounted.current) return;
      toast.success(next === "" ? "Connection uses the provider's own host" : "Base URL saved");
      onClose();
    } catch (error) {
      opened.failed(error, "Could not change the host");
    } finally {
      update.reset();
    }
  };

  return (
    <FormDialog
      open={provider !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Host"
      description="Where this connection's requests go."
      submitLabel="Save"
      pending={update.isPending}
      disabled={opened.conflict || opened.reloading || !ready}
      onSubmit={() => void save()}
    >
      {opened.conflict ? <ConflictNotice reloading={opened.reloading} onReload={() => void opened.reload()} /> : null}
      <HostField
        id="provider-host-change"
        value={host}
        problem={checked !== null && !checked.ok ? checked.message : null}
        onChange={(value) => {
          setHost(value);
          setKeepKey(false);
          test.clear();
        }}
      />
      {toOwnHost ? (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={keepKey} disabled={secret !== "" || opened.conflict} onCheckedChange={(checked) => setKeepKey(checked === true)} />
          Send the current key to {destinations}
        </label>
      ) : null}
      {needsKey || toOwnHost ? (
        <>
          <Field
            label={toOwnHost ? "Or a replacement key" : "API key"}
            htmlFor="provider-host-secret"
            hint={`${toOwnHost ? "A key typed here replaces the current one." : "A key goes only where it was given, so a new host needs it again."} Sent only to ${destinations}. Changing the address clears it.`}
          >
            <div className="flex gap-2">
              <Input
                id="provider-host-secret"
                type="password"
                value={secret}
                autoComplete="off"
                disabled={opened.conflict}
                onChange={(event) => {
                  setSecret(event.target.value);
                  if (event.target.value !== "") setKeepKey(false);
                  test.clear();
                }}
              />
              <Button
                type="button"
                variant="outline"
                disabled={!secret || invalid || !provider || test.pending || opened.conflict}
                onClick={() => provider && test.run({ type: provider.type, secret, ...(next === "" ? {} : { baseUrl: next }) })}
              >
                Test key
              </Button>
            </div>
          </Field>
          <TestResult result={test.result} />
        </>
      ) : null}
    </FormDialog>
  );
}

/**
 * Sending an existing connection through Cloudflare AI Gateway, changing it,
 * or stopping. The key's origin moves with it, so a connection that keeps a
 * key needs it again, or uses the keys stored in Cloudflare instead.
 */
function CloudflareDialog({ provider, onClose }: { provider: ProviderConnection | null; onClose: () => void }) {
  const update = useUpdateProvider();
  const [stored, setStored] = useState(provider?.cloudflareGateway ?? null);
  const [draft, setDraft] = useState<CloudflareDraft>(
    stored ? { on: true, accountId: stored.accountId, gatewayId: stored.gatewayId, token: "" } : { ...NO_CLOUDFLARE, on: true },
  );
  const [storedKeys, setStoredKeys] = useState(false);
  // Going direct again is its own step, which asks for the provider's key for where it then goes.
  const [stopping, setStopping] = useState(false);
  // A connection with a base URL loses it once its traffic goes through Cloudflare: the person confirms that, by name.
  const [dropBase, setDropBase] = useState(false);
  const [base, setBase] = useState(provider?.baseUrl ?? null);
  const opened = useOpenedRevision(
    provider,
    (latest) => {
      const now = latest.cloudflareGateway ?? null;
      setStored(now);
      setDraft(now ? { on: true, accountId: now.accountId, gatewayId: now.gatewayId, token: "" } : { ...NO_CLOUDFLARE, on: true });
      setStoredKeys(false);
      setStopping(false);
      setDropBase(false);
      setBase(latest.baseUrl ?? null);
    },
    onClose,
  );
  const sameGateway = stored !== null && draft.accountId.trim() === stored.accountId && draft.gatewayId.trim() === stored.gatewayId;
  const type = provider?.type ?? "";
  // Where a key typed here goes: the gateway being set, or, when stopping, the provider's own route.
  const throughGateway = keyDestinationText(type, {
    baseUrl: null,
    cloudflareGateway: { accountId: draft.accountId.trim(), gatewayId: draft.gatewayId.trim() },
  });
  const direct = keyDestinationText(type, { baseUrl: base, cloudflareGateway: null });
  // The gateway's address is named only once both ids are filled.
  const gatewayNamed = draft.accountId.trim() !== "" && draft.gatewayId.trim() !== "" && throughGateway !== "";
  // Turning Cloudflare on for a connection with a base URL removes the base URL in the same save.
  const removesBase = stored === null && base !== null;
  const [secret, setSecret] = useBoundSecret(JSON.stringify([stopping ? direct : throughGateway, opened.revision, opened.conflict]));

  const save = async (body: Record<string, unknown>, done: string) => {
    if (!provider) return;
    try {
      await update.mutateAsync({ id: provider.id, body: { revision: opened.revision, ...body } });
      if (!opened.mounted.current) return;
      toast.success(done);
      onClose();
    } catch (error) {
      opened.failed(error, "Could not change the connection");
    } finally {
      update.reset();
    }
  };
  // Ticking "use the keys stored in Cloudflare" means no key, whatever was typed.
  const key = storedKeys ? { secret: null } : secret ? { secret } : {};
  // A new gateway, or turning it on, moves the key: it must be sent again, or given up for Cloudflare's own.
  const moving = !sameGateway;
  const blocked = opened.conflict || opened.reloading;

  if (stopping) {
    return (
      <FormDialog
        open={provider !== null}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title="Stop using Cloudflare AI Gateway"
        description={`Requests go straight to ${direct} again. A key is never moved there from the gateway: enter the provider's key for it.`}
        submitLabel="Go direct"
        pending={update.isPending}
        disabled={blocked || !secret}
        onSubmit={() => void save({ cloudflareGateway: null, secret }, "Connection goes direct again")}
      >
        {opened.conflict ? <ConflictNotice reloading={opened.reloading} onReload={() => void opened.reload()} /> : null}
        <Field label="The provider's API key" htmlFor="cloudflare-direct-secret" hint={`Sent only to ${direct}.`}>
          <Input
            id="cloudflare-direct-secret"
            type="password"
            value={secret}
            autoComplete="off"
            disabled={blocked}
            onChange={(event) => setSecret(event.target.value)}
          />
        </Field>
        <Button type="button" variant="outline" size="sm" onClick={() => setStopping(false)}>
          Back
        </Button>
      </FormDialog>
    );
  }

  return (
    <FormDialog
      open={provider !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Cloudflare AI Gateway"
      description="Requests go to your Cloudflare AI Gateway, which passes them to the provider. Costs are read from the provider's own answers."
      submitLabel="Save"
      pending={update.isPending}
      disabled={blocked || !cloudflareReady(draft, sameGateway, stored) || (moving && !secret && !storedKeys) || (removesBase && !dropBase)}
      onSubmit={() =>
        void save({ cloudflareGateway: cloudflareBody(draft), ...(removesBase ? { baseUrl: null } : {}), ...key }, "Cloudflare AI Gateway saved")
      }
    >
      {opened.conflict ? <ConflictNotice reloading={opened.reloading} onReload={() => void opened.reload()} /> : null}
      <CloudflareFields draft={draft} onChange={(next) => setDraft({ ...next, on: true })} tokenOptional={sameGateway} stored={stored} />
      {removesBase ? (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={dropBase} disabled={blocked} onCheckedChange={(checked) => setDropBase(checked === true)} />
          Remove the base URL {base}: Cloudflare AI Gateway sends requests to the provider itself
        </label>
      ) : null}
      <Field
        label="API key"
        htmlFor="cloudflare-provider-secret"
        hint={`A connection's key goes only where it was given. Send it for a new gateway, or use the keys stored in Cloudflare.${gatewayNamed ? ` Sent only to ${throughGateway}.` : ""} Changing the account or gateway clears it.`}
      >
        <Input
          id="cloudflare-provider-secret"
          type="password"
          value={secret}
          autoComplete="off"
          disabled={storedKeys || blocked}
          onChange={(event) => setSecret(event.target.value)}
        />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={storedKeys}
          onCheckedChange={(checked) => {
            setStoredKeys(checked === true);
            if (checked === true) setSecret("");
          }}
        />
        Use the keys stored in Cloudflare, and remove this connection&apos;s key
      </label>
      {stored ? (
        <Button type="button" variant="outline" disabled={blocked} onClick={() => setStopping(true)}>
          Stop using Cloudflare AI Gateway
        </Button>
      ) : null}
    </FormDialog>
  );
}

/**
 * The prices text a person edits: the connection's own prices as JSON, or
 * empty when it has none.
 */
export function pricesText(pricing: ProviderConnection["pricing"]): string {
  return pricing === null || Object.keys(pricing).length === 0 ? "" : JSON.stringify(pricing, null, 2);
}

/** What the prices text saves: null for none, the prices, or a problem to show. */
export function parsePricesText(
  text: string,
  stored = "",
): { pricing: NonNullable<ProviderConnection["pricing"]> | null } | { problem: string } {
  if (text.trim() === "") return { pricing: null };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { problem: "Write the prices as JSON: an object with one entry per model." };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { problem: "Write the prices as an object with one entry per model." };
  // Each amount as written, by the gateway's money rule: a float may read some as another figure.
  // Amounts already saved (`stored`) are not judged again: an old price never locks the editor.
  const amounts = jsonPriceProblem(text, stored);
  if (amounts !== null) return { problem: amounts };
  // The server checks every price; the console only checks the shape.
  return { pricing: Object.keys(value).length === 0 ? null : (value as NonNullable<ProviderConnection["pricing"]>) };
}

/**
 * A connection's own prices, in dollars: for a model our price list does not
 * have, such as a fal model priced per job, or to replace a listed price. The
 * server checks every price when it is saved.
 *
 * The form shows the common rates per model. Anything else a price carries
 * stays exactly as stored; "Edit as JSON" shows and edits all of it.
 */
function PricesDialog({ provider, onClose }: { provider: ProviderConnection | null; onClose: () => void }) {
  const update = useUpdateProvider();
  // Prices the form cannot show without losing something open as JSON.
  const [mode, setMode] = useState<"form" | "json">(() => (formCanShow(provider?.pricing ?? null) ? "form" : "json"));
  const [rows, setRows] = useState<PriceRow[]>(() => (formCanShow(provider?.pricing ?? null) ? rowsOf(provider?.pricing ?? null) : []));
  const [saved, setSaved] = useState<ProviderConnection["pricing"]>(provider?.pricing ?? null);
  const [modeProblem, setModeProblem] = useState<string | null>(null);
  const [text, setText] = useState(() => pricesText(provider?.pricing ?? null));
  // The JSON text "Edit as JSON" showed: while it is unchanged, going back to the form keeps the rows as they were.
  const [jsonFrom, setJsonFrom] = useState<string | null>(null);
  const opened = useOpenedRevision(
    provider,
    (latest) => {
      setSaved(latest.pricing);
      setText(pricesText(latest.pricing));
      setJsonFrom(null);
      setModeProblem(null);
      if (formCanShow(latest.pricing)) setRows(rowsOf(latest.pricing));
      else {
        setRows([]);
        setMode("json");
      }
    },
    onClose,
  );
  const reloading = opened.reloading;
  const problems = rows.map((row) => rowProblems(row, rows));
  const formValid = problems.every((found) => Object.keys(found).length === 0);
  const parsed =
    mode === "json" ? parsePricesText(text, pricesText(saved)) : formValid ? { pricing: pricingOf(rows) } : { problem: "Fix the prices marked below." };
  const untouchedJson = mode === "json" && text === jsonFrom;

  const switchMode = () => {
    setModeProblem(null);
    if (mode === "form") {
      // The form's prices when they are complete; otherwise the saved prices, as they are.
      const shown = pricesText("problem" in parsed ? saved : parsed.pricing);
      setText(shown);
      setJsonFrom(shown);
      if ("problem" in parsed) setModeProblem("The form had changes that are not complete, so this shows the saved prices.");
      setMode("json");
      return;
    }
    if (untouchedJson) {
      setMode("form");
      return;
    }
    if ("problem" in parsed) return;
    if (!formCanShow(parsed.pricing)) {
      setModeProblem("Some entries are not prices the form can show, such as a model whose value is not an object. Keep editing them as JSON.");
      return;
    }
    setRows(rowsOf(parsed.pricing));
    setMode("form");
  };

  const submit = async () => {
    if (!provider || "problem" in parsed) return;
    try {
      await update.mutateAsync({ id: provider.id, body: { revision: opened.revision, pricing: parsed.pricing } });
      toast.success(parsed.pricing === null ? "Your prices removed" : "Your prices saved");
      if (opened.mounted.current) onClose();
    } catch (error) {
      opened.failed(error, "Could not save the prices");
    } finally {
      update.reset();
    }
  };

  const setRow = (index: number, change: Partial<PriceRow>) => setRows(rows.map((row, at) => (at === index ? { ...row, ...change } : row)));

  return (
    <FormDialog
      open={provider !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Your prices"
      description="Your own prices for this connection's models, in dollars. Use them for a model our price list does not have, or to replace a listed price."
      submitLabel="Save prices"
      pending={update.isPending}
      disabled={opened.conflict || reloading || "problem" in parsed}
      onSubmit={() => void submit()}
    >
      {opened.conflict ? (
        <ConflictNotice
          reloading={reloading}
          onReload={() => void opened.reload()}
          title="These prices changed since you opened them"
          body="Someone else saved this provider. Reload to see their prices, then make your change again."
          label="Reload prices"
        />
      ) : null}
      {mode === "form" ? (
        <fieldset className="space-y-3" disabled={reloading} aria-busy={reloading}>
          <p className="text-sm text-muted-foreground">Token rates are per million tokens. A unit rate is per the unit you pick.</p>
          {rows.length === 0 ? <p className="text-sm text-muted-foreground">No prices of your own. Our price list is used.</p> : null}
          {rows.map((row, index) => (
            <PriceRowFields
              key={row.key}
              row={row}
              problems={problems[index]!}
              onChange={(change) => setRow(index, change)}
              onRemove={() => setRows(rows.filter((_, at) => at !== index))}
            />
          ))}
          <Button type="button" variant="outline" size="sm" onClick={() => setRows([...rows, emptyRow()])}>
            <Plus className="size-4" />
            Add a model
          </Button>
        </fieldset>
      ) : (
        <>
          <Field
            label="Prices by model"
            htmlFor="provider-prices"
            hint={
              'One entry per model. Tokens are per million; other rates are per their unit: per_request (a job or call), per_image, per_video, per_unit (the provider\'s own billed unit), per_second, per_minute. For example: {"fal-ai/some-model": {"per_request": 0.02}}. Leave it empty to use only our price list.'
            }
          >
            <Textarea
              id="provider-prices"
              className="min-h-40 font-mono text-xs"
              value={text}
              spellCheck={false}
              // While a reload is reading the server's prices, nothing typed can be lost to its answer.
              readOnly={reloading}
              aria-busy={reloading}
              onChange={(event) => setText(event.target.value)}
            />
          </Field>
          {"problem" in parsed && text.trim() !== "" ? <p className="text-sm text-destructive">{parsed.problem}</p> : null}
        </>
      )}
      {modeProblem ? <p className="text-sm text-muted-foreground">{modeProblem}</p> : null}
      <Button type="button" variant="link" size="sm" className="px-0" disabled={mode === "json" && !untouchedJson && "problem" in parsed} onClick={switchMode}>
        {mode === "form" ? "Edit as JSON" : "Edit as a form"}
      </Button>
    </FormDialog>
  );
}

/** One model's row in the prices form. */
function PriceRowFields({
  row,
  problems,
  onChange,
  onRemove,
}: {
  row: PriceRow;
  problems: Record<string, string>;
  onChange: (change: Partial<PriceRow>) => void;
  onRemove: () => void;
}) {
  const id = row.key;
  const kept = hiddenFields(row);
  const locked = severalUnits(row);
  return (
    <div className="space-y-2 rounded-md border p-3" role="group" aria-label={row.model.trim() === "" ? "New model" : row.model}>
      <div className="flex items-end gap-2">
        <Field label="Model" htmlFor={`${id}-model`} className="flex-1">
          <Input
            id={`${id}-model`}
            value={row.model}
            autoComplete="off"
            aria-invalid={problems.model ? true : undefined}
            onChange={(event) => onChange({ model: event.target.value })}
          />
        </Field>
        <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${row.model.trim() || "this model"}`} onClick={onRemove}>
          <Trash2 className="size-4" />
        </Button>
      </div>
      {problems.model ? <p className="text-sm text-destructive">{problems.model}</p> : null}
      <div className="grid grid-cols-3 gap-2">
        {TOKEN_FIELDS.map(({ field, label }) => (
          <Field key={field} label={`${label} $/1M`} htmlFor={`${id}-${field}`}>
            <Input
              id={`${id}-${field}`}
              inputMode="decimal"
              value={row.tokens[field]}
              autoComplete="off"
              aria-invalid={problems[field] ? true : undefined}
              onChange={(event) => onChange({ tokens: { ...row.tokens, [field]: event.target.value } })}
            />
          </Field>
        ))}
      </div>
      {TOKEN_FIELDS.map(({ field }) => (problems[field] ? <p key={field} className="text-sm text-destructive">{problems[field]}</p> : null))}
      <div className="flex items-end gap-2">
        <Field label="Unit rate $" htmlFor={`${id}-unit-amount`} className="w-32">
          <Input
            id={`${id}-unit-amount`}
            inputMode="decimal"
            value={row.unitAmount}
            autoComplete="off"
            disabled={locked || row.unitField === ""}
            aria-invalid={problems.unit ? true : undefined}
            onChange={(event) => onChange({ unitAmount: event.target.value })}
          />
        </Field>
        <Field label="Unit" htmlFor={`${id}-unit`} className="flex-1">
          <Select disabled={locked} value={row.unitField === "" ? "none" : row.unitField} onValueChange={(value) => onChange({ unitField: value === "none" ? "" : value })}>
            <SelectTrigger id={`${id}-unit`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No unit rate</SelectItem>
              {UNIT_FIELDS.map((entry) => (
                <SelectItem key={entry.field} value={entry.field}>
                  {entry.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      {problems.unit ? <p className="text-sm text-destructive">{problems.unit}</p> : null}
      {locked ? <p className="text-xs text-muted-foreground">This model has several unit rates. Edit them as JSON.</p> : null}
      {problems.row ? <p className="text-sm text-destructive">{problems.row}</p> : null}
      {kept.length > 0 ? (
        <p className="text-xs text-muted-foreground">Also kept as saved: {kept.join(", ")}. Edit them as JSON.</p>
      ) : null}
    </div>
  );
}
