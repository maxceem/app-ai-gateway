import type { ReactNode } from "react";
import { ArrowRight, CheckCircle2, Plus, SlidersHorizontal, Trash2 } from "lucide-react";
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
import { EmptyState, Field, SectionHeader } from "@/components/field";
import { StringList } from "@/components/string-list";
import type { AppDraft } from "@/hooks/use-app-draft";
import {
  CLAMP_STYLES,
  PROVIDER_LABELS,
  emptyProvider,
  instanceModels,
  normalizePath,
  pathObject,
  providerMode,
  selectedSlugs,
  type AllowedPathObject,
  type Provider,
  type ProviderConfig,
  type ProviderInstance,
} from "@/lib/config-types";
import { usePrices, useProviderInstances } from "@/lib/queries";

const PROVIDER_HINTS: Record<Provider, string> = {
  openai: "Forwarded with the leading v1/ stripped, matching Cloudflare's provider-native URL.",
  anthropic: "Forwarded with the v1/ prefix retained.",
  xai: "Routed to Cloudflare's grok slug; the tenant path stays /proxy/xai/...",
  gemini: "Use the OpenAI-compatible path v1beta/openai/chat/completions.",
  perplexity: "Routed to Cloudflare's perplexity-ai slug; use chat/completions for Sonar models.",
};

/** One card per provider instance; an unknown slug still gets one so it can be removed. */
interface PolicyRow {
  slug: string;
  title: string;
  description: ReactNode;
  knownModels: string[];
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
          title={row.title}
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
              <Label className="text-sm">Allowed paths</Label>
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
              <EmptyState>Every path is allowed. Add one or more paths to restrict this provider.</EmptyState>
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
            <p className="text-xs text-muted-foreground">
              Leave this list empty to allow every path. A fixed model applies to
              transcription-style routes with no model in the body; it is never injected upstream.
              Leave the output cap style on auto unless the route needs an exception.
            </p>
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
  instances: ProviderInstance[],
  selected: string[],
  prices: Record<Provider, Record<string, unknown>> | undefined,
): PolicyRow[] {
  const known = instances.map((instance) => ({
    slug: instance.slug,
    title: instance.name,
    description: (
      <>
        <span className="font-mono">/proxy/{instance.slug}/…</span> ·{" "}
        {PROVIDER_LABELS[instance.type]} — {PROVIDER_HINTS[instance.type]}
      </>
    ),
    // Includes models only this instance prices: the allowlist is per instance,
    // so suggesting them is exactly as correct as the catalog entries.
    knownModels: instanceModels(instance, prices),
  }));
  const orphans = selected
    .filter((slug) => !instances.some((instance) => instance.slug === slug))
    .map((slug) => ({
      slug,
      title: slug,
      description:
        "This app allows an instance that no longer exists. Turn it off, or recreate it on the Providers page.",
      knownModels: [],
    }));
  return [...known, ...orphans];
}

export function ProxyPolicyTab({ state }: { state: AppDraft }) {
  const proxy = state.draft!.config.routing;
  const mode = providerMode(proxy);
  const selected = selectedSlugs(proxy);
  const instanceList = useProviderInstances();
  const instances = instanceList.data ?? [];
  const prices = usePrices();
  const providerPrices = prices.data?.prices;
  const rewrites = Object.entries(proxy.model_rewrites ?? {});
  const rows = policyRows(instances, selected, providerPrices);

  const setRewrites = (entries: [string, string][]) =>
    state.updateProxy({ model_rewrites: Object.fromEntries(entries.filter(([key]) => key !== "")) });

  const setIndividualConfiguration = (enabled: boolean) => {
    state.updateProxy(
      enabled
        ? {
            providers: {
              mode: "selected",
              // Policy names instance slugs, so the first switch-on starts from
              // an instance this organization actually has.
              selected: instances[0] ? { [instances[0].slug]: emptyProvider() } : {},
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
                  <p className="text-sm font-semibold">Every configured instance is allowed</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    New provider instances, paths, and models are available automatically. Turn on
                    individual configuration only when this application needs restrictions.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {instances.length === 0 ? (
                      <span className="text-xs text-muted-foreground">
                        This organization has no provider instances yet.
                      </span>
                    ) : (
                      instances.map((instance) => (
                        <Badge
                          key={instance.slug}
                          variant="secondary"
                          className="bg-background/75 font-mono text-[11px] font-normal"
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
                  Use the switches below. An enabled instance allows every path and model until you
                  add a restriction, and clients reach it at its own slug.
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

      <Card>
        <CardHeader>
          <SectionHeader
            title="Model rewrites"
            description="Server-side remap applied after the allowlist check, so a target need not be client-allowlisted. Usage records the rewritten model."
            action={
              <Button variant="outline" size="sm" onClick={() => setRewrites([...rewrites, ["", ""]])}>
                <Plus className="size-3.5" />
                Add rewrite
              </Button>
            }
          />
        </CardHeader>
        <CardContent className="space-y-2">
          {rewrites.length === 0 ? (
            <EmptyState>No rewrites. Clients get exactly the model they ask for.</EmptyState>
          ) : (
            rewrites.map(([source, target], index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  value={source}
                  placeholder="gpt-5.6-terra"
                  className="font-mono text-xs"
                  onChange={(event) =>
                    setRewrites(
                      rewrites.map((entry, position) =>
                        position === index ? [event.target.value, entry[1]] : entry,
                      ),
                    )
                  }
                />
                <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
                <div className="flex-1">
                  <Input
                    value={target}
                    placeholder="gpt-5.7"
                    className="font-mono text-xs"
                    onChange={(event) =>
                      setRewrites(
                        rewrites.map((entry, position) =>
                          position === index ? [entry[0], event.target.value] : entry,
                        ),
                      )
                    }
                  />
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Remove rewrite"
                  onClick={() => setRewrites(rewrites.filter((_, position) => position !== index))}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
