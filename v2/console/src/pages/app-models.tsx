/**
 * An app's model rewrites and presets, as v1's console edited them, each a
 * form with one save. Both live in the app configuration, and every other
 * part of it is sent back as it was read.
 */
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
import { useProviders } from "@/lib/queries";
import { StaleDraftNotice } from "@/components/stale-draft-notice";
import { Problem } from "@/components/problem";
import { usePatchForm } from "@/lib/save-app";
import { LeaveGuard } from "@/components/leave-guard";
import type { App, ProviderConnection } from "@/lib/types";
import { PRESET_SLUG_PATTERN, PresetsConfigSchema, RoutingConfigSchema, type Preset } from "@contracts/app-config";
import { sameJson } from "@contracts/canonical-json";
import { CUSTOM_PROVIDER_TYPE, customDescription } from "@providers/custom";
import { BUILT_IN_PROVIDERS } from "@providers/index";
import type { ProviderDescription } from "@providers/operation";
import { declaredOperation, presetOperationProblem, presetShape } from "@providers/presets";

// ---------------------------------------------------------------------------
// Model rewrites

type RewriteRow = { from: string; to: string };
type Rewrites = Record<string, string> | undefined;

const readRewrites = (app: App): Rewrites => app.config.routing.model_rewrites;
const rowsOf = (stored: Rewrites): RewriteRow[] => Object.entries(stored ?? {}).map(([from, to]) => ({ from, to }));
const mapOf = (rows: RewriteRow[]): Rewrites =>
  rows.length === 0 ? undefined : Object.fromEntries(rows.map((row) => [row.from.trim(), row.to.trim()]));

/** What is wrong with the rows, if anything, in words: the form's own rules, then the contract's. */
export function rewriteProblem(rows: RewriteRow[]): string | undefined {
  if (rows.some((row) => row.from.trim() === "" || row.to.trim() === "")) return "Fill in both models on every row, or remove the row.";
  const seen = new Set<string>();
  for (const row of rows) {
    const source = row.from.trim();
    if (seen.has(source)) return `${source} is rewritten twice. Keep one row for it.`;
    seen.add(source);
  }
  const parsed = RoutingConfigSchema.shape.model_rewrites.safeParse(mapOf(rows));
  if (parsed.success) return undefined;
  const issue = parsed.error.issues[0];
  const where = issue?.path[0] === undefined ? "" : `${String(issue.path[0])}: `;
  return `${where}${issue?.message ?? "is not valid"}`;
}

/**
 * Model rewrites: the model a request names, and the model it is sent and
 * billed as. One step only: a rewrite's target is never rewritten again.
 */
export function RewritesTab({ app }: { app: App }) {
  const { readOnly } = useConsoleSession();
  const form = usePatchForm<Rewrites, RewriteRow[]>(app, "/config/routing/model_rewrites", readRewrites, { toDraft: rowsOf, toStored: mapOf });
  const rows = form.draft;
  const change = form.setDraft;
  const problem = rewriteProblem(rows);
  const disabled = readOnly || form.pending;

  return (
    <Card>
      <LeaveGuard dirty={form.dirty} />
      <CardHeader>
        <CardTitle className="text-sm">Model rewrites</CardTitle>
        <CardDescription>
          Send a request for one model to another, for every call of this app. The app may ask for the model on the left, and is
          sent and billed as the model on the right. Presets name their models themselves and are not rewritten.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {form.stale ? <StaleDraftNotice onDiscard={form.discard} /> : null}
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
        <Problem>{form.refused?.message}</Problem>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => change([...rows, { from: "", to: "" }])}>
            <Plus className="size-4" />
            Add rewrite
          </Button>
          <GuardedButton
            size="sm"
            disabled={!form.dirty || form.stale || problem !== undefined || form.pending}
            onClick={() => void form.save("Rewrites saved")}
          >
            {form.pending ? <Loader2 className="size-4 animate-spin" /> : null}
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
  /** The stored fallback this row edits, kept whole so fields the form does not show survive. */
  original: Record<string, unknown> | null;
  provider: string;
  operation: string;
  model: string;
}

interface PresetDraft {
  /** Which card this is while its name is edited. */
  key: number;
  /** The stored preset this card edits, kept whole, or null for a new one. */
  original: Record<string, unknown> | null;
  slug: string;
  provider: string;
  operation: string;
  model: string;
  maxOutputTokens: string;
  params: string;
  fallback: FallbackDraft[];
  /** The name it was stored under, or null for a new one. */
  originalSlug: string | null;
}

/**
 * Whether a card is new or saves as something other than what is stored:
 * only those meet their operation's rules, as the gateway judges only new or
 * changed presets. Compared as saved, so reformatted parameters alone are no change.
 */
