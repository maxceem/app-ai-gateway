import { readFile } from "node:fs/promises";
import { checkOperatorBaseUrl } from "../../src/core/origin-guard.ts";
import {
  HandoffProviderAddPayloadSchema,
  HandoffProviderUpdatePayloadSchema,
  ProviderCreateRequestSchema,
  ProviderGatewayCreateRequestSchema,
  ProviderGatewayUpdateRequestSchema,
  ProviderUpdateRequestSchema,
  type ProviderCreateRequest,
  type ProviderGatewayCreateRequest,
  type ProviderPricing,
  type ProviderUpdateRequest,
} from "../../src/contracts/schemas.ts";
import type {
  CliCapabilitiesResponse,
  CliOperationResponse,
  CliPollResponse,
} from "../../src/contracts/cli.ts";
import type {
  ProviderDeleteResponse,
  ProviderGatewayDeleteResponse,
  ProviderGatewayListResponse,
  ProviderGatewayResponse,
  ProviderGatewaySummary,
  ProviderListResponse,
  ProviderResponse,
  ProviderSummary,
} from "../../src/contracts/responses.ts";
import { fail, validate } from "./common.ts";
import type { Context } from "./context.ts";
import { confirm, prompt, secret } from "./input.ts";
import type { Flags } from "./parser.ts";

/** A provider type as `agw provider types` reports it. */
export type ProviderCapability = CliCapabilitiesResponse["providers"][number];
/** A gateway type, with `cf_aig` spelled the way the `--type` flag takes it. */
export type GatewayCapability = { type: string; name: string };

export type ResourceResult =
  | ProviderCapability[]
  | GatewayCapability[]
  | ProviderListResponse
  | ProviderGatewayListResponse
  | ProviderSummary
  | ProviderGatewaySummary
  | ProviderResponse
  | ProviderGatewayResponse
  | ProviderDeleteResponse
  | ProviderGatewayDeleteResponse
  | CliOperationResponse
  | CliPollResponse;

export async function jsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    fail("invalid_file", `Cannot read valid JSON from ${path}.`);
  }
}

/** Every flag the table declares as taking one string value. */
export type StringFlag = {
  [K in keyof Flags]-?: string extends Flags[K] ? K : never;
}[keyof Flags];

export async function required(
  flags: Flags,
  key: StringFlag,
  label: string = key,
): Promise<string> {
  const value = flags[key];
  return typeof value === "string" ? value : await prompt(label, flags);
}

export async function resolveProvider(ctx: Context, id: string): Promise<ProviderSummary> {
  const { data } = await ctx.call("listProviders");
  const matches = data.providers.filter((p) => p.id === id || p.slug === id);
  if (matches.length !== 1 || !matches[0])
    fail("provider_not_found", "Choose one exact provider ID or slug.");
  return matches[0];
}

export async function resolveGateway(
  ctx: Context,
  id: string,
): Promise<ProviderGatewaySummary> {
  const { data } = await ctx.call("listProviderGateways");
  const value = data.gateways.find((g) => g.id === id);
  if (!value)
    fail("provider_gateway_not_found", "Provider gateway ID was not found.");
  return value;
}

/** A provider create body, before the contract has judged it. */
interface ProviderDraft {
  type: string;
  name: string;
  slug: string;
  providerGatewayId?: string;
  baseUrl?: string;
  pricing?: unknown;
  gatewayRoute?: unknown;
  secret?: string;
}

/** A gateway create body, before its token and the contract have joined it. */
type GatewayDraft =
  | { type: "cf_aig"; name: string; accountId: string; gatewayId: string }
  | { type: "vercel"; name: string };

