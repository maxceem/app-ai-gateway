import { useState } from "react";
import { Check, ChevronDown, CircleSlash, Plus, Trash2 } from "lucide-react";
import { OUTPUT_CLAMP_STYLES } from "@shared/capabilities";
import { emptyPolicy } from "@shared/app-defaults";
import { defaultInferencePaths } from "@shared/app-config";
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
import { Switch } from "@/components/ui/switch";
import { ProviderIcon } from "@/components/brand-icon";
import { EmptyState, Field } from "@/components/field";
import { StringList } from "@/components/string-list";
import type { AppDraft } from "@/hooks/use-app-draft";
import {
  gatewayLabel,
  instanceModels,
  normalizePath,
  pathObject,
  providerMode,
  selectedSlugs,
  type AllowedPathObject,
  type Provider,
  type ProviderPolicy,
} from "@/lib/config-types";
import { routedSurface } from "@/lib/capabilities";
import { usePrices, useProviderGateways, useProviderInstances } from "@/lib/queries";
import type { ProviderCredential, ProviderGateway } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * What to put after the slug. The path is the provider's own, verbatim, and the
 * OpenAI-compatible batch disagrees about its prefix more than anything else
 * does — so each one says exactly where its chat completions live. Nothing here
 * says which gateways can carry a type: that is the route table's to answer,
 * and a routed instance whose gateway narrows the paths gets its own hint.
 */
const PROVIDER_HINTS: Record<Provider, string> = {
  openai: "Use v1/responses or v1/chat/completions, as the OpenAI SDK does.",
  anthropic: "Use v1/messages, as the Anthropic SDK does.",
  xai: "Use v1/responses or v1/chat/completions.",
  gemini: "Use the native v1beta/models/{model}:generateContent, or the OpenAI-compatible v1beta/openai/chat/completions.",
  perplexity: "Use chat/completions for Sonar models.",
  deepseek: "DeepSeek's base URL has no v1/, so the path is chat/completions.",
  groq: "Groq namespaces its OpenAI API: use openai/v1/chat/completions.",
  mistral: "Use v1/chat/completions.",
  together: "Use v1/chat/completions; models are namespaced, e.g. openai/gpt-oss-120b.",
  fireworks:
    "Use inference/v1/chat/completions. Models are account-scoped (accounts/…/models/…), so price them under custom model pricing.",
  cerebras: "Use v1/chat/completions.",
  moonshot: "Use v1/chat/completions on the international api.moonshot.ai host.",
  huggingface:
    "Use v1/chat/completions on the Inference Providers router. Pin the upstream in the model ID (author/model:provider) — otherwise the router picks one and the price varies with it.",
  baseten: "Use v1/chat/completions on the Model APIs host.",
  bytedance:
    "BytePlus ModelArk's version segment is already in the base URL: the path is chat/completions. Models must be activated in your ModelArk console first.",
  openrouter:
    "Chat completions only. Models are OpenRouter slugs, e.g. google/gemini-3.6-flash, and need no local price: cost is reported by OpenRouter per request.",
};

/**
 * What to put after the slug on a gateway-routed instance whose gateway
 * publishes a URL space of its own: the APIs it carries and where, and the
 * model IDs clients send. Read off the capability the gateway reports on the
 * instance, so it cannot drift from what the backend will actually accept.
 */
function gatewayHint(instance: ProviderCredential, gateways: ProviderGateway[]): string | null {
  if (instance.route === null) {
    return "Its gateway's type is not one this deployment can route, so it serves nothing until it is fixed or deleted.";
  }
  const surface = routedSurface(instance);
  if (!surface || instance.route === "direct") return null;
  const gateway = gateways.find((entry) => entry.id === instance.providerGatewayId);
  const paths = surface.available.map((entry) => `${entry.label} at ${entry.path}`).join(", ");
  return `Routed through ${gateway?.name ?? gatewayLabel(instance.route)}. Only these APIs are available on this route: ${paths}. Models: ${surface.modelIds}.`;
}