function isChanged(draft: PresetDraft): boolean {
  if (draft.original === null || draft.slug !== draft.originalSlug) return true;
  try {
    return !sameJson(presetsOf([draft])?.[draft.slug], draft.original);
  } catch {
    // Parameters that do not parse are a change; their own problem says so.
    return true;
  }
}

type Presets = Record<string, Preset> | undefined;

/** Keys for cards added in this form; stored ones are keyed by position, so the same app reads the same drafts. */
let nextKey = 1_000_000;

const textOf = (value: unknown) => (value === undefined ? "" : JSON.stringify(value, null, 2));

function draftsOf(stored: Presets): PresetDraft[] {
  return Object.entries(stored ?? {}).map(([slug, preset], index) => ({
    key: index,
    original: preset as unknown as Record<string, unknown>,
    originalSlug: slug,
    slug,
    provider: preset.provider,
    operation: preset.operation,
    model: preset.model,
    maxOutputTokens: preset.max_output_tokens === undefined ? "" : String(preset.max_output_tokens),
    params: textOf(preset.params),
    fallback: (preset.fallback ?? []).map((one) => ({
      original: one as unknown as Record<string, unknown>,
      provider: one.provider,
      operation: one.operation ?? "",
      model: one.model,
    })),
  }));
}

/** A row's field, written onto a copy of what was stored only when it moved. */
function edited(target: Record<string, unknown>, key: string, value: unknown) {
  if (value === undefined) delete target[key];
  else target[key] = value;
}

/**
 * The stored presets the drafts save as. Each preset and fallback starts from
 * a copy of the stored object, and only the fields the person changed are
 * written, so a field this console does not show, or a stored empty list,
 * stays as it was. Call only for drafts with no problems.
 */
function presetsOf(drafts: PresetDraft[]): Presets {
  if (drafts.length === 0) return undefined;
  return Object.fromEntries(
    drafts.map((draft) => {
      const original = draft.original ?? {};
      const preset = structuredClone(original);
      preset.provider = draft.provider;
      preset.operation = draft.operation;
      preset.model = draft.model.trim();
      if (draft.maxOutputTokens !== (original.max_output_tokens === undefined ? "" : String(original.max_output_tokens))) {
        edited(preset, "max_output_tokens", draft.maxOutputTokens.trim() === "" ? undefined : Number(draft.maxOutputTokens.trim()));
      }
      if (draft.params !== textOf(original.params)) {
        edited(preset, "params", draft.params.trim() === "" ? undefined : (JSON.parse(draft.params) as unknown));
      }
      const fallback = draft.fallback.map((one) => {
        const row = structuredClone(one.original ?? {});
        row.provider = one.provider;
        edited(row, "operation", one.operation === "" ? undefined : one.operation);
        row.model = one.model.trim();
        return row;
      });
      // Without fallbacks: a preset that had none keeps having none, a stored empty list stays as it was, and removing every row removes the list.
      const stored = original.fallback;
      edited(preset, "fallback", fallback.length > 0 ? fallback : Array.isArray(stored) && stored.length === 0 ? stored : undefined);
      return [draft.slug, preset as unknown as Preset];
    }),
  );
}

/**
 * The operations of a connection a preset may use: a call measured from its
 * answer, a POST, naming its model where the preset can set it. The gateway
 * checks the rest when the preset is saved.
 */
export function presetOperations(connection: { type: string; baseUrl?: string | null; passthrough?: ProviderConnection["passthrough"] }): string[] {
  const description = describe(connection);
  if (description === null) return [];
  // The gateway's own rule (`presetOperationProblem`), on the operations at the paths this connection really has.
  const names = description.operations.filter((operation) => presetOperationProblem(description, operation) === null).map((operation) => operation.name);
  return [...new Set(names)];
}

/**
 * A connection's description, as the gateway builds it: a built-in type's
 * own, or a custom provider's from its base URL and listed paths. The key
 * header does not change which operations it has, so a stand-in is used.
 */
function describe(connection: { type: string; baseUrl?: string | null; passthrough?: ProviderConnection["passthrough"] }): ProviderDescription | null {
  if (Object.hasOwn(BUILT_IN_PROVIDERS, connection.type)) return BUILT_IN_PROVIDERS[connection.type]!;
  if (connection.type !== CUSTOM_PROVIDER_TYPE || !connection.baseUrl) return null;
  return customDescription({ baseUrl: connection.baseUrl, auth: { header: "authorization", format: "{key}" }, paths: connection.passthrough ?? [] });
}

/** Whether a parsed value holds a number JSON cannot carry: one too large, which reads as Infinity and would be sent as null. */
function hasNonFinite(value: unknown): boolean {
  if (typeof value === "number") return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some(hasNonFinite);
  if (typeof value === "object" && value !== null) return Object.values(value).some(hasNonFinite);
  return false;
}