export async function resourceCommand(
  ctx: Context,
  command: string,
  args: string[],
  flags: Flags,
): Promise<ResourceResult> {
  const [group, action] = command.split(" ");
  const gateway = group === "provider-gateway";
  if (action === "types") {
    const { data } = await ctx.publicCall("getCliCapabilities");
    return gateway
      ? data.providerGateways.map((entry) => ({
          ...entry,
          type: entry.type === "cf_aig" ? "cloudflare" : entry.type,
        }))
      : data.providers;
  }
  if (action === "list")
    return gateway
      ? (await ctx.call("listProviderGateways")).data
      : (await ctx.call("listProviders")).data;

  let existingProvider: ProviderSummary | undefined;
  let existingGateway: ProviderGatewaySummary | undefined;
  const target = args[0];
  if (target) {
    if (gateway) existingGateway = await resolveGateway(ctx, target);
    else existingProvider = await resolveProvider(ctx, target);
  }
  if (action === "show") {
    const found = existingGateway ?? existingProvider;
    if (!found) fail("invalid_arguments", "Supply the resource to show.");
    return found;
  }
  if (action === "remove") {
    if (gateway) {
      if (!existingGateway) fail("invalid_arguments", "Supply the resource to remove.");
      await confirm(
        `Delete ${group} ${existingGateway.name} (${existingGateway.id})? Referenced by ${existingGateway.referencedCount} providers; deletion is refused until all references are removed.`,
        flags,
      );
      return (await ctx.call("deleteProviderGateway", { params: { id: existingGateway.id } })).data;
    }
    if (!existingProvider) fail("invalid_arguments", "Supply the resource to remove.");
    await confirm(
      `Delete ${group} ${existingProvider.name} (${existingProvider.id})? Apps referencing this provider lose access through this slug.`,
      flags,
    );
    return (await ctx.call("deleteProvider", { params: { id: existingProvider.id } })).data;
  }
  if (action === "add") {
    const type = await required(
      flags,
      "type",
      gateway ? "Gateway type (cloudflare or vercel)" : "Provider type",
    );
    if (gateway) {
      if (!["cloudflare", "vercel"].includes(type))
        fail("invalid_input", "Gateway type must be cloudflare or vercel.");
      if (
        type === "vercel" &&
        (flags["cloudflare-account-id"] || flags["gateway-id"])
      )
        fail(
          "conflicting_flags",
          "Vercel gateways do not accept Cloudflare account or gateway IDs.",
        );
      const draft: GatewayDraft =
        type === "cloudflare"
          ? {
              type: "cf_aig",
              name: flags.name ?? "Cloudflare AI Gateway",
              accountId: await required(flags, "cloudflare-account-id"),
              gatewayId: await required(flags, "gateway-id"),
            }
          : { type: "vercel", name: flags.name ?? "Vercel AI Gateway" };
      validate(ProviderGatewayCreateRequestSchema, {
        ...draft,
        token: "validation-placeholder",
      });
      const token = await secret(flags, "Gateway token");
      await assertSupportedType(ctx, true, draft.type);
      let body: ProviderGatewayCreateRequest | undefined;
      if (!flags.browser)
        body = validate(ProviderGatewayCreateRequestSchema, { ...draft, token });
      await ctx.bootstrap();
      if (flags.browser)
        return ctx.operation("provider-gateway.add", { ...draft });
      const created = await ctx.create("createProviderGateway", { body: body! });
      await created.complete();
      return created.data;
    }
    if (
      flags["provider-gateway"] &&
      (flags["base-url"] ||
        flags.browser ||
        flags["key-prompt"] ||
        flags["key-stdin"])
    )
      fail(
        "conflicting_flags",
        "Gateway-backed providers cannot accept a direct key or base URL.",
      );
    const draft: ProviderDraft = {
      type,
      name: flags.name ?? type,
      slug: flags.slug ?? type,
      ...(flags["provider-gateway"]
        ? { providerGatewayId: flags["provider-gateway"] }
        : {}),
    };
    if (flags["base-url"]) {
      const checked = checkOperatorBaseUrl(flags["base-url"]);
      if (!checked.ok) fail("invalid_input", checked.message);
      draft.baseUrl = checked.baseUrl;
    }
    if (flags.pricing) draft.pricing = await jsonFile(flags.pricing);
    if (flags.route) draft.gatewayRoute = await jsonFile(flags.route);
    validate(ProviderCreateRequestSchema, {
      ...draft,
      ...(!draft.providerGatewayId ? { secret: "validation-placeholder" } : {}),
    });
    const value = !draft.providerGatewayId
      ? await secret(flags, `${type} API key`)
      : undefined;
    await assertSupportedType(ctx, false, draft.type);
    if (value) draft.secret = value;
    let body: ProviderCreateRequest | undefined;
    if (!flags.browser) body = validate(ProviderCreateRequestSchema, draft);
    await ctx.bootstrap();
    if (flags.browser)
      return ctx.operation("provider.add", validate(HandoffProviderAddPayloadSchema, draft));
    const created = await ctx.create("createProvider", { body: body! });
    await created.complete();
    return created.data;
  }
  if (action === "rotate-key") {
    if (gateway) {
      if (!existingGateway) fail("invalid_arguments", "Supply the gateway to rotate.");
      const value = await secret(flags, "Gateway token");
      if (flags.browser)
        return ctx.operation("provider-gateway.rotate-key", { id: existingGateway.id, revision: existingGateway.revision });
      return (
        await ctx.call("rotateProviderGateway", {
          params: { id: existingGateway.id },
          body: { token: value!, revision: existingGateway.revision },
        })
      ).data;
    }
    if (!existingProvider) fail("invalid_arguments", "Supply the provider to rotate.");
    if (existingProvider.providerGatewayId)
      fail(
        "gateway_backed_provider",
        "Rotate the attached provider gateway token instead.",
      );
    const value = await secret(flags, "Provider API key");
    if (flags.browser)
      return ctx.operation("provider.rotate-key", { id: existingProvider.id, revision: existingProvider.revision });
    return (
      await ctx.call("updateProvider", {
        params: { id: existingProvider.id },
        body: { secret: value!, revision: existingProvider.revision },
      })
    ).data;
  }
  if (action === "update") {
    if (gateway) {
      if (!existingGateway) fail("invalid_arguments", "Supply the gateway to update.");
      const body = validate(ProviderGatewayUpdateRequestSchema, {
        name: await required(flags, "name"),
        revision: existingGateway.revision,
      });
      return (
        await ctx.call("updateProviderGateway", { params: { id: existingGateway.id }, body })
      ).data;
    }
    if (!existingProvider) fail("invalid_arguments", "Supply the provider to update.");
    const draft: Record<string, unknown> = {};
    if (flags.name !== undefined) draft["name"] = flags.name;
    if (flags.status !== undefined) draft["status"] = flags.status;
    if (flags["clear-base-url"]) draft["baseUrl"] = null;
    if (flags["base-url"]) draft["baseUrl"] = flags["base-url"];
    if (flags["clear-pricing"]) draft["pricing"] = null;
    if (flags.pricing) draft["pricing"] = (await jsonFile(flags.pricing)) as ProviderPricing;
    if (flags["clear-route"]) draft["gatewayRoute"] = null;
    if (flags.route) draft["gatewayRoute"] = await jsonFile(flags.route);
    if (typeof draft["baseUrl"] === "string") {
      const checked = checkOperatorBaseUrl(draft["baseUrl"]);
      if (!checked.ok) fail("invalid_input", checked.message);
      draft["baseUrl"] = checked.baseUrl;
    }
    const keyInput = flags.browser || flags["key-prompt"] || flags["key-stdin"];
    if (
      existingProvider.providerGatewayId &&
      (keyInput || flags["base-url"] || flags["clear-base-url"])
    )
      fail(
        "gateway_backed_provider",
        "A gateway-backed provider cannot take a direct key or origin.",
      );
    if (keyInput && !flags["base-url"] && !flags["clear-base-url"])
      fail(
        "invalid_input",
        "Secret input on provider update requires --base-url or --clear-base-url; use rotate-key for ordinary rotation.",
      );
    if (flags["base-url"] || flags["clear-base-url"]) {
      validate(ProviderUpdateRequestSchema, {
        ...draft,
        revision: existingProvider.revision,
        secret: "validation-placeholder",
      });
      const value = await secret(flags, "Provider API key");
      if (value) draft["secret"] = value;
    }
    const body: ProviderUpdateRequest = validate(ProviderUpdateRequestSchema, {
      ...draft,
      revision: existingProvider.revision,
      ...(flags.browser ? { secret: "validation-placeholder" } : {}),
    });
    if (flags.browser)
      return ctx.operation(
        "provider.update",
        validate(HandoffProviderUpdatePayloadSchema, {
          id: existingProvider.id,
          revision: existingProvider.revision,
          ...draft,
        }),
      );
    return (await ctx.call("updateProvider", { params: { id: existingProvider.id }, body })).data;
  }
  fail("unknown_command", "Unknown command.");
}

/** Refuses a type the selected deployment has no adapter for, before any write. */
async function assertSupportedType(
  ctx: Context,
  gateway: boolean,
  type: string,
): Promise<void> {
  const { data: capabilities } = await ctx.publicCall("getCliCapabilities");
  const supported: { type: string }[] = gateway
    ? capabilities.providerGateways
    : capabilities.providers;
  if (!supported.some((p) => p.type === type))
    fail(
      "unsupported_type",
      "The selected deployment does not support this type.",
    );
}