/** One row per provider instance; an unknown slug still gets one so it can be removed. */
interface PolicyRow {
  slug: string;
  title: string;
  /** Absent for a slug no instance answers for. */
  type?: Provider;
  /** Where the paths of this instance live, shown beside the path list. */
  hint: string;
  /**
   * The provider-native inference paths "All inference endpoints" allows on
   * this instance beyond the default APIs. Empty where a gateway publishes its
   * own URL space, which carries none of them.
   */
  defaultPaths: readonly string[];
  knownModels: string[];
  /**
   * A paused or deleted instance keeps its full configuration UI — the app is
   * still configured to use it, and hiding that is how a restriction silently
   * goes missing. The badge says which of the two it is; nothing else changes.
   */
  badge?: "disabled" | "deleted";
}

/** The small muted marker on a row whose instance is paused or gone. */
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

type ListMode = "all" | "selected";

const ENDPOINT_MODES: Record<ListMode, string> = {
  all: "All inference endpoints",
  selected: "Selected endpoints",
};

const MODEL_MODES: Record<ListMode, string> = {
  all: "All models",
  selected: "Selected models",
};

/**
 * A labelled dropdown that names a decision and holds its answers. The page
 * asks which providers this way, and each provider asks which endpoints and
 * which models the same way, so there is one control to learn.
 */