/** What is wrong with one preset draft, by field, in words: the form's own rules, and the chosen operation's. */
function presetProblems(draft: PresetDraft, slugs: string[], connections: ProviderConnection[]): Record<string, string> {
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
      else if (hasNonFinite(parsed)) problems.params = "A number is too large to send, such as 1e400. Use a smaller one.";
    } catch {
      problems.params = "Not valid JSON.";
    }
  }
  draft.fallback.forEach((one, index) => {
    if (one.provider === "" || one.model.trim() === "") problems[`fallback.${index}`] = "Choose a provider and name the model.";
  });
  // The gateway's own shape rules (`presetShape`), for a new or changed preset only, as the gateway judges them.
  if (Object.keys(problems).length > 0 || !isChanged(draft)) return problems;
  const preset = presetsOf([draft])![draft.slug]!;
  const shape = presetShape(preset, (slug) => {
    const connection = connections.find((item) => item.slug === slug);
    return connection === undefined ? null : { type: connection.type, description: describe(connection) };
  });
  if (!shape.ok) {
    const [first, position] = shape.path.split(".");
    problems[first === "fallback" ? `fallback.${position}` : (first ?? "operation")] = shape.message;
  }
  return problems;
}

/**
 * Presets: v1's custom endpoints. The app calls a preset by its name and
 * sends only the request's content; the preset names the provider, the
 * model, fixed parameters, an output cap and what to try if the call fails.
 */
export function PresetsTab({ app }: { app: App }) {
  const { readOnly } = useConsoleSession();
  const providers = useProviders();
  const form = usePatchForm<Presets, PresetDraft[]>(app, "/config/presets", (from) => from.config.presets, { toDraft: draftsOf, toStored: presetsOf });
  const drafts = form.draft;
  const change = form.setDraft;
  const refused = form.refused;
  const update = (key: number, next: Partial<PresetDraft>) => change(drafts.map((draft) => (draft.key === key ? { ...draft, ...next } : draft)));
  const connections = providers.data?.providers ?? [];
  const slugs = drafts.map((draft) => draft.slug);
  const problems = new Map(drafts.map((draft) => [draft.key, presetProblems(draft, slugs, connections)]));
  // The contract's own rules, each said under the field it is about. Fields this console does not
  // know, which a newer gateway may have written, are sent back as stored and left to the gateway.
  let schemaProblem: string | undefined;
  if ([...problems.values()].every((found) => Object.keys(found).length === 0)) {
    for (const issue of PresetsConfigSchema.safeParse(presetsOf(drafts) ?? {}).error?.issues ?? []) {
      if (issue.code === "unrecognized_keys") continue;
      const [slug, field, position] = issue.path.map(String);
      const owner = drafts.find((draft) => draft.slug === slug);
      const where = field === "fallback" && position !== undefined ? `fallback.${position}` : field;
      const found = owner === undefined || where === undefined ? undefined : problems.get(owner.key);
      if (found !== undefined && where !== undefined) found[where] ??= issue.message;
      else schemaProblem ??= issue.message;
    }
  }
  const valid = [...problems.values()].every((found) => Object.keys(found).length === 0) && schemaProblem === undefined;
  const disabled = readOnly || form.pending;

  const submit = async () => {
    if (!valid) return;
    await form.save("Presets saved");
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
      <LeaveGuard dirty={form.dirty} />
      {form.stale ? <StaleDraftNotice onDiscard={form.discard} /> : null}
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
                      const offered = next ? presetOperations(next) : [];
                      // The chosen operation stays when the new provider has it too; otherwise the person chooses one, never another API picked for them.
                      update(draft.key, { provider: slug, operation: offered.includes(draft.operation) ? draft.operation : "" });
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
                          {/* A named operation is kept as it is: where the new provider does not offer it, the row says so and
                              Save waits for a choice, and going back to the first provider finds it unchanged. */}
                          <Select value={one.provider} disabled={disabled} onValueChange={(provider) => setFallback({ provider })}>
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
                      <Problem>{found[`fallback.${index}`] ?? refusedAt(draft.slug, `fallback.${index}`)}</Problem>
                    </div>
                  );
                })}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={disabled || connections.length === 0}
                  onClick={() => update(draft.key, { fallback: [...draft.fallback, { original: null, provider: "", operation: "", model: "" }] })}
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
            change([...drafts, { key: nextKey++, original: null, slug: "", provider: "", operation: "", model: "", maxOutputTokens: "", params: "", fallback: [], originalSlug: null }])
          }
        >
          <Plus className="size-4" />
          Add preset
        </Button>
        <GuardedButton disabled={!form.dirty || form.stale || !valid || form.pending} onClick={() => void submit()}>
          {form.pending ? <Loader2 className="size-4 animate-spin" /> : null}
          Save presets
        </GuardedButton>
      </div>
    </div>
  );
}
