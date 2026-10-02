import { useEffect, useMemo, useState } from "react";
import { ChevronDown, CircleSlash, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ProviderIcon } from "@/components/brand-icon";
import { ENDPOINT_PROVIDER_TYPES } from "@shared/providers";
import { EmptyState, Field } from "@/components/field";
import { DisabledReason } from "@/components/guarded-button";
import { PageAction } from "@/components/page-action";
import { JsonEditor, parseJson } from "@/components/json-editor";
import type { AppDraft } from "@/hooks/use-app-draft";
import {
  ENDPOINT_API_STYLES,
  providerLabel,
  emptyEndpoint,
  endpointInstances,
  endpointSlugError,
  instanceModels,
  nextEndpointSlug,
  renameEndpoint,
  type EndpointConfig,
  type EndpointsConfig,
  type EndpointTarget,
  type ProviderInstance,
} from "@/lib/config-types";
import { usePrices, useProviderInstances } from "@/lib/queries";
import type { ProviderCredential } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Only these provider types compose custom-endpoint request shapes; read off the shared matrix. */
const NO_ELIGIBLE_INSTANCE = `Add a provider of type ${
  new Intl.ListFormat("en", { type: "disjunction" }).format(
    ENDPOINT_PROVIDER_TYPES.map((type) => providerLabel(type)),
  )
} first — no other instance can serve a custom endpoint`;
const NO_ELIGIBLE_INSTANCE_ID = "add-endpoint-disabled-reason";

const API_STYLE_HINTS: Record<EndpointConfig["api_style"], string> = {
  responses: "Clients send an OpenAI Responses body. The gateway overwrites the model and deep-merges the parameters below.",
  audio_transcription: "Clients send an OpenAI audio-transcription multipart body and may omit the model field entirely.",
};

function ModelSelect({
  value,
  models,
  onChange,
  label,
}: {
  value: string;
  models: string[];
  onChange: (model: string) => void;
  label: string;
}) {
  // A model configured before the price catalog knew about it must stay
  // selectable, so the current value is always part of the option list.
  const options = useMemo(
    () => (value && !models.includes(value) ? [value, ...models] : models),
    [models, value],
  );
  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger className="w-full" aria-label={label}>
        <SelectValue placeholder="Select a model" />
      </SelectTrigger>
      <SelectContent>
        {options.length === 0 ? (
          <SelectItem value="__none" disabled>
            No priced models for this provider
          </SelectItem>
        ) : (
          options.map((model) => (
            <SelectItem key={model} value={model} className="font-mono text-xs">
              {model}
            </SelectItem>
          ))
        )}
      </SelectContent>
    </Select>
  );
}

/**
 * Endpoints name a provider *instance* slug, so the options are the
 * organization's own instances whose type can serve this API style. A slug that
 * is no longer configured stays selectable, or editing the endpoint would
 * silently repoint it at another instance.
 */
function ProviderSelect({
  value,
  instances,
  label,
  onChange,
}: {
  value: string;
  instances: ProviderInstance[];
  label: string;
  onChange: (slug: string) => void;
}) {
  const options = useMemo(() => {
    const known = instances.map((instance) => ({
      slug: instance.slug,
      type: instance.type,
      label: `${instance.slug} — ${instance.name} (${providerLabel(instance.type)})`
        + (instance.status === "disabled" ? " (disabled)" : ""),
    }));
    // A slug no instance answers for stays selected and stays listed: the
    // endpoint is configured to use it, and blanking the select would quietly
    // drop that on the next save. It carries no mark either — nothing here
    // knows which provider it named.
    return value && !instances.some((instance) => instance.slug === value)
      ? [{ slug: value, type: null, label: `${value} — not configured` }, ...known]
      : known;
  }, [instances, value]);

  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger className="w-full" aria-label={label}>
        <SelectValue placeholder="Select a provider" />
      </SelectTrigger>
      <SelectContent>
        {options.length === 0 ? (
          <SelectItem value="__none" disabled>
            No provider instance supports this API style
          </SelectItem>
        ) : (
          options.map((option) => (
            <SelectItem key={option.slug} value={option.slug} className="text-xs">
              <span className="inline-flex items-center gap-1.5">
                {option.type ? <ProviderIcon type={option.type} /> : null}
                {option.label}
              </span>
            </SelectItem>
          ))
        )}
      </SelectContent>
    </Select>
  );
}

