/**
 * An app's model rewrites and presets, as v1's console edited them, each a
 * form with one save. Both live in the app configuration, and every other
 * part of it is sent back as it was read.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertCircle, ArrowRight, Loader2, Plus, Trash2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/field";
import { GuardedButton } from "@/components/guarded-button";
import { useConsoleSession } from "@/lib/console-session";
import { operationsOf } from "@/lib/providers";
import { useProviders } from "@/lib/queries";
import { configIssue, useSaveApp } from "@/lib/save-app";
import type { App, ProviderConnection } from "@/lib/types";
import { PRESET_SLUG_PATTERN, PresetsConfigSchema, type Preset } from "@contracts/app-config";
import { BUILT_IN_PROVIDERS } from "@providers/index";
import { declaredOperation, presetOperationProblem } from "@providers/presets";

function Problem({ children }: { children: string | undefined }) {
  return children ? (
    <p role="alert" className="text-xs text-destructive">
      {children}
    </p>
  ) : null;
}

/** A refusal shown under the matching part of the form, or above it. */
interface Refusal {
  path: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Model rewrites

type RewriteRow = { from: string; to: string };

const rowsOf = (app: App): RewriteRow[] => Object.entries(app.config.routing.model_rewrites ?? {}).map(([from, to]) => ({ from, to }));

/** What is wrong with the rows, if anything, in words. */
export function rewriteProblem(rows: RewriteRow[]): string | undefined {
  const sources = rows.map((row) => row.from.trim());
  if (rows.some((row) => row.from.trim() === "" || row.to.trim() === "")) return "Fill in both models on every row, or remove the row.";
  const seen = new Set<string>();
  for (const source of sources) {
    if (seen.has(source)) return `${source} is rewritten twice. Keep one row for it.`;
    seen.add(source);
  }
  if (sources.includes("__proto__")) return "__proto__ is not a model name.";
  return undefined;
}

/**
 * Model rewrites: the model a request names, and the model it is sent and
 * billed as. One step only: a rewrite's target is never rewritten again.
 */
export function RewritesTab({ app }: { app: App }) {
  const { readOnly } = useConsoleSession();
  const { save, pending } = useSaveApp(app);
  const [rows, setRows] = useState(() => rowsOf(app));
  const [refused, setRefused] = useState<Refusal | null>(null);
  useEffect(() => {
    setRows(rowsOf(app));
    setRefused(null);
  }, [app.revision]);

  const change = (next: RewriteRow[]) => {
    setRows(next);
    setRefused(null);
  };
  const problem = rewriteProblem(rows);
  const map = Object.fromEntries(rows.map((row) => [row.from.trim(), row.to.trim()]));
  const dirty = JSON.stringify(map) !== JSON.stringify(app.config.routing.model_rewrites ?? {});
  const disabled = readOnly || pending;

  const submit = async () => {
    const { model_rewrites: _old, ...routing } = app.config.routing;
    // An empty list is the default, so it is left out rather than written.
    const next = rows.length === 0 ? routing : { ...routing, model_rewrites: map };
    await save({ config: { ...app.config, routing: next } }, "Rewrites saved", (error) => setRefused(configIssue(error)));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Model rewrites</CardTitle>
        <CardDescription>
          Send a request for one model to another, for every call of this app. The app may ask for the model on the left, and is
          sent and billed as the model on the right. Presets name their models themselves and are not rewritten.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.length === 0 ? <p className="text-sm text-muted-foreground">No rewrites. Every call gets the model it asks for.</p> : null}
        {rows.map((row, index) => (
          <div key={index} className="flex items-center gap-2">
            <Input
              value={row.from}
              aria-label={`Rewrite ${index + 1}: model asked for`}
              placeholder="my-model"
              className="flex-1 font-mono text-xs"
              autoComplete="off"
              disabled={disabled}
              onChange={(event) => change(rows.map((item, position) => (position === index ? { ...item, from: event.target.value } : item)))}
            />
            <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <Input
              value={row.to}
              aria-label={`Rewrite ${index + 1}: model sent`}
              placeholder="gpt-5.5-mini"
              className="flex-1 font-mono text-xs"
              autoComplete="off"
              disabled={disabled}
              onChange={(event) => change(rows.map((item, position) => (position === index ? { ...item, to: event.target.value } : item)))}
            />
            <Button type="button" variant="ghost" size="icon" aria-label={`Remove rewrite ${index + 1}`} disabled={disabled} onClick={() => change(rows.filter((_, position) => position !== index))}>
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
        <Problem>{problem}</Problem>
        <Problem>{refused?.message}</Problem>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => change([...rows, { from: "", to: "" }])}>
            <Plus className="size-4" />
            Add rewrite
          </Button>
          <GuardedButton size="sm" disabled={!dirty || problem !== undefined || pending} onClick={() => void submit()}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            Save rewrites
          </GuardedButton>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Presets

interface FallbackDraft {
  provider: string;
  operation: string;
  model: string;
}

interface PresetDraft {
  /** Which card this is while its name is edited. */
  key: number;
  slug: string;
  provider: string;
  operation: string;
  model: string;
  maxOutputTokens: string;
  params: string;
  fallback: FallbackDraft[];
}

let nextKey = 0;

function draftsOf(app: App): PresetDraft[] {
  return Object.entries(app.config.presets ?? {}).map(([slug, preset]) => ({
    key: nextKey++,
    slug,
    provider: preset.provider,
    operation: preset.operation,
    model: preset.model,
    maxOutputTokens: preset.max_output_tokens === undefined ? "" : String(preset.max_output_tokens),
    params: preset.params === undefined ? "" : JSON.stringify(preset.params, null, 2),
    fallback: (preset.fallback ?? []).map((one) => ({ provider: one.provider, operation: one.operation ?? "", model: one.model })),
  }));
}

/**
 * The operations of a connection a preset may use: a call measured from its
 * answer, a POST, naming its model where the preset can set it. The gateway
 * checks the rest when the preset is saved.
 */
export function presetOperations(connection: Pick<ProviderConnection, "type" | "passthrough">): string[] {
  const description = Object.hasOwn(BUILT_IN_PROVIDERS, connection.type) ? BUILT_IN_PROVIDERS[connection.type] : undefined;
  if (description !== undefined) {
    return description.operations.filter((operation) => presetOperationProblem(description, operation) === null).map((operation) => operation.name);
  }
  // A custom provider: an operation for each API style it lists a path for.
  return operationsOf(connection).filter((operation) => operation.name !== "passthrough" && declaredOperation(operation.name)?.style !== undefined).map((operation) => operation.name);
}

/** What is wrong with one preset draft, by field, in words. */
function presetProblems(draft: PresetDraft, slugs: string[]): Record<string, string> {
  const problems: Record<string, string> = {};
  if (!PRESET_SLUG_PATTERN.test(draft.slug)) problems.slug = "Use 1 to 64 characters from a-z, 0-9 and -.";
  else if (slugs.filter((slug) => slug === draft.slug).length > 1) problems.slug = "Another preset has this name.";
  if (draft.provider === "") problems.provider = "Choose a provider.";
  if (draft.operation === "") problems.operation = "Choose an operation.";
  if (draft.model.trim() === "") problems.model = "Name the model.";
  if (draft.maxOutputTokens.trim() !== "" && !/^[1-9]\d*$/u.test(draft.maxOutputTokens.trim())) problems.max_output_tokens = "Use a whole number, or leave it empty.";
  if (draft.params.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(draft.params);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) problems.params = "Write a JSON object, such as {\"temperature\": 0.2}.";
    } catch {
      problems.params = "Not valid JSON.";
    }
  }
  if (draft.fallback.some((one) => one.provider === "" || one.model.trim() === "")) problems.fallback = "Every fallback needs a provider and a model.";
  return problems;
}

/** The stored preset a draft saves as. Call only when it has no problems. */
function presetOf(draft: PresetDraft): Preset {
  return {
    provider: draft.provider,
    operation: draft.operation,
    model: draft.model.trim(),
    ...(draft.params.trim() === "" ? {} : { params: JSON.parse(draft.params) as Record<string, unknown> }),
    ...(draft.maxOutputTokens.trim() === "" ? {} : { max_output_tokens: Number(draft.maxOutputTokens.trim()) }),
    ...(draft.fallback.length === 0
      ? {}
      : {
          fallback: draft.fallback.map((one) => ({
            provider: one.provider,
            ...(one.operation === "" ? {} : { operation: one.operation }),
            model: one.model.trim(),
          })),
        }),
  };
}

/**
 * Presets: v1's custom endpoints. The app calls a preset by its name and
 * sends only the request's content; the preset names the provider, the
 * model, fixed parameters, an output cap and what to try if the call fails.
 */
export function PresetsTab({ app }: { app: App }) {
  const { readOnly } = useConsoleSession();
  const providers = useProviders();
  const { save, pending } = useSaveApp(app);
  const [drafts, setDrafts] = useState(() => draftsOf(app));
  const [refused, setRefused] = useState<Refusal | null>(null);
  useEffect(() => {
    setDrafts(draftsOf(app));
    setRefused(null);
  }, [app.revision]);

  const change = (next: PresetDraft[]) => {
    setDrafts(next);
    setRefused(null);
  };
  const update = (key: number, next: Partial<PresetDraft>) => change(drafts.map((draft) => (draft.key === key ? { ...draft, ...next } : draft)));
  const slugs = drafts.map((draft) => draft.slug);
  const problems = new Map(drafts.map((draft) => [draft.key, presetProblems(draft, slugs)]));
  const valid = [...problems.values()].every((found) => Object.keys(found).length === 0);
  const presets = valid ? Object.fromEntries(drafts.map((draft) => [draft.slug, presetOf(draft)])) : null;
  const schemaProblem = presets === null ? undefined : PresetsConfigSchema.safeParse(presets).error?.issues[0]?.message;
  const dirty = presets === null || JSON.stringify(presets) !== JSON.stringify(app.config.presets ?? {});
  const disabled = readOnly || pending;
  const connections = providers.data?.providers ?? [];

  const submit = async () => {
    if (presets === null) return;
    const { presets: _old, ...rest } = app.config;
    // No presets is the default, so it is left out rather than written.
    const config = Object.keys(presets).length === 0 ? rest : { ...rest, presets };
    await save({ config }, "Presets saved", (error) => setRefused(configIssue(error)));
  };

  /** A refusal about a field of one preset, shown under that field. */
  const refusedAt = (slug: string, field: string): string | undefined => {
    if (!refused) return undefined;
    const where = `presets.${slug}.${field}`;
    return refused.path === where || refused.path.startsWith(`${where}.`) ? refused.message : undefined;
  };
  const refusedElsewhere = refused !== null && !drafts.some((draft) => refused.path.startsWith(`presets.${draft.slug}.`)) ? refused : null;

  if (providers.isPending) return <Skeleton className="h-24 w-full" />;
  if (providers.isError) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>Could not load your providers</AlertTitle>
        <AlertDescription>{providers.error instanceof Error ? providers.error.message : "Try again in a moment."}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        The app calls a preset at <code className="text-xs">/v2/apps/{app.id}/presets/&lt;name&gt;</code>. Each try is one charge; a try
        that fails costs nothing.
      </p>
      {connections.length === 0 ? (
        <Alert>
          <AlertTitle>No providers yet</AlertTitle>
          <AlertDescription>
            <span>
              A preset calls one of your providers. <Link className="underline" to="/providers">Add a provider</Link> first.
            </span>
          </AlertDescription>
        </Alert>
      ) : null}
      {drafts.map((draft) => {
        const found = problems.get(draft.key) ?? {};
        const connection = connections.find((item) => item.slug === draft.provider);
        const operations = connection ? presetOperations(connection) : [];
        const style = declaredOperation(draft.operation)?.style;
        return (
          <Card key={draft.key}>
            <CardContent className="space-y-4">
              <div className="flex items-start justify-between gap-2">
                <Field label="Name" htmlFor={`preset-slug-${draft.key}`} className="flex-1" hint="Lowercase letters, digits and -.">
                  <Input
                    id={`preset-slug-${draft.key}`}
                    value={draft.slug}
                    className="max-w-80 font-mono text-xs"
                    autoComplete="off"
                    disabled={disabled}
                    onChange={(event) => update(draft.key, { slug: event.target.value })}
                  />
                  <Problem>{found.slug}</Problem>
                </Field>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  aria-label={`Remove preset ${draft.slug || "without a name"}`}
                  onClick={() => change(drafts.filter((item) => item.key !== draft.key))}
                >
                  <Trash2 className="size-4" />
                  Remove
                </Button>
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Provider" htmlFor={`preset-provider-${draft.key}`}>
                  <Select
                    value={draft.provider}
                    disabled={disabled}
                    onValueChange={(slug) => {
                      const next = connections.find((item) => item.slug === slug);
                      update(draft.key, { provider: slug, operation: next ? (presetOperations(next)[0] ?? "") : "" });
                    }}
                  >
                    <SelectTrigger id={`preset-provider-${draft.key}`} className="w-full">
                      <SelectValue placeholder="Choose" />
                    </SelectTrigger>
                    <SelectContent>
                      {connections.map((item) => (
                        <SelectItem key={item.slug} value={item.slug}>
                          {item.slug}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Problem>{found.provider ?? refusedAt(draft.slug, "provider")}</Problem>
                </Field>
                <Field label="Operation" htmlFor={`preset-operation-${draft.key}`}>
                  <Select value={draft.operation} disabled={disabled || connection === undefined} onValueChange={(operation) => update(draft.key, { operation })}>
                    <SelectTrigger id={`preset-operation-${draft.key}`} className="w-full">
                      <SelectValue placeholder="Choose" />
                    </SelectTrigger>
                    <SelectContent>
                      {/* A stored operation this build does not list still shows, so it is not lost. */}
                      {[...new Set([...(draft.operation ? [draft.operation] : []), ...operations])].map((name) => (
                        <SelectItem key={name} value={name}>
                          {name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Problem>{found.operation ?? refusedAt(draft.slug, "operation")}</Problem>
                </Field>
                <Field label="Model" htmlFor={`preset-model-${draft.key}`}>
                  <Input
                    id={`preset-model-${draft.key}`}
                    value={draft.model}
                    className="font-mono text-xs"
                    autoComplete="off"
                    disabled={disabled}
                    onChange={(event) => update(draft.key, { model: event.target.value })}
                  />
                  <Problem>{found.model ?? refusedAt(draft.slug, "model")}</Problem>
                </Field>
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Most output tokens" htmlFor={`preset-max-${draft.key}`} hint="Optional.">
                  <Input
                    id={`preset-max-${draft.key}`}
                    inputMode="numeric"
                    value={draft.maxOutputTokens}
                    autoComplete="off"
                    disabled={disabled}
                    onChange={(event) => update(draft.key, { maxOutputTokens: event.target.value })}
                  />
                  <Problem>{found.max_output_tokens ?? refusedAt(draft.slug, "max_output_tokens")}</Problem>
                </Field>
                <Field label="Fixed parameters (JSON)" htmlFor={`preset-params-${draft.key}`} className="sm:col-span-2" hint="Optional. Merged into each request, winning over the app's values.">
                  <Textarea
                    id={`preset-params-${draft.key}`}
                    value={draft.params}
                    placeholder={'{"temperature": 0.2}'}
                    className="min-h-20 font-mono text-xs"
                    spellCheck={false}
                    disabled={disabled}
                    onChange={(event) => update(draft.key, { params: event.target.value })}
                  />
                  <Problem>{found.params ?? refusedAt(draft.slug, "params")}</Problem>
                </Field>
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium">If the call fails</p>
                <p className="text-xs text-muted-foreground">
                  Tried in order when a try gets no answer, a 429 or a 5xx. A fallback must speak the same API as the preset.
                </p>
                {draft.fallback.map((one, index) => {
                  const fallbackConnection = connections.find((item) => item.slug === one.provider);
                  const fallbackOperations = (fallbackConnection ? presetOperations(fallbackConnection) : []).filter(
                    (name) => style === undefined || declaredOperation(name)?.style === style,
                  );
                  const setFallback = (next: Partial<FallbackDraft>) =>
                    update(draft.key, { fallback: draft.fallback.map((item, position) => (position === index ? { ...item, ...next } : item)) });
                  return (
                    <div key={index} className="space-y-1">
                      <div className="flex flex-wrap items-end gap-2">
                        <div className="min-w-36 flex-1 space-y-1.5">
                          <Label htmlFor={`fallback-provider-${draft.key}-${index}`} className="text-xs text-muted-foreground">
                            Provider
                          </Label>
                          <Select value={one.provider} disabled={disabled} onValueChange={(provider) => setFallback({ provider, operation: "" })}>
                            <SelectTrigger id={`fallback-provider-${draft.key}-${index}`} className="w-full">
                              <SelectValue placeholder="Choose" />
                            </SelectTrigger>
                            <SelectContent>
                              {connections.map((item) => (
                                <SelectItem key={item.slug} value={item.slug}>
                                  {item.slug}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="min-w-36 flex-1 space-y-1.5">
                          <Label htmlFor={`fallback-operation-${draft.key}-${index}`} className="text-xs text-muted-foreground">
                            Operation
                          </Label>
                          <Select value={one.operation || "first"} disabled={disabled || fallbackConnection === undefined} onValueChange={(operation) => setFallback({ operation: operation === "first" ? "" : operation })}>
                            <SelectTrigger id={`fallback-operation-${draft.key}-${index}`} className="w-full">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="first">The first that fits</SelectItem>
                              {[...new Set([...(one.operation ? [one.operation] : []), ...fallbackOperations])].map((name) => (
                                <SelectItem key={name} value={name}>
                                  {name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="min-w-36 flex-1 space-y-1.5">
                          <Label htmlFor={`fallback-model-${draft.key}-${index}`} className="text-xs text-muted-foreground">
                            Model
                          </Label>
                          <Input
                            id={`fallback-model-${draft.key}-${index}`}
                            value={one.model}
                            className="font-mono text-xs"
                            autoComplete="off"
                            disabled={disabled}
                            onChange={(event) => setFallback({ model: event.target.value })}
                          />
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Remove fallback ${index + 1}`}
                          disabled={disabled}
                          onClick={() => update(draft.key, { fallback: draft.fallback.filter((_, position) => position !== index) })}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                      <Problem>{refusedAt(draft.slug, `fallback.${index}`)}</Problem>
                    </div>
                  );
                })}
                <Problem>{found.fallback}</Problem>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={disabled || connections.length === 0}
                  onClick={() => update(draft.key, { fallback: [...draft.fallback, { provider: "", operation: "", model: "" }] })}
                >
                  <Plus className="size-4" />
                  Add fallback
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })}
      {drafts.length === 0 ? <p className="text-sm text-muted-foreground">No presets yet.</p> : null}
      <Problem>{schemaProblem}</Problem>
      {refusedElsewhere ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Not saved</AlertTitle>
          <AlertDescription>{refusedElsewhere.message}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={disabled || connections.length === 0}
          onClick={() =>
            change([...drafts, { key: nextKey++, slug: "", provider: "", operation: "", model: "", maxOutputTokens: "", params: "", fallback: [] }])
          }
        >
          <Plus className="size-4" />
          Add preset
        </Button>
        <GuardedButton disabled={!dirty || !valid || schemaProblem !== undefined || pending} onClick={() => void submit()}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          Save presets
        </GuardedButton>
      </div>
    </div>
  );
}
