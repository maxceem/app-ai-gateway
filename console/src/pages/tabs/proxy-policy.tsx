import { useState, type ReactNode } from "react";
import { ArrowRight, CheckCircle2, Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import { DEFAULT_PROXY_API_STYLES } from "@shared/capabilities";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ProviderName } from "@/components/brand-icon";
import { EmptyState, Field, SectionHeader } from "@/components/field";
import { StringList } from "@/components/string-list";
import type { AppDraft } from "@/hooks/use-app-draft";
import {
  CLAMP_STYLES,
  emptyProvider,
  instanceModels,
  normalizePath,
  pathObject,
  providerMode,
  selectedSlugs,
  type AllowedPathObject,
  type Provider,
  type ProviderConfig,
} from "@/lib/config-types";
import { API_STYLE_LABELS, gatewayApiSurface } from "@/lib/capabilities";
import { usePrices, useProviderGateways, useProviderInstances } from "@/lib/queries";
import type { ProviderCredential, ProviderGateway } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * What to put after the slug. The path is the provider's own, verbatim, and the
 * OpenAI-compatible batch disagrees about its prefix more than anything else
 * does — so each one says exactly where its chat completions live.
 */
const PROVIDER_HINTS: Record<Provider, string> = {
  openai: "Forwarded with the leading v1/ stripped, matching Cloudflare's provider-native URL.",
  anthropic: "Forwarded with the v1/ prefix retained.",
  xai: "Routed to Cloudflare's grok slug; the tenant path stays /proxy/xai/...",
  gemini: "Use the OpenAI-compatible path v1beta/openai/chat/completions.",
  perplexity: "Routed to Cloudflare's perplexity-ai slug; use chat/completions for Sonar models.",
  deepseek: "Direct only. DeepSeek's base URL has no v1/, so the path is chat/completions.",
  groq: "Direct only. Groq namespaces its OpenAI API: use openai/v1/chat/completions.",
  mistral: "Direct only. Use v1/chat/completions.",
  together: "Direct only. Use v1/chat/completions; models are namespaced, e.g. openai/gpt-oss-120b.",
  fireworks:
    "Direct only. Use inference/v1/chat/completions. Models are account-scoped (accounts/…/models/…), so price them under custom model pricing.",
  cerebras: "Direct only. Use v1/chat/completions.",
  moonshot: "Direct only. Use v1/chat/completions on the international api.moonshot.ai host.",
  huggingface:
    "Direct only. Use v1/chat/completions on the Inference Providers router. Pin the upstream in the model ID (author/model:provider) — otherwise the router picks one and the price varies with it.",
  baseten: "Direct only. Use v1/chat/completions on the Model APIs host.",
  bytedance:
    "Direct only. BytePlus ModelArk's version segment is already in the base URL: the path is chat/completions. Models must be activated in your ModelArk console first.",
  openrouter:
    "Direct only, chat completions only. Models are OpenRouter slugs, e.g. google/gemini-3.6-flash, and need no local price: cost is reported by OpenRouter per request.",
};

/**
 * What to put after the slug on a gateway-routed instance, which the gateway
 * decides rather than the provider: one URL space for every provider it serves,
 * and canonical model IDs whichever route they take. Derived from the capability
 * matrix, so it cannot drift from what the backend will actually accept.
 */
function gatewayHint(instance: ProviderCredential, gateways: ProviderGateway[]): string | null {
  if (instance.providerGatewayId === null) return null;
  const gateway = gateways.find((entry) => entry.id === instance.providerGatewayId);
  const surface = gateway ? gatewayApiSurface(gateway.type, instance.type) : null;
  // A gateway that forwards to the provider's own API keeps the provider's own
  // hint; only a gateway with a URL space of its own replaces it.
  if (!surface?.narrowed) return null;
  const paths = surface.available.map((entry) => `${entry.label} at ${entry.path}`).join(", ");
  const missing = surface.unavailable.length > 0
    ? ` Not available on this route: ${surface.unavailable.map((entry) => entry.label).join(", ")}.`
    : "";
  return `Routed through ${gateway!.name}: ${paths}.${missing} Models: ${surface.modelIds}.`;
}

/** One card per provider instance; an unknown slug still gets one so it can be removed. */
interface PolicyRow {
  slug: string;
  title: string;
  description: ReactNode;
  knownModels: string[];
  /**
   * A paused or deleted instance keeps its full configuration UI — the app is
   * still configured to use it, and hiding that is how a restriction silently
   * goes missing. The badge says which of the two it is; nothing else changes.
   */
  badge?: "disabled" | "deleted";
}

/** The small muted marker on a card whose instance is paused or gone. */
function PolicyStateBadge({ state }: { state: "disabled" | "deleted" }) {
  return (
    <Badge
      variant="outline"
      className="border-muted-foreground/30 text-[11px] font-normal text-muted-foreground"
    >
      {state}
    </Badge>
  );
}