function ChoiceField<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: T;
  options: Record<T, string>;
  onChange: (next: T) => void;
}) {
  return (
    <div className="space-y-2 sm:max-w-xs">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={(next) => onChange(next as T)}>
        <SelectTrigger id={id} className="w-full bg-background">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(options) as T[]).map((option) => (
            <SelectItem key={option} value={option}>
              {options[option]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * What a collapsed row says its restrictions are: the three fields in the order
 * the panel shows them, each reduced to its default wording or a count.
 */
export function policySummary(policy: ProviderPolicy): string {
  return [
    policy.allowed_paths.length === 0
      ? "All inference endpoints"
      : count(policy.allowed_paths.length, "endpoint"),
    policy.allowed_models.length === 0
      ? "all models"
      : count(policy.allowed_models.length, "model"),
    policy.max_output_tokens
      ? `up to ${policy.max_output_tokens.toLocaleString("en-US")} output tokens`
      : "no output cap",
  ].join(" · ");
}

/**
 * The restriction fields of one enabled instance, shown when its row is
 * expanded: which endpoints, which models, and an output cap.
 *
 * "Selected" with nothing selected is what "all" means in the configuration,
 * so the two lists are not stored with a mode of their own. An endpoint
 * selection starts with a row to type in, so the rows say which mode the
 * panel is in; a model selection starts empty, so the panel remembers that it
 * was asked for until the first model is added. A list flipped to all is
 * cleared but kept while the panel is open, so flipping back finds it.
 */
function PolicyPanel({
  row,
  config,
  onChange,
}: {
  row: PolicyRow;
  config: ProviderPolicy;
  onChange: (next: ProviderPolicy) => void;
}) {
  const paths = config.allowed_paths.map(pathObject);
  const models = config.allowed_models;
  const [keptPaths, setKeptPaths] = useState<AllowedPathObject[]>([]);
  const [keptModels, setKeptModels] = useState<string[]>([]);
  const [choosingModels, setChoosingModels] = useState(false);
  const endpointMode: ListMode = paths.length > 0 ? "selected" : "all";
  const modelMode: ListMode = models.length > 0 || choosingModels ? "selected" : "all";

  const setPaths = (next: AllowedPathObject[]) =>
    onChange({ ...emptyPolicy(), ...config, allowed_paths: next.map(normalizePath) });

  const setEndpointMode = (next: ListMode) => {
    if (next === endpointMode) return;
    if (next === "all") {
      setKeptPaths(paths);
      setPaths([]);
      return;
    }
    setPaths(keptPaths.length > 0 ? keptPaths : [{ path: "" }]);
  };

  const setModels = (next: string[]) => {
    onChange({ ...config, allowed_models: next });
    // Removing the last model is what "all models" is; the panel says so.
    if (next.length === 0) setChoosingModels(false);
  };

  const setModelMode = (next: ListMode) => {
    if (next === modelMode) return;
    if (next === "all") {
      setKeptModels(models);
      setChoosingModels(false);
      onChange({ ...config, allowed_models: [] });
      return;
    }
    setChoosingModels(true);
    if (keptModels.length > 0) onChange({ ...config, allowed_models: keptModels });
  };

  return (
    <div className="space-y-5 border-t bg-muted/30 px-6 py-4 sm:pl-16">
      <div className="space-y-3">
        <ChoiceField
          id={`${row.slug}-endpoints`}
          label="Endpoints this provider serves"
          value={endpointMode}
          options={ENDPOINT_MODES}
          onChange={setEndpointMode}
        />
        {endpointMode === "selected" ? (
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
                      {OUTPUT_CLAMP_STYLES.map((style) => (
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
                  aria-label="Remove endpoint"
                  onClick={() => setPaths(paths.filter((_, position) => position !== index))}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={() => setPaths([...paths, { path: "" }])}>
              <Plus className="size-3.5" />
              Add endpoint
            </Button>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {row.hint} Listed endpoints replace the defaults, so list every path this app calls.
            </p>
          </div>
        ) : (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Responses, Chat Completions, Anthropic Messages, Gemini generateContent and transcription
            {row.defaultPaths.length > 0 ? (
              <>
                , and{" "}
                {row.defaultPaths.map((path, index) => (
                  <span key={path}>
                    {index > 0 ? ", " : ""}
                    <code className="font-mono">{path}</code>
                  </span>
                ))}
              </>
            ) : null}
            . Other provider operations, such as files, batches or video jobs, need to be listed.
          </p>
        )}
      </div>

      <div className="space-y-3">
        <ChoiceField
          id={`${row.slug}-models`}
          label="Models this provider serves"
          value={modelMode}
          options={MODEL_MODES}
          onChange={setModelMode}
        />
        {modelMode === "selected" ? (
          <StringList
            values={models}
            suggestions={row.knownModels}
            placeholder="gpt-5.6-terra"
            onChange={setModels}
          />
        ) : null}
      </div>

      <Field label="Max output tokens" htmlFor={`${row.slug}-max-output`}>
        <Input
          id={`${row.slug}-max-output`}
          type="number"
          min={1}
          className="max-w-[200px] bg-background"
          value={config.max_output_tokens ?? ""}
          placeholder="No cap"
          onChange={(event) =>
            onChange({
              ...config,
              max_output_tokens: event.target.value ? Number(event.target.value) : undefined,
            })
          }
        />
      </Field>
    </div>
  );
}

/**
 * One instance of the list: its mark, its name and the slug clients call, what
 * it may be asked for in one line, then either the "allowed" mark of all mode
 * or the switch of selected mode. The line reads the same in both modes — in
 * all mode it is the unrestricted policy, which is what all mode grants — so
 * the two lists differ only at their right edge. An enabled row in selected
 * mode can be opened to restrict it.
 */
function ProviderRow({
  row,
  mode,
  config,
  expanded,
  onExpandedChange,
  onChange,
  onEnabledChange,
}: {
  row: PolicyRow;
  mode: "all" | "selected";
  /** Absent while the instance is switched off. */
  config: ProviderPolicy | undefined;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onChange: (next: ProviderPolicy) => void;
  onEnabledChange: (enabled: boolean) => void;
}) {
  const enabled = mode === "all" || config !== undefined;
  const open = mode === "selected" && config !== undefined && expanded;
  const panelId = `policy-${row.slug}`;

  return (
    <li>
      <div className="flex items-center gap-3 px-6 py-3">
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground",
            !enabled && "opacity-60",
          )}
        >
          {row.type ? (
            <ProviderIcon type={row.type} className="size-4" />
          ) : (
            <CircleSlash className="size-4" />
          )}
        </span>
        <div className={cn("min-w-0 flex-1", !enabled && "opacity-60")}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-medium">{row.title}</span>
            <span className="font-mono text-xs text-muted-foreground">/proxy/{row.slug}/…</span>
            {row.badge ? <PolicyStateBadge state={row.badge} /> : null}
          </div>
          {row.badge === "deleted" ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              No provider has this slug any more. Recreate it on the Providers page, or turn this off.
            </p>
          ) : enabled ? (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {policySummary(config ?? emptyPolicy())}
            </p>
          ) : null}
        </div>
        {mode === "all" ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />
            Allowed
          </span>
        ) : (
          <>
            <Switch
              aria-label={`Enable ${row.slug}`}
              checked={config !== undefined}
              onCheckedChange={onEnabledChange}
            />
            <Button
              variant="ghost"
              size="icon"
              className={cn("size-8", config === undefined && "invisible")}
              aria-label={`Restrictions for ${row.slug}`}
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => onExpandedChange(!expanded)}
            >
              <ChevronDown
                className={cn("size-4 transition-transform", open && "rotate-180")}
              />
            </Button>
          </>
        )}
      </div>
      {open && config ? (
        <div id={panelId}>
          <PolicyPanel row={row} config={config} onChange={onChange} />
        </div>
      ) : null}
    </li>
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
    type: instance.type,
    hint: gatewayHint(instance, gateways) ?? PROVIDER_HINTS[instance.type],
    defaultPaths: instance.route !== null && routedSurface(instance) === null
      ? defaultInferencePaths(instance.type).map((entry) => entry.path)
      : [],
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
      hint: "No instance answers for this slug, so no path on it can be served.",
      defaultPaths: [],
      knownModels: [],
      badge: "deleted" as const,
    }));
  return [...known, ...orphans];
}

