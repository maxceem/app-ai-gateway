import { useEffect, useRef, useState } from "react";
import { AlertCircle, Ban, CheckCircle2, Cloud, DollarSign, KeyRound, ListTree, Plus, Power, Trash2 } from "lucide-react";
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
import { cloudflareCapable, CUSTOM_STYLES, PROVIDER_TYPES, providerLabel, suggestedPath } from "@/lib/providers";
import { ApiError } from "@/lib/api";
import { useCreateProvider, useDeleteProvider, useFreshProvider, useProviders, useTestProvider, useUpdateProvider } from "@/lib/queries";
import type { ProviderConnection, ProviderTestResult } from "@/lib/types";

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
function cloudflareReady(draft: CloudflareDraft, tokenOptional: boolean): boolean {
  return !draft.on || (draft.accountId.trim() !== "" && draft.gatewayId.trim() !== "" && (tokenOptional || draft.token !== ""));
}

function cloudflareBody(draft: CloudflareDraft): CloudflareBody {
  return { accountId: draft.accountId.trim(), gatewayId: draft.gatewayId.trim(), ...(draft.token ? { token: draft.token } : {}) };
}

function CloudflareFields({
  draft,
  onChange,
  tokenOptional = false,
}: {
  draft: CloudflareDraft;
  onChange: (draft: CloudflareDraft) => void;
  tokenOptional?: boolean;
}) {
  return (
    <>
      <label className="flex items-center gap-2 text-sm font-medium">
        <Checkbox checked={draft.on} onCheckedChange={(checked) => onChange({ ...draft, on: checked === true })} />
        Send through Cloudflare AI Gateway
      </label>
      {draft.on ? (
        <>
          <Field label="Cloudflare account ID" htmlFor="cloudflare-account">
            <Input
              id="cloudflare-account"
              value={draft.accountId}
              autoComplete="off"
              onChange={(event) => onChange({ ...draft, accountId: event.target.value })}
            />
          </Field>
          <Field label="Cloudflare gateway ID" htmlFor="cloudflare-gateway">
            <Input
              id="cloudflare-gateway"
              value={draft.gatewayId}
              autoComplete="off"
              onChange={(event) => onChange({ ...draft, gatewayId: event.target.value })}
            />
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
  const [secret, setSecret] = useState("");
  const [cloudflare, setCloudflare] = useState<CloudflareDraft>(NO_CLOUDFLARE);
  const [custom, setCustom] = useState<CustomDraft>(NO_CUSTOM);

  const reset = () => {
    setName("");
    setSlug("");
    setSecret("");
    setCloudflare(NO_CLOUDFLARE);
    setCustom(NO_CUSTOM);
    test.clear();
  };
  const slugInvalid = slug !== "" && !SLUG.test(slug);
  const isCustom = type === "custom";
  // Through Cloudflare, the key is optional: Cloudflare can use the keys it stores.
  const viaCloudflare = cloudflareCapable(type) && cloudflare.on;
  const ready = cloudflareReady(cloudflare, false) && (secret !== "" || viaCloudflare) && (!isCustom || customReady(custom));
  // A new setting always carries its token.
  const route = viaCloudflare
    ? { cloudflareGateway: { accountId: cloudflare.accountId.trim(), gatewayId: cloudflare.gatewayId.trim(), token: cloudflare.token } }
    : isCustom
      ? { baseUrl: custom.baseUrl.trim(), auth: { header: custom.header.trim().toLowerCase(), format: custom.format } }
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
          viaCloudflare
            ? "Optional through Cloudflare: leave it empty to use the keys stored in your Cloudflare AI Gateway. Stored encrypted if given."
            : isCustom
              ? "Stored encrypted, and sent only to the base URL above, in the header you name. It is never shown again, only its last characters."
              : "Stored encrypted. It is never shown again, only its last characters."
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

/** One listed path as a line: method, path, then a price in dollars or an API style. Its field settings are kept apart. */
export function pathLine(path: ListedPath): string {
  return [path.method, path.path, ...(path.per_request !== undefined ? [`$${path.per_request}`] : []), ...(path.style !== undefined ? [path.style] : [])].join(" ");
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/**
 * Lines back to listed paths. Each line is a method and a path, then
 * optionally `$<dollars>` per request or, on a custom provider, an API style.
 * Returns the paths, or the first problem with its line number.
 */
export function parsePathLines(text: string, custom: boolean): { paths: ListedPath[] } | { problem: string } {
  const paths: ListedPath[] = [];
  const lines = text.split("\n");
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === "") continue;
    const where = `Line ${index + 1}`;
    const [method, path, ...rest] = line.split(/\s+/u);
    const upper = method!.toUpperCase();
    if (!(METHODS as readonly string[]).includes(upper)) return { problem: `${where}: start with GET, POST, PUT, PATCH or DELETE.` };
    if (path === undefined) return { problem: `${where}: add the path after the method.` };
    const entry: ListedPath = { method: upper as ListedPath["method"], path };
    for (const token of rest) {
      if (token.startsWith("$")) {
        const price = Number(token.slice(1));
        if (token.length === 1 || !Number.isFinite(price) || price < 0) return { problem: `${where}: a price is $ and a number, such as $0.002.` };
        entry.per_request = price;
      } else if (custom && CUSTOM_STYLES.includes(token)) {
        entry.style = token as ListedPath["style"];
      } else {
        return {
          problem: custom
            ? `${where}: ${token} is not a price or an API style (${CUSTOM_STYLES.join(", ")}).`
            : `${where}: ${token} is not a price. Write a price as $0.002.`,
        };
      }
    }
    paths.push(entry);
  }
  return { paths };
}

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
  // The version the draft was made from: it is saved at that revision, never at a newer one the list
  // loaded since, so another admin's change is never quietly overwritten.
  const [base, setBase] = useState({ revision: provider?.revision ?? 0, listed: provider?.passthrough ?? [] });
  const [text, setText] = useState(base.listed.map(pathLine).join("\n"));
  const [trusted, setTrusted] = useState(false);
  const [fields, setFields] = useState<Record<string, FieldSetting[]>>(() => fieldsOf(base.listed));
  const [conflict, setConflict] = useState(false);
  // Field values as typed so far, by path and field (`textKey`): saving checks the ones still shown.
  const [texts, setTexts] = useState<Record<string, string>>({});
  const parsed = parsePathLines(text, custom);
  // A first listing on a built-in provider needs the choice made; a custom provider made it when added.
  const choosing = !custom && base.listed.length === 0;
  const paths = "paths" in parsed ? parsed.paths : null;
  const type = provider?.type ?? "";
  const saved = new Set(base.listed.map(pathKey));
  const anyTokens = paths !== null && paths.some((path) => suggestedPath(type, path.method, path.path)?.liveToken === true);

  /** Starts again from the provider as it is now, dropping the draft. */
  const reload = () => {
    const listed = provider?.passthrough ?? [];
    setBase({ revision: provider?.revision ?? 0, listed });
    setText(listed.map(pathLine).join("\n"));
    setFields(fieldsOf(listed));
    setTexts({});
    setConflict(false);
  };

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
      await update.mutateAsync({ id: provider.id, body: { revision: base.revision, passthrough: paths.length === 0 ? null : pathsToSave(paths, fields) } });
      toast.success(paths.length === 0 ? "No paths listed" : "Paths saved");
      onClose();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) setConflict(true);
      else toast.error(error instanceof Error ? error.message : "Could not save the paths");
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
      disabled={conflict || paths === null || (choosing && paths.length > 0 && !trusted)}
      onSubmit={() => void save()}
    >
      {conflict ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>These paths changed since you opened them</AlertTitle>
          <AlertDescription>
            <p>Someone else saved this provider. Reload to see their paths, then make your change again.</p>
            <Button type="button" variant="outline" size="sm" onClick={reload}>
              Reload paths
            </Button>
          </AlertDescription>
        </Alert>
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
  const [secret, setSecret] = useState("");

  const close = () => {
    setSecret("");
    test.clear();
    onClose();
  };

  const submit = async () => {
    if (!provider) return;
    try {
      await update.mutateAsync({ id: provider.id, body: { revision: provider.revision, secret } });
      toast.success("Key replaced");
      close();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not replace the key");
    } finally {
      update.reset();
    }
  };

  return (
    <FormDialog
      open={provider !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title="Replace the key"
      description={provider ? `Apps using ${provider.slug} switch to the new key at once.` : undefined}
      submitLabel="Replace key"
      pending={update.isPending}
      disabled={!secret}
      onSubmit={() => void submit()}
    >
      <Field label="New API key" htmlFor="provider-new-secret">
        <div className="flex gap-2">
          <Input
            id="provider-new-secret"
            type="password"
            value={secret}
            autoComplete="off"
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
              disabled={!secret || !provider || test.pending}
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
 * Sending an existing connection through Cloudflare AI Gateway, changing it,
 * or stopping. The key's origin moves with it, so a connection that keeps a
 * key needs it again, or uses the keys stored in Cloudflare instead.
 */
function CloudflareDialog({ provider, onClose }: { provider: ProviderConnection | null; onClose: () => void }) {
  const update = useUpdateProvider();
  const stored = provider?.cloudflareGateway ?? null;
  const [draft, setDraft] = useState<CloudflareDraft>(
    stored ? { on: true, accountId: stored.accountId, gatewayId: stored.gatewayId, token: "" } : { ...NO_CLOUDFLARE, on: true },
  );
  const [secret, setSecret] = useState("");
  const [storedKeys, setStoredKeys] = useState(false);
  const sameGateway = stored !== null && draft.accountId.trim() === stored.accountId && draft.gatewayId.trim() === stored.gatewayId;

  const save = async (body: Record<string, unknown>, done: string) => {
    if (!provider) return;
    try {
      await update.mutateAsync({ id: provider.id, body: { revision: provider.revision, ...body } });
      toast.success(done);
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not change the connection");
    } finally {
      update.reset();
    }
  };
  // Ticking "use the keys stored in Cloudflare" means no key, whatever was typed.
  const key = storedKeys ? { secret: null } : secret ? { secret } : {};
  // A new gateway, or turning it on, moves the key: it must be sent again, or given up for Cloudflare's own.
  const moving = !sameGateway;

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
      disabled={!cloudflareReady(draft, sameGateway) || (moving && !secret && !storedKeys)}
      onSubmit={() => void save({ cloudflareGateway: cloudflareBody(draft), ...key }, "Cloudflare AI Gateway saved")}
    >
      <CloudflareFields draft={draft} onChange={(next) => setDraft({ ...next, on: true })} tokenOptional={sameGateway} />
      <Field
        label="API key"
        htmlFor="cloudflare-provider-secret"
        hint="A connection's key goes only where it was given. Send it for a new gateway, or use the keys stored in Cloudflare. Going direct again needs it too."
      >
        <Input
          id="cloudflare-provider-secret"
          type="password"
          value={secret}
          autoComplete="off"
          disabled={storedKeys}
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
        <Button
          type="button"
          variant="outline"
          // Going direct needs the provider's key: the one sent to the gateway is not reused.
          disabled={update.isPending || !secret || storedKeys}
          onClick={() => void save({ cloudflareGateway: null, secret }, "Connection goes direct again")}
        >
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
export function parsePricesText(text: string): { pricing: NonNullable<ProviderConnection["pricing"]> | null } | { problem: string } {
  if (text.trim() === "") return { pricing: null };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { problem: "Write the prices as JSON: an object with one entry per model." };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { problem: "Write the prices as an object with one entry per model." };
  // The server checks every price; the console only checks the shape.
  return { pricing: Object.keys(value).length === 0 ? null : (value as NonNullable<ProviderConnection["pricing"]>) };
}

/**
 * A connection's own prices, in dollars: for a model our price list does not
 * have, such as a fal model priced per job, or to replace a listed price. The
 * server checks every price when it is saved.
 */
function PricesDialog({ provider, onClose }: { provider: ProviderConnection | null; onClose: () => void }) {
  const update = useUpdateProvider();
  const fresh = useFreshProvider();
  // The version the draft was made from: it is saved at that revision, never at a newer one the list
  // loaded since, so another admin's change is never quietly overwritten.
  const [revision, setRevision] = useState(provider?.revision ?? 0);
  const [text, setText] = useState(() => pricesText(provider?.pricing ?? null));
  const [conflict, setConflict] = useState(false);
  const [reloading, setReloading] = useState(false);
  const parsed = parsePricesText(text);

  /**
   * Starts again from the provider as the server has it now, read fresh, not
   * from a list that may still be the old one. The draft is dropped only once
   * that read succeeds; if it fails, the draft and the conflict notice stay.
   */
  const reload = async () => {
    if (!provider) return;
    setReloading(true);
    try {
      const latest = await fresh(provider.id);
      if (latest === null) {
        toast.error("This provider was deleted");
        onClose();
        return;
      }
      setRevision(latest.revision);
      setText(pricesText(latest.pricing));
      setConflict(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not reload the prices");
    } finally {
      setReloading(false);
    }
  };

  const submit = async () => {
    if (!provider || "problem" in parsed) return;
    try {
      await update.mutateAsync({ id: provider.id, body: { revision, pricing: parsed.pricing } });
      toast.success(parsed.pricing === null ? "Your prices removed" : "Your prices saved");
      onClose();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) setConflict(true);
      else toast.error(error instanceof Error ? error.message : "Could not save the prices");
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
      title="Your prices"
      description="Your own prices for this connection's models, in dollars. Use them for a model our price list does not have, or to replace a listed price."
      submitLabel="Save prices"
      pending={update.isPending}
      disabled={conflict || "problem" in parsed}
      onSubmit={() => void submit()}
    >
      {conflict ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>These prices changed since you opened them</AlertTitle>
          <AlertDescription>
            <p>Someone else saved this provider. Reload to see their prices, then make your change again.</p>
            <Button type="button" variant="outline" size="sm" disabled={reloading} onClick={() => void reload()}>
              Reload prices
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
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
          onChange={(event) => setText(event.target.value)}
        />
      </Field>
      {"problem" in parsed && text.trim() !== "" ? <p className="text-sm text-destructive">{parsed.problem}</p> : null}
    </FormDialog>
  );
}
