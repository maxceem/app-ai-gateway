import { useState } from "react";
import { AlertCircle, Ban, CheckCircle2, KeyRound, Plus, Power, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Field, PageHeader } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { GuardedButton } from "@/components/guarded-button";
import { RelativeTime } from "@/components/relative-time";
import { RowAction, RowActions } from "@/components/row-actions";
import { PROVIDER_TYPES, providerLabel } from "@/lib/providers";
import { useCreateProvider, useDeleteProvider, useProviders, useTestProvider, useUpdateProvider } from "@/lib/queries";
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
  const [removing, setRemoving] = useState<ProviderConnection | null>(null);

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
      <ReplaceKeyDialog
        provider={providers.find((provider) => provider.id === rotatingId) ?? null}
        onClose={() => setRotatingId(null)}
      />

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
  const run = (body: { type: string; secret: string; baseUrl?: string }) => {
    setResult(null);
    test
      .mutateAsync(body)
      .then(setResult, () => setResult("failed"))
      .finally(() => test.reset());
  };
  return { run, result, pending: test.isPending, clear: () => setResult(null) };
}

function AddProviderDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const create = useCreateProvider();
  const test = useKeyTest();
  const [type, setType] = useState(PROVIDER_TYPES[0]?.type ?? "");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [secret, setSecret] = useState("");

  const reset = () => {
    setName("");
    setSlug("");
    setSecret("");
    test.clear();
  };
  const slugInvalid = slug !== "" && !SLUG.test(slug);

  const submit = async () => {
    try {
      await create.mutateAsync({ type, name: name.trim(), secret, ...(slug ? { slug } : {}) });
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
      disabled={!type || !name.trim() || !secret || slugInvalid}
      onSubmit={() => void submit()}
    >
      <Field label="Provider" htmlFor="provider-type">
        <Select
          value={type}
          onValueChange={(value) => {
            setType(value);
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
      <Field label="API key" htmlFor="provider-secret" hint="Stored encrypted. It is never shown again, only its last characters.">
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
          <Button type="button" variant="outline" disabled={!secret || test.pending} onClick={() => test.run({ type, secret })}>
            Test key
          </Button>
        </div>
      </Field>
      <TestResult result={test.result} />
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
          <Button
            type="button"
            variant="outline"
            disabled={!secret || !provider || test.pending}
            // Against the connection's own host, if it has one.
            onClick={() => provider && test.run({ type: provider.type, secret, ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}) })}
          >
            Test key
          </Button>
        </div>
      </Field>
      <TestResult result={test.result} />
    </FormDialog>
  );
}