function ParamsEditor({
  value,
  onChange,
}: {
  value: Record<string, unknown> | undefined;
  onChange: (next: Record<string, unknown> | undefined) => void;
}) {
  const serialized = useMemo(() => JSON.stringify(value ?? {}, null, 2), [value]);
  const [text, setText] = useState(serialized);

  // Adopt outside edits (draft reset, removed cards) but never interrupt typing:
  // a keystroke that parses is pushed upward, so the two stay in agreement.
  useEffect(() => {
    const parsed = parseJson<Record<string, unknown>>(text);
    if (parsed.error || JSON.stringify(parsed.value) !== JSON.stringify(value ?? {})) {
      setText(serialized);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serialized]);

  const parsed = parseJson<Record<string, unknown>>(text);
  const invalid = parsed.error !== null
    || typeof parsed.value !== "object"
    || parsed.value === null
    || Array.isArray(parsed.value);

  return (
    <div className="space-y-2">
      <JsonEditor
        value={text}
        minHeight="120px"
        className="bg-background"
        onChange={(next) => {
          setText(next);
          const result = parseJson<Record<string, unknown>>(next);
          if (
            result.error === null
            && typeof result.value === "object"
            && result.value !== null
            && !Array.isArray(result.value)
          ) {
            onChange(Object.keys(result.value).length === 0 ? undefined : result.value);
          }
        }}
      />
      {invalid ? (
        <p className="text-xs text-destructive">
          {parsed.error ?? "Parameters must be a JSON object"}. The draft keeps the last valid value.
        </p>
      ) : null}
    </div>
  );
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * What a collapsed row says its endpoint does: the style clients speak, the
 * target that serves it, and whatever else the panel would show — a fallback
 * chain and an output cap — reduced to a count or left out when absent.
 */
export function endpointSummary(endpoint: EndpointConfig): string {
  const fallback = endpoint.fallback ?? [];
  return [
    endpoint.api_style,
    `${endpoint.provider || "no provider"} → ${endpoint.model || "no model"}`,
    ...(fallback.length > 0 ? [count(fallback.length, "fallback")] : []),
    ...(endpoint.max_output_tokens
      ? [`up to ${endpoint.max_output_tokens.toLocaleString("en-US")} output tokens`]
      : []),
  ].join(" · ");
}

/**
 * Why a collapsed row cannot be saved as it stands, in the row's own words.
 * Only what the row itself conceals is said here: the slug and the model, the
 * two fields the summary line would otherwise show as fine. Everything else
 * the save button already explains.
 */
function endpointProblem(slug: string, endpoint: EndpointConfig, endpoints: EndpointsConfig) {
  const slugError = endpointSlugError(slug, endpoints, slug);
  if (slugError) return slugError;
  if (!endpoint.model) return "Choose a model";
  if ((endpoint.fallback ?? []).some((target) => !target.model)) return "Choose a model for each fallback";
  return null;
}

/**
 * The fields of one endpoint, shown when its row is expanded: the slug and
 * style, the target, then what the style allows on top of that.
 */
function EndpointPanel({
  slug,
  endpoint,
  endpoints,
  instances,
  modelsFor,
  onRename,
  onChange,
  onRemove,
}: {
  slug: string;
  endpoint: EndpointConfig;
  endpoints: EndpointsConfig;
  instances: ProviderCredential[];
  modelsFor: (provider: string) => string[];
  onRename: (next: string) => void;
  onChange: (next: EndpointConfig) => void;
  onRemove: () => void;
}) {
  const slugError = endpointSlugError(slug, endpoints, slug);
  const fallback = endpoint.fallback ?? [];
  // Only instances whose own route serves this style, as the gateway reports
  // on each one — exactly what it validates on save.
  const eligible = endpointInstances(endpoint.api_style, instances);

  const setFallback = (next: EndpointTarget[]) =>
    onChange({ ...endpoint, ...(next.length === 0 ? { fallback: undefined } : { fallback: next }) });

  return (
    <div className="space-y-5 border-t bg-muted/30 px-6 py-4 sm:pl-16">
      <div className="flex flex-wrap gap-3">
        <Field
          label="Slug"
          className="min-w-[180px] flex-1"
          hint={slugError ? <span className="text-destructive">{slugError}</span> : undefined}
        >
          <Input
            value={slug}
            placeholder="chat"
            className="bg-background font-mono text-xs"
            aria-label="Endpoint slug"
            onChange={(event) => onRename(event.target.value)}
          />
        </Field>
        <Field label="API style" className="min-w-[180px] flex-1">
          <Select
            value={endpoint.api_style}
            onValueChange={(next) =>
              onChange({ ...endpoint, api_style: next as EndpointConfig["api_style"] })
            }
          >
            <SelectTrigger className="w-full bg-background" aria-label="API style">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ENDPOINT_API_STYLES.map((style) => (
                <SelectItem key={style} value={style}>
                  {style}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <p className="text-xs text-muted-foreground">{API_STYLE_HINTS[endpoint.api_style]}</p>

      <div className="flex flex-wrap gap-3">
        <Field label="Provider" className="min-w-[180px] flex-1">
          <ProviderSelect
            label="Provider"
            value={endpoint.provider}
            instances={eligible}
            onChange={(next) => onChange({ ...endpoint, provider: next, model: "" })}
          />
        </Field>
        <Field
          label="Model"
          className="min-w-[220px] flex-[2]"
          hint="Swap this at any time; clients keep calling the same slug. Only models with configured pricing are accepted."
        >
          <ModelSelect
            label="Model"
            value={endpoint.model}
            models={modelsFor(endpoint.provider)}
            onChange={(model) => onChange({ ...endpoint, model })}
          />
        </Field>
      </div>

      {endpoint.api_style === "responses" ? (
        <>
          <Field
            label="Parameters"
            hint="Deep-merged over the client body; the server wins on conflicts. Leave {} for none."
          >
            <ParamsEditor
              value={endpoint.params}
              onChange={(params) => onChange({ ...endpoint, params })}
            />
          </Field>

          <Field
            label="Max output tokens"
            hint="Empty = unrestricted. If set, requests above this are rejected and requests without the field get this value injected."
          >
            <Input
              type="number"
              min={1}
              className="max-w-[200px] bg-background"
              value={endpoint.max_output_tokens ?? ""}
              placeholder="4096"
              onChange={(event) =>
                onChange({
                  ...endpoint,
                  max_output_tokens: event.target.value ? Number(event.target.value) : undefined,
                })
              }
            />
          </Field>
        </>
      ) : null}

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-sm">Fallback chain</Label>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setFallback([...fallback, { provider: endpoint.provider, model: "" }])}
          >
            <Plus className="size-3.5" />
            Add fallback
          </Button>
        </div>
        {fallback.length === 0 ? (
          <EmptyState>No fallback. A failing provider is returned to the client as-is.</EmptyState>
        ) : (
          <div className="space-y-2">
            {fallback.map((target, index) => (
              <div key={index} className="flex flex-wrap items-end gap-2">
                <div className="min-w-[150px] flex-1">
                  <Label className="mb-1.5 text-xs text-muted-foreground">Provider</Label>
                  <ProviderSelect
                    label={`Fallback ${index + 1} provider`}
                    value={target.provider}
                    instances={eligible}
                    onChange={(next) =>
                      setFallback(
                        fallback.map((item, position) =>
                          position === index ? { provider: next, model: "" } : item,
                        ),
                      )
                    }
                  />
                </div>
                <div className="min-w-[200px] flex-[2]">
                  <Label className="mb-1.5 text-xs text-muted-foreground">Model</Label>
                  <ModelSelect
                    label={`Fallback ${index + 1} model`}
                    value={target.model}
                    models={modelsFor(target.provider)}
                    onChange={(model) =>
                      setFallback(
                        fallback.map((item, position) =>
                          position === index ? { ...item, model } : item,
                        ),
                      )
                    }
                  />
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove fallback ${index + 1}`}
                  onClick={() => setFallback(fallback.filter((_, position) => position !== index))}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Tried in order when the provider call fails, rate limits, or returns a server error and
          nothing has been streamed yet. Usage is billed to the target that served the request.
        </p>
      </div>

      {/* Last, apart from the fields: removing is a decision about the row,
          not an edit to it, and the draft's Discard undoes it like any other. */}
      <div className="flex justify-end border-t pt-4">
        <Button
          variant="outline"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={onRemove}
        >
          <Trash2 className="size-3.5" />
          Remove endpoint
        </Button>
      </div>
    </div>
  );
}

/**
 * One endpoint of the list: the mark of the instance it targets, the slug
 * clients call and the URL they call it at, then what it does in one line.
 * The row opens to edit the endpoint in place, the way a provider's row on
 * the Provider access page opens to restrict it, and removing it is done from
 * inside the open row; the draft, and the save bar under it, are the same
 * either way.
 */
function EndpointRow({
  slug,
  endpoint,
  endpoints,
  appId,
  instances,
  modelsFor,
  expanded,
  onExpandedChange,
  onRename,
  onChange,
  onRemove,
}: {
  slug: string;
  endpoint: EndpointConfig;
  endpoints: EndpointsConfig;
  appId: string;
  instances: ProviderCredential[];
  modelsFor: (provider: string) => string[];
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onRename: (next: string) => void;
  onChange: (next: EndpointConfig) => void;
  onRemove: () => void;
}) {
  const instance = instances.find((entry) => entry.slug === endpoint.provider);
  const problem = endpointProblem(slug, endpoint, endpoints);
  const name = slug || "new endpoint";
  const panelId = `endpoint-${slug || "unnamed"}`;

  return (
    <li>
      <div className="flex items-center gap-3 px-6 py-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          {instance ? (
            <ProviderIcon type={instance.type} className="size-4" />
          ) : (
            <CircleSlash className="size-4" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-medium">{slug || "New endpoint"}</span>
            <span className="truncate font-mono text-xs text-muted-foreground">
              POST /v1/apps/{appId}/endpoints/{slug || "<slug>"}
            </span>
            {endpoint.provider && !instance ? (
              <Badge
                variant="outline"
                className="border-muted-foreground/30 text-[11px] font-normal text-muted-foreground"
              >
                provider not configured
              </Badge>
            ) : null}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {endpointSummary(endpoint)}
            {problem ? (
              <>
                {" · "}
                <span className="text-destructive">{problem}</span>
              </>
            ) : null}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={`Edit ${name}`}
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => onExpandedChange(!expanded)}
        >
          <ChevronDown className={cn("size-4 transition-transform", expanded && "rotate-180")} />
        </Button>
      </div>
      {expanded ? (
        <div id={panelId}>
          <EndpointPanel
            slug={slug}
            endpoint={endpoint}
            endpoints={endpoints}
            instances={instances}
            modelsFor={modelsFor}
            onRename={onRename}
            onChange={onChange}
            onRemove={onRemove}
          />
        </div>
      ) : null}
    </li>
  );
}

export function EndpointsTab({ appId, state }: { appId: string; state: AppDraft }) {
  const endpoints = state.draft!.config.endpoints ?? {};
  const entries = Object.entries(endpoints);
  const prices = usePrices();
  const providerPrices = prices.data?.prices;
  const instances = useProviderInstances().data ?? [];
  // Which rows are open, by slug. A row starts closed: the list is for reading
  // what the app serves, and one row opens at a time to change it. A row just
  // added starts open, because it has nothing to read yet.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Catalog prices belong to the provider type, custom ones to the row, so the
  // model list is only knowable per instance slug.
  const bySlug = new Map(instances.map((instance) => [instance.slug, instance]));
  const modelsFor = (provider: string) => {
    const instance = bySlug.get(provider);
    return instance ? instanceModels(instance, providerPrices) : [];
  };
  // A new endpoint has to name an instance that can serve it; with none, there
  // is nothing to create rather than a target that cannot be saved.
  const eligible = endpointInstances("responses", instances);
  // A new endpoint starts on an instance that can actually serve it, so a
  // paused row is only ever the default when there is nothing else.
  const newEndpoint = () => emptyEndpoint(
    (eligible.find((entry) => entry.status !== "disabled") ?? eligible[0])?.slug,
  );

  const replace = (slug: string, endpoint: EndpointConfig) =>
    state.updateEndpoints({ ...endpoints, [slug]: endpoint });

  const add = () => {
    const slug = nextEndpointSlug(endpoints);
    state.updateEndpoints({ ...endpoints, [slug]: newEndpoint() });
    setExpanded((current) => ({ ...current, [slug]: true }));
  };

  // The open state follows the slug it belongs to, so typing a new slug into
  // an open row does not close it.
  const rename = (from: string, to: string) => {
    state.updateEndpoints(renameEndpoint(endpoints, from, to));
    setExpanded(({ [from]: open, ...rest }) => ({ ...rest, [to]: open ?? false }));
  };

  const remove = (slug: string) => {
    state.updateEndpoints(Object.fromEntries(entries.filter(([name]) => name !== slug)));
    setExpanded(({ [slug]: _, ...rest }) => rest);
  };

  return (
    <div className="space-y-4">
      <PageAction>
        {eligible.length === 0 ? (
          <DisabledReason reason={NO_ELIGIBLE_INSTANCE} reasonId={NO_ELIGIBLE_INSTANCE_ID}>
            <Button size="sm" disabled aria-disabled="true" aria-describedby={NO_ELIGIBLE_INSTANCE_ID}>
              <Plus className="size-4" />
              Add endpoint
            </Button>
          </DisabledReason>
        ) : (
          <Button size="sm" onClick={add}>
            <Plus className="size-4" />
            Add endpoint
          </Button>
        )}
      </PageAction>

      <Card className="gap-0 py-0">
        <CardContent className="px-0">
          {entries.length === 0 ? (
            <div className="px-6 py-5">
              <EmptyState>
                No custom endpoints. Clients of this app call the provider proxy directly.
              </EmptyState>
            </div>
          ) : (
            <ul className="divide-y">
              {entries.map(([slug, endpoint], index) => (
                // Keyed by position so renaming a slug does not remount the row.
                <EndpointRow
                  key={index}
                  slug={slug}
                  endpoint={endpoint}
                  endpoints={endpoints}
                  appId={appId}
                  instances={instances}
                  modelsFor={modelsFor}
                  expanded={expanded[slug] ?? false}
                  onExpandedChange={(next) =>
                    setExpanded((current) => ({ ...current, [slug]: next }))
                  }
                  onRename={(next) => rename(slug, next)}
                  onChange={(next) => replace(slug, next)}
                  onRemove={() => remove(slug)}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