const MODE_LABELS: Record<ListMode, string> = {
  all: "All providers",
  selected: "Selected providers",
};

export function ProviderAccessTab({ state }: { state: AppDraft }) {
  const proxy = state.draft!.config.routing;
  const mode = providerMode(proxy);
  const policies = proxy.providers.mode === "selected" ? proxy.providers.selected : {};
  const selected = selectedSlugs(proxy);
  /*
   * An instance switched off leaves the draft, which only ever holds the ones
   * that are on. Its policy is kept here instead, for as long as the page is
   * open, so switching it back on restores its restrictions rather than
   * starting over — and a draft switched off and on again is not dirty.
   */
  const [switchedOff, setSwitchedOff] = useState<Record<string, ProviderPolicy>>({});
  /*
   * Likewise for the whole selection: going to "All providers" and back should
   * find the switches and restrictions as they were, not a fresh start.
   */
  const [lastSelected, setLastSelected] = useState<Record<string, ProviderPolicy> | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const instanceList = useProviderInstances();
  const instances = instanceList.data ?? [];
  const gatewayList = useProviderGateways();
  const gateways = gatewayList.data?.gateways ?? [];
  const prices = usePrices();
  const providerPrices = prices.data?.prices;
  const rows = policyRows(instances, gateways, selected, providerPrices);

  const setPolicies = (next: Record<string, ProviderPolicy>) =>
    state.updateProxy({ providers: { mode: "selected", selected: next } });

  const setEnabled = (slug: string, enabled: boolean) => {
    if (enabled) {
      setPolicies({ ...policies, [slug]: switchedOff[slug] ?? emptyPolicy() });
      return;
    }
    const { [slug]: policy, ...rest } = policies;
    if (policy) setSwitchedOff((current) => ({ ...current, [slug]: policy }));
    setPolicies(rest);
  };

  const setMode = (next: ListMode) => {
    if (next === mode) return;
    if (next === "all") {
      setLastSelected(policies);
      state.updateProxy({ providers: { mode: "all" } });
      return;
    }
    // Selecting starts from what "all" was already allowing: every instance
    // the account has, each unrestricted. The app keeps doing exactly what it
    // did, and only what is switched off from here changes anything.
    setPolicies(
      lastSelected
        ?? Object.fromEntries(instances.map((instance) => [instance.slug, emptyPolicy()])),
    );
  };

  return (
    <div className="space-y-4">
      <ChoiceField
        id="provider-access-mode"
        label="Providers this app can call"
        value={mode}
        options={MODE_LABELS}
        onChange={setMode}
      />

      <Card className="gap-0 py-0">
        <CardContent className="px-0">
          {rows.length === 0 ? (
            <div className="px-6 py-5">
              <EmptyState>
                {mode === "all"
                  ? "No providers yet. Add one on the Providers page and this app can use it right away."
                  : "No providers to choose from. Add one on the Providers page, then come back to restrict this app to it."}
              </EmptyState>
            </div>
          ) : (
            <ul className="divide-y">
              {rows.map((row) => (
                <ProviderRow
                  key={row.slug}
                  row={row}
                  mode={mode}
                  config={policies[row.slug]}
                  expanded={expanded[row.slug] ?? false}
                  onExpandedChange={(next) =>
                    setExpanded((current) => ({ ...current, [row.slug]: next }))
                  }
                  onChange={(next) => setPolicies({ ...policies, [row.slug]: next })}
                  onEnabledChange={(enabled) => setEnabled(row.slug, enabled)}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