/** The empty allowlist's complete policy, kept visual and scannable. */
function DefaultApiBadges() {
  return (
    <div className="flex flex-wrap justify-center gap-1.5">
      {DEFAULT_PROXY_API_STYLES.map((style) => (
        <Badge
          key={style}
          variant="secondary"
          className="bg-background/80 text-[11px] font-normal text-foreground shadow-sm ring-1 ring-border/70"
        >
          {API_STYLE_LABELS[style]}
        </Badge>
      ))}
    </div>
  );
}

function ProviderCard({
  row,
  config,
  onChange,
}: {
  row: PolicyRow;
  config: ProviderConfig | undefined;
  onChange: (next: ProviderConfig | undefined) => void;
}) {
  const paths = (config?.allowed_paths ?? []).map(pathObject);
  const knownModels = row.knownModels;

  const setPaths = (next: AllowedPathObject[]) =>
    onChange({ ...emptyProvider(), ...config, allowed_paths: next.map(normalizePath) });

  return (
    <Card>
      <CardHeader>
        <SectionHeader
          title={
            <span className="flex items-center gap-2">
              {row.title}
              {row.badge ? <PolicyStateBadge state={row.badge} /> : null}
            </span>
          }
          description={row.description}
          action={
            <Switch
              aria-label={`Enable ${row.slug}`}
              checked={config !== undefined}
              onCheckedChange={(checked) => onChange(checked ? emptyProvider() : undefined)}
            />
          }
        />
      </CardHeader>
      {config ? (
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Label className="text-sm">Allowed paths</Label>
                {paths.length > 0 ? (
                  <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">
                    Only listed paths
                  </Badge>
                ) : null}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPaths([...paths, { path: "" }])}
              >
                <Plus className="size-3.5" />
                Add path
              </Button>
            </div>
            {paths.length === 0 ? (
              <EmptyState>
                <div className="space-y-3">
                  <p className="font-medium text-foreground">Inference APIs are allowed by default</p>
                  <DefaultApiBadges />
                  <p className="text-xs">Add paths to allow only those.</p>
                </div>
              </EmptyState>
            ) : (
              <div className="space-y-2">
                {paths.map((entry, index) => (
                  <div key={index} className="flex flex-wrap items-end gap-2">
                    <div className="min-w-[200px] flex-[2]">
                      <Label className="mb-1.5 text-xs text-muted-foreground">Path</Label>
                      <Input
                        value={entry.path}
                        placeholder="v1/responses"
                        className="font-mono text-xs"
                        onChange={(event) =>
                          setPaths(
                            paths.map((item, position) =>
                              position === index ? { ...item, path: event.target.value } : item,
                            ),
                          )
                        }
                      />
                    </div>
                    <div className="min-w-[150px] flex-1">
                      <Label className="mb-1.5 text-xs text-muted-foreground">Fixed model</Label>
                      <Input
                        value={entry.fixed_model ?? ""}
                        placeholder="none"
                        className="font-mono text-xs"
                        onChange={(event) =>
                          setPaths(
                            paths.map((item, position) =>
                              position === index
                                ? { ...item, fixed_model: event.target.value || undefined }
                                : item,
                            ),
                          )
                        }
                      />
                    </div>
                    <div className="w-[170px]">
                      <Label className="mb-1.5 text-xs text-muted-foreground">Output cap style</Label>
                      <Select
                        value={entry.clamp ?? "auto"}
                        onValueChange={(next) =>
                          setPaths(
                            paths.map((item, position) =>
                              position === index
                                ? {
                                    ...item,
                                    clamp: next === "auto" ? undefined : (next as AllowedPathObject["clamp"]),
                                  }
                                : item,
                            ),
                          )
                        }
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="auto">auto (by body)</SelectItem>
                          {CLAMP_STYLES.map((style) => (
                            <SelectItem key={style} value={style}>
                              {style}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Remove path"
                      onClick={() => setPaths(paths.filter((_, position) => position !== index))}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            {paths.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                A fixed model applies to transcription-style routes with no model in the body; it
                is never injected upstream. Leave the output cap style on auto unless the route
                needs an exception.
              </p>
            ) : null}
          </div>

          <Field
            label="Allowed models"
            hint="Leave empty to allow every model with configured pricing. A non-empty list restricts this provider; rewrites are resolved before pricing is checked."
          >
            <StringList
              values={config.allowed_models ?? []}
              suggestions={knownModels}
              placeholder="gpt-5.6-terra"
              onChange={(next) => onChange({ ...config, allowed_models: next })}
            />
          </Field>

          <Field
            label="Max output tokens"
            hint="Empty = unrestricted. If set, requests above this are rejected; requests without an output-limit parameter get this value injected. Transcription routes ignore this cap."
          >
            <Input
              type="number"
              min={1}
              className="max-w-[200px]"
              value={config.max_output_tokens ?? ""}
              placeholder="8192"
              onChange={(event) =>
                onChange({
                  ...config,
                  max_output_tokens: event.target.value ? Number(event.target.value) : undefined,
                })
              }
            />
          </Field>
        </CardContent>
      ) : null}
    </Card>
  );
}

/** Instances first, then any slug the config names that no longer resolves. */
function policyRows(
  instances: ProviderCredential[],
  gateways: ProviderGateway[],
  selected: string[],
  prices: Record<Provider, Record<string, unknown>> | undefined,
): PolicyRow[] {
  const known = instances.map((instance) => ({
    slug: instance.slug,
    title: instance.name,
    description: (
      <>
        <span className="font-mono">/proxy/{instance.slug}/…</span> ·{" "}
        <ProviderName type={instance.type} className="align-middle" /> —{" "}
        {gatewayHint(instance, gateways) ?? PROVIDER_HINTS[instance.type]}
      </>
    ),
    // Includes models only this instance prices: the allowlist is per instance,
    // so suggesting them is exactly as correct as the catalog entries.
    knownModels: instanceModels(instance, prices),
    ...(instance.status === "disabled" ? { badge: "disabled" as const } : {}),
  }));
  const orphans = selected
    .filter((slug) => !instances.some((instance) => instance.slug === slug))
    .map((slug) => ({
      slug,
      title: slug,
      description:
        "No instance answers for this slug. Recreate it on the Providers page, or turn this off.",
      knownModels: [],
      badge: "deleted" as const,
    }));
  return [...known, ...orphans];
}

/** One editable line of the rewrite card, which a half-typed row can also be. */
type RewriteRow = [source: string, target: string];

/** The rows a rewrite map can actually hold: both sides filled in. */
const completeRewrites = (rows: RewriteRow[]) =>
  rows.filter(([source, target]) => source !== "" && target !== "");

const asRewriteMap = (rows: RewriteRow[]) => Object.fromEntries(completeRewrites(rows));

/**
 * The rewrite editor, one row per remap.
 *
 * Rows are held here rather than in the draft because the draft stores a map,
 * and a row being typed is not yet a map entry: it has no key until a source is
 * given, and the Worker refuses an entry whose target is empty. Committing rows
 * straight to the map is what used to make "Add rewrite" look broken — the new
 * blank row was dropped on the way in, so the map never changed and no row
 * appeared. So only complete rows are committed, and the incomplete one stays
 * on screen until it is finished.
 */
function ModelRewrites({
  rewrites,
  onChange,
}: {
  rewrites: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  const [rows, setRows] = useState<RewriteRow[]>(() => Object.entries(rewrites));

  /*
   * The draft can also change from outside this card: another app is opened, or
   * the edits are discarded. Rebuild the rows when that happens, but not when
   * the map is merely echoing back what these rows just committed — that would
   * take away the row currently being filled in. Comparing the incoming map
   * against a snapshot keeps the check to once per actual change.
   */
  const incoming = JSON.stringify(rewrites);
  const [synced, setSynced] = useState(incoming);
  if (incoming !== synced) {
    setSynced(incoming);
    if (incoming !== JSON.stringify(asRewriteMap(rows))) setRows(Object.entries(rewrites));
  }

  const update = (next: RewriteRow[]) => {
    setRows(next);
    onChange(asRewriteMap(next));
  };

  const editRow = (index: number, row: RewriteRow) =>
    update(rows.map((entry, position) => (position === index ? row : entry)));

  const incomplete = completeRewrites(rows).length < rows.length;

  return (
    <Card>
      <CardHeader>
        <SectionHeader
          title="Model rewrites"
          description="Server-side remap applied after the allowlist check, so a target need not be client-allowlisted. Usage records the rewritten model."
          action={
            <Button variant="outline" size="sm" onClick={() => update([...rows, ["", ""]])}>
              <Plus className="size-3.5" />
              Add rewrite
            </Button>
          }
        />
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.length === 0 ? (
          <EmptyState>No rewrites. Clients get exactly the model they ask for.</EmptyState>
        ) : (
          rows.map(([source, target], index) => (
            <div key={index} className="flex items-center gap-2">
              {/*
                Both sides carry flex-1 so the row splits evenly. The Input
                primitive is w-full, which as a direct flex child resolves to a
                full-width basis and takes the whole row — leaving a basis-0
                sibling nothing to shrink into.
              */}
              <Input
                value={source}
                aria-label={`Rewrite ${index + 1} source model`}
                placeholder="gpt-5.6-terra"
                className="flex-1 font-mono text-xs"
                onChange={(event) => editRow(index, [event.target.value, target])}
              />
              <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
              <Input
                value={target}
                aria-label={`Rewrite ${index + 1} target model`}
                placeholder="gpt-5.7"
                className="flex-1 font-mono text-xs"
                onChange={(event) => editRow(index, [source, event.target.value])}
              />
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove rewrite ${index + 1}`}
                onClick={() => update(rows.filter((_, position) => position !== index))}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))
        )}
        {incomplete ? (
          <p className="text-xs text-muted-foreground">
            A rewrite is saved once both sides are filled in. A row left half-finished is dropped.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function ProxyPolicyTab({ state }: { state: AppDraft }) {
  const proxy = state.draft!.config.routing;
  const mode = providerMode(proxy);
  const selected = selectedSlugs(proxy);
  const instanceList = useProviderInstances();
  const instances = instanceList.data ?? [];
  const gatewayList = useProviderGateways();
  const gateways = gatewayList.data?.gateways ?? [];
  const prices = usePrices();
  const providerPrices = prices.data?.prices;
  const rows = policyRows(instances, gateways, selected, providerPrices);

  const setIndividualConfiguration = (enabled: boolean) => {
    state.updateProxy(
      enabled
        ? {
            providers: {
              mode: "selected",
              // Policy names instance slugs, so the first switch-on starts from
              // an instance this organization actually has — and preferably one
              // that can currently serve, rather than a paused row.
              selected: (() => {
                const seed = instances.find((entry) => entry.status === "active") ?? instances[0];
                return seed ? { [seed.slug]: emptyProvider() } : {};
              })(),
            },
          }
        : { providers: { mode: "all" } },
    );
  };

  return (
    <div className="space-y-4">
      <Card className={mode === "all" ? "border-emerald-500/30" : undefined}>
        <CardHeader>
          <SectionHeader
            title="Provider access"
            description="Choose whether this application can use every provider supported by the gateway or only providers you select."
            action={
              <div className="flex items-center gap-3">
                <Label htmlFor="configure-providers" className="text-xs text-muted-foreground">
                  Configure individually
                </Label>
                <Switch
                  id="configure-providers"
                  aria-label="Configure providers individually"
                  checked={mode === "selected"}
                  onCheckedChange={setIndividualConfiguration}
                />
              </div>
            }
          />
        </CardHeader>
        <CardContent>
          {mode === "all" ? (
            <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] p-4">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/12 text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="size-5" />
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold">Every configured instance is allowed</p>
                    <Badge
                      variant="outline"
                      className="border-emerald-500/30 bg-background/60 text-[10px] font-medium uppercase tracking-wide text-emerald-700 dark:text-emerald-300"
                    >
                      Inference APIs
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    New provider instances and priced models are available automatically. Other
                    provider paths require individual configuration.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {instances.length === 0 ? (
                      <span className="text-xs text-muted-foreground">
                        No provider instances yet.
                      </span>
                    ) : (
                      // A disabled instance is listed but muted: "every
                      // instance" is what the mode means, and which of them is
                      // currently paused is worth seeing without leaving.
                      instances.map((instance) => (
                        <Badge
                          key={instance.slug}
                          variant="secondary"
                          className={cn(
                            "bg-background/75 font-mono text-[11px] font-normal",
                            instance.status === "disabled"
                              && "text-muted-foreground line-through decoration-muted-foreground/50",
                          )}
                          title={
                            instance.status === "disabled"
                              ? `${instance.slug} is disabled and serves no traffic`
                              : undefined
                          }
                        >
                          {instance.slug}
                        </Badge>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-3 rounded-xl bg-muted/45 p-4 ring-1 ring-border/70">
              <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-background text-muted-foreground shadow-sm ring-1 ring-border">
                <SlidersHorizontal className="size-4" />
              </span>
              <div>
                <p className="text-sm font-medium">
                  {selected.length} of {instances.length} provider instances enabled
                </p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Use the switches below. An enabled instance allows inference APIs and every
                  priced model until you add a restriction, and clients reach it at its own slug.
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {mode === "selected" && rows.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState>
              No provider instances to choose from. Add one on the Providers page, then come back to
              restrict this app to it.
            </EmptyState>
          </CardContent>
        </Card>
      ) : null}

      {mode === "selected"
        ? rows.map((row) => (
            <ProviderCard
              key={row.slug}
              row={row}
              config={proxy.providers.selected?.[row.slug]}
              onChange={(next) => state.updateProxy({
                providers: {
                  mode: "selected",
                  selected: { ...proxy.providers.selected, [row.slug]: next },
                },
              })}
            />
          ))
        : null}

      <ModelRewrites
        rewrites={proxy.model_rewrites ?? {}}
        onChange={(model_rewrites) => state.updateProxy({ model_rewrites })}
      />
    </div>
  );
}
