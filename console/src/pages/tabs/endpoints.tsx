import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
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
import { EmptyState, Field, SectionHeader } from "@/components/field";
import { DisabledReason } from "@/components/guarded-button";
import { JsonEditor, parseJson } from "@/components/json-editor";
import type { AppDraft } from "@/hooks/use-app-draft";
import {
  ENDPOINT_API_STYLES,
  PROVIDER_LABELS,
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

/** Only OpenAI- and xAI-typed instances compose these request shapes. */
const NO_ELIGIBLE_INSTANCE =
  "Add an OpenAI or xAI provider first — no other instance can serve a named endpoint";
const NO_ELIGIBLE_INSTANCE_ID = "add-endpoint-disabled-reason";

const API_STYLE_HINTS: Record<EndpointConfig["api_style"], string> = {
  responses: "Clients send an OpenAI Responses body. The gateway overwrites the model and deep-merges the parameters below.",
  transcription: "Clients send an OpenAI audio-transcription multipart body and may omit the model field entirely.",
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
      label: `${instance.slug} — ${instance.name} (${PROVIDER_LABELS[instance.type]})`,
    }));
    return value && !instances.some((instance) => instance.slug === value)
      ? [{ slug: value, label: `${value} — not configured` }, ...known]
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
              {option.label}
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

function EndpointCard({
  slug,
  endpoint,
  endpoints,
  appId,
  instances,
  modelsFor,
  onRename,
  onChange,
  onRemove,
}: {
  slug: string;
  endpoint: EndpointConfig;
  endpoints: EndpointsConfig;
  appId: string;
  instances: ProviderInstance[];
  modelsFor: (provider: string) => string[];
  onRename: (next: string) => void;
  onChange: (next: EndpointConfig) => void;
  onRemove: () => void;
}) {
  const slugError = endpointSlugError(slug, endpoints, slug);
  const fallback = endpoint.fallback ?? [];
  // Only openai- and xai-typed instances compose these request shapes, and the
  // eligible set is per style, exactly as the Worker validates it.
  const eligible = endpointInstances(endpoint.api_style, instances);

  const setFallback = (next: EndpointTarget[]) =>
    onChange({ ...endpoint, ...(next.length === 0 ? { fallback: undefined } : { fallback: next }) });

  return (
    <Card>
      <CardHeader>
        <SectionHeader
          title={slug || "New endpoint"}
          description={
            <span className="font-mono">
              POST /v1/apps/{appId}/endpoints/{slug || "<slug>"}
            </span>
          }
          action={
            <Button variant="ghost" size="icon" aria-label={`Remove ${slug}`} onClick={onRemove}>
              <Trash2 className="size-4" />
            </Button>
          }
        />
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex flex-wrap gap-3">
          <Field
            label="Slug"
            className="min-w-[180px] flex-1"
            hint={slugError ? <span className="text-destructive">{slugError}</span> : undefined}
          >
            <Input
              value={slug}
              placeholder="chat"
              className="font-mono text-xs"
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
              <SelectTrigger className="w-full" aria-label="API style">
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
                className="max-w-[200px]"
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
      </CardContent>
    </Card>
  );
}

export function EndpointsTab({ appId, state }: { appId: string; state: AppDraft }) {
  const endpoints = state.draft!.config.endpoints ?? {};
  const entries = Object.entries(endpoints);
  const prices = usePrices();
  const providerPrices = prices.data?.prices;
  const instances = useProviderInstances().data ?? [];
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
  const newEndpoint = () => emptyEndpoint(eligible[0]?.slug);

  const replace = (slug: string, endpoint: EndpointConfig) =>
    state.updateEndpoints({ ...endpoints, [slug]: endpoint });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <SectionHeader
            title="Named endpoints"
            description="A stable slug whose provider, model, parameters, and fallbacks live here instead of in the client. Endpoints ignore the proxy allowlists; this configuration is the policy."
            action={
              eligible.length === 0 ? (
                <DisabledReason reason={NO_ELIGIBLE_INSTANCE} reasonId={NO_ELIGIBLE_INSTANCE_ID}>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled
                    aria-disabled="true"
                    aria-describedby={NO_ELIGIBLE_INSTANCE_ID}
                  >
                    <Plus className="size-3.5" />
                    Add endpoint
                  </Button>
                </DisabledReason>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    state.updateEndpoints({
                      ...endpoints,
                      [nextEndpointSlug(endpoints)]: newEndpoint(),
                    })
                  }
                >
                  <Plus className="size-3.5" />
                  Add endpoint
                </Button>
              )
            }
          />
        </CardHeader>
        {entries.length === 0 ? (
          <CardContent>
            <EmptyState>
              No named endpoints. Clients of this app use the provider proxy directly.
            </EmptyState>
          </CardContent>
        ) : null}
      </Card>

      {entries.map(([slug, endpoint], index) => (
        // Keyed by position so renaming a slug does not remount the card.
        <EndpointCard
          key={index}
          slug={slug}
          endpoint={endpoint}
          endpoints={endpoints}
          appId={appId}
          instances={instances}
          modelsFor={modelsFor}
          onRename={(next) => state.updateEndpoints(renameEndpoint(endpoints, slug, next))}
          onChange={(next) => replace(slug, next)}
          onRemove={() =>
            state.updateEndpoints(
              Object.fromEntries(entries.filter(([name]) => name !== slug)),
            )
          }
        />
      ))}
    </div>
  );
}
