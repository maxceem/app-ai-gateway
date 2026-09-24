/**
 * A gateway type, in one object.
 *
 * Everything outside its adapter that this deployment knows about a gateway
 * type — what it is called, the non-secret connection it needs and how the
 * console asks for it, which provider types it reaches — is one entry in
 * {@link GATEWAY_DESCRIPTORS}. Adding a type is that entry plus its adapter in
 * `src/providers/gateway-adapters.ts`; the contracts, the stored configuration
 * type, the console's forms and the CLI's `--type` names all derive from here.
 *
 * Shared with the console and the CLI, which import it directly: it imports
 * zod, which both already carry for the application configuration grammar, and
 * the plain route tables in `./capabilities.ts`, and nothing from the Worker.
 */

import { z } from "zod";
import {
  CF_AIG_ROUTES,
  VERCEL_ROUTES,
  type GatewayProviderRoute,
} from "./capabilities.ts";
import type { ProviderType } from "./providers.ts";

/** One non-secret connection value, as the console asks for it. */
export interface GatewayConnectionField {
  /** The key in the descriptor's {@link GatewayDescriptor.connection}, and the request body field that carries it. */
  key: string;
  label: string;
  placeholder?: string;
  hint?: string;
}

export interface GatewayDescriptor {
  /** The display name, which is also the CLI's default name for a new gateway. */
  label: string;
  /** How `agw provider-gateway add --type` spells this type. */
  cliName: string;
  /** The console's default name for a new gateway of this type. */
  defaultName: string;
  /** Where the gateway's own documentation says how to create its token. */
  tokenDocsUrl: string;
  /** Whose provider credentials the gateway spends, in the words the console shows. */
  credentialNote: string;
  /**
   * The non-secret configuration a connection needs before its token means
   * anything, which is exactly what `provider_gateway.config_json` stores. A
   * create request carries these fields beside the name and the token, and a
   * stored row is read back through this schema.
   */
  connection: z.ZodObject<Record<string, z.ZodString>, z.core.$strict>;
  /** What the console asks for, in order: one entry per {@link connection} key. */
  connectionFields: readonly GatewayConnectionField[];
  /** Which provider types this gateway serves, and how. */
  routes: Partial<Record<ProviderType, GatewayProviderRoute>>;
}

const GatewayIdSchema = z.string().trim().min(1).max(100);

export const GATEWAY_DESCRIPTORS = {
  cf_aig: {
    label: "Cloudflare AI Gateway",
    cliName: "cloudflare",
    defaultName: "Our CF gateway",
    tokenDocsUrl: "https://developers.cloudflare.com/ai-gateway/configuration/authentication/",
    credentialNote:
      "Requests use the provider keys stored in your Cloudflare AI Gateway's own key store.",
    // Cloudflare's URL is built from the account and gateway pair.
    connection: z.object({ accountId: GatewayIdSchema, gatewayId: GatewayIdSchema }).strict(),
    connectionFields: [
      { key: "accountId", label: "Cloudflare Account ID" },
      { key: "gatewayId", label: "Cloudflare Gateway ID" },
    ],
    routes: CF_AIG_ROUTES,
  },
  vercel: {
    label: "Vercel AI Gateway",
    cliName: "vercel",
    defaultName: "Our Vercel gateway",
    tokenDocsUrl: "https://vercel.com/docs/ai-gateway/authentication-and-byok/api-keys",
    // Deliberately not "using your key": Vercel documents BYOK as preferred,
    // with a fallback to its own system credentials when a stored key fails.
    credentialNote:
      "Your provider credential stored in Vercel is preferred. Vercel may fall back to system credentials.",
    // One fixed origin serving every team, and the team is identified by the
    // token alone: there is nothing per-connection to store.
    connection: z.object({}).strict().meta({
      description: "Vercel's origin is fixed in adapter code, so it has no configuration of its own.",
    }),
    connectionFields: [],
    routes: VERCEL_ROUTES,
  },
} as const satisfies Record<string, GatewayDescriptor>;

/** Every gateway type this deployment can reach, and the only ones. */
export type GatewayType = keyof typeof GATEWAY_DESCRIPTORS;

/** The descriptor keys as a list, in declaration order. */
export const GATEWAY_TYPES = Object.keys(GATEWAY_DESCRIPTORS) as [GatewayType, ...GatewayType[]];

/** One gateway type's stored connection configuration. */
export type GatewayConnectionConfig<T extends GatewayType = GatewayType> = {
  [Type in T]: z.output<(typeof GATEWAY_DESCRIPTORS)[Type]["connection"]>;
}[T];

/** One gateway type's connection shape, exactly as its descriptor declares it. */
export type GatewayConnectionShape<T extends GatewayType> =
  (typeof GATEWAY_DESCRIPTORS)[T]["connection"]["shape"];

/**
 * A gateway row's type and its connection, read as that type's own shape: the
 * pair every consumer of a stored gateway receives, checked once by
 * `readStoredGateway` in `src/providers/gateway-adapters.ts` and narrowed on
 * `type` from then on.
 */
export type StoredGateway = {
  [T in GatewayType]: { type: T; config: GatewayConnectionConfig<T> };
}[GatewayType];

/** A request body for one gateway connection: its type, its connection fields, and `Fields`. */
export type GatewayBody<Fields> = {
  [T in GatewayType]: { type: T } & Fields & GatewayConnectionConfig<T>;
}[GatewayType];

/**
 * A request body for a gateway of `type`, from connection values keyed by its
 * descriptor's connection fields — which is what a form or a set of CLI flags
 * holds — plus `fields` beside them. Only the type's own keys are taken, so a
 * value left over from another type never reaches the body.
 */
export function gatewayBody<Fields extends object>(
  type: GatewayType,
  connection: Readonly<Record<string, string>>,
  fields: Fields,
): GatewayBody<Fields> {
  const own = Object.fromEntries(
    GATEWAY_DESCRIPTORS[type].connectionFields.map((field) => [field.key, connection[field.key] ?? ""]),
  );
  // The keys are exactly this type's connection fields, and the values are the
  // strings each one is; the pairing with `type` is what the cast restores.
  return { ...fields, type, ...own } as GatewayBody<Fields>;
}

/** The table entry widened to {@link GatewayDescriptor}. */
export function gatewayDescriptor(type: GatewayType): GatewayDescriptor {
  return GATEWAY_DESCRIPTORS[type];
}

/**
 * Whether a string names a gateway type this deployment has a descriptor, and
 * so an adapter, for. The stored column is deliberately unconstrained, so a
 * stored row is not proof that this deployment can serve it.
 */
export function isGatewayType(value: unknown): value is GatewayType {
  return typeof value === "string" && Object.hasOwn(GATEWAY_DESCRIPTORS, value);
}

/** The gateway type a CLI `--type` name spells, if any. */
export function gatewayTypeForCliName(name: string): GatewayType | undefined {
  return GATEWAY_TYPES.find((type) => GATEWAY_DESCRIPTORS[type].cliName === name);
}
