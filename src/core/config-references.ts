import { supportsEndpointStyle } from "./capabilities";
import type { OrganizationProviders } from "./provider-store";
import { lookup } from "../shared/records";
import { PROVIDER_TYPES } from "./providers";
import { hasModelPrice, isBillable } from "./pricing";
import {
  ConfigError,
  selectedProviderPolicies,
  type AppConfig,
  type EndpointConfig,
  type ProviderPolicy,
} from "../shared/app-config";

export interface ProviderScope {
  instances: OrganizationProviders;
  grandfathered: ReadonlySet<string>;
}

function validateRoutingPrices(
  selected: Record<string, ProviderPolicy>,
  rewrites: Record<string, string>,
  scope: ProviderScope,
): void {
  for (const [source, target] of Object.entries(rewrites)) {
    const priced = PROVIDER_TYPES.some((type) => hasModelPrice(type, target, null))
      || Object.values(scope.instances).some((provider) =>
        isBillable(provider.type, target, provider.pricing));
    if (!priced) {
      throw new ConfigError(
        `routing.model_rewrites.${source} targets model ${target}, which has no configured price`,
      );
    }
  }

  for (const [slug, policy] of Object.entries(selected)) {
    const provider = lookup(scope.instances, slug);
    if (!provider) {
      if (!scope.grandfathered.has(slug)) throw new ConfigError(`Unknown provider instance ${slug}`);
      continue;
    }
    const configured = [
      ...policy.allowed_models.map((model) => ({ model, label: `${slug}.allowed_models` })),
      ...policy.allowed_paths.flatMap((path, index) =>
        typeof path === "string" || path.fixed_model === undefined
          ? []
          : [{ model: path.fixed_model, label: `${slug}.allowed_paths[${index}].fixed_model` }]),
    ];
    for (const item of configured) {
      const resolved = lookup(rewrites, item.model) ?? item.model;
      if (!isBillable(provider.type, resolved, provider.pricing)) {
        throw new ConfigError(
          `${item.label} resolves ${item.model} to ${resolved}, which has no configured price`,
        );
      }
    }
  }
}

function validateTarget(
  target: { provider: string; model: string },
  label: string,
  endpoint: EndpointConfig,
  scope: ProviderScope,
): void {
  const instance = lookup(scope.instances, target.provider);
  if (!instance && !scope.grandfathered.has(target.provider)) {
    throw new ConfigError(`${label}.provider ${target.provider} is not configured`);
  }
  if (!instance) return;
  if (instance.route === null) {
    throw new ConfigError(
      `${label}.provider ${target.provider} is routed through a provider gateway this deployment has no adapter for, so it cannot serve ${endpoint.api_style} endpoints`,
    );
  }
  if (!supportsEndpointStyle(instance.route, instance.type, endpoint.api_style)) {
    throw new ConfigError(
      instance.route === "direct"
        ? `${label}.provider ${target.provider} is a ${instance.type} instance, which does not support ${endpoint.api_style}`
        : `${label}.provider ${target.provider} is a ${instance.type} instance routed through a ${instance.route} gateway, which does not support ${endpoint.api_style}`,
    );
  }
  if (!isBillable(instance.type, target.model, instance.pricing)) {
    throw new ConfigError(
      `${label}.model ${target.model} has no configured price for ${target.provider}`,
    );
  }
}

/** Applies organization-specific reference, route capability, and price checks on management writes. */
export function validateConfigurationReferences(config: AppConfig, scope: ProviderScope): void {
  validateRoutingPrices(
    selectedProviderPolicies(config.routing),
    config.routing.model_rewrites,
    scope,
  );
  for (const [slug, endpoint] of Object.entries(config.endpoints)) {
    validateTarget(endpoint, `endpoints.${slug}`, endpoint, scope);
    for (const [index, fallback] of (endpoint.fallback ?? []).entries()) {
      validateTarget(fallback, `endpoints.${slug}.fallback[${index}]`, endpoint, scope);
    }
  }
}

export function referencedProviderSlugs(config: AppConfig): Set<string> {
  const slugs = new Set<string>();
  for (const slug of Object.keys(selectedProviderPolicies(config.routing))) slugs.add(slug);
  for (const endpoint of Object.values(config.endpoints)) {
    slugs.add(endpoint.provider);
    for (const fallback of endpoint.fallback ?? []) slugs.add(fallback.provider);
  }
  return slugs;
}
