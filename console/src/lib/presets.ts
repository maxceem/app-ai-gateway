import type { AuthConfig, ClaimRequirement, EntitlementCheck, IssuerProvider } from "./config-types";

export interface PresetInput {
  key: string;
  label: string;
  placeholder: string;
  hint?: string;
}

export interface IssuerFragment {
  jwks_url: string;
  /** Accepted `iss`. Required by the Worker; see the warning on each preset. */
  issuer: string;
  /** Accepted `aud`. Required by the Worker. */
  audience: string;
  user_id_claim: string;
  required_claims: ClaimRequirement[];
}

export interface IssuerPreset {
  id: IssuerProvider;
  label: string;
  /** The vendor's own name, for "<vendor> documentation" and the like. */
  vendor?: string;
  description: string;
  inputs: PresetInput[];
  /** Shown in amber above the form; explains what the preset is protecting against. */
  warning?: string;
  docs?: string;
  /** Call through {@link buildIssuer}, which guarantees every input is present. */
  build: (values: Record<string, string>) => IssuerFragment;
  /**
   * The inverse of `build`: reads the inputs back out of a stored issuer, so
   * the same form reopens on what was written. Lenient by design — it returns
   * whatever it can even from a half-typed issuer, because the form is bound to
   * the stored block and re-reads it on every keystroke. Whether the issuer
   * really came from this preset is {@link matchIssuerPreset}'s question.
   */
  read: (issuer: StoredIssuer) => Record<string, string>;
}

/** A stored issuer with its scoping fields flattened to single strings. */
export interface StoredIssuer {
  jwks_url: string;
  issuer: string;
  audience: string;
}

const trimHost = (value: string) => value.replace(/^https?:\/\//u, "").replace(/\/+$/u, "");

/**
 * Builders run on every keystroke, including the first render when no field has
 * been touched. Filling in every declared input keeps each builder free of
 * undefined checks and trimming.
 */
function normalize(
  preset: { inputs: PresetInput[] },
  values: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(preset.inputs.map((input) => [input.key, (values[input.key] ?? "").trim()]));
}

export const buildIssuer = (preset: IssuerPreset, values: Record<string, string>): IssuerFragment =>
  preset.build(normalize(preset, values));

export const buildEntitlement = (
  preset: EntitlementPreset,
  values: Record<string, string>,
): ClaimRequirement[] => preset.build(normalize(preset, values));

export const ISSUER_PRESETS: IssuerPreset[] = [
  {
    id: "firebase",
    label: "Firebase Authentication",
    vendor: "Firebase",
    description: "Google-signed ID tokens. Scoped to your project by the aud and iss claims.",
    inputs: [
      {
        key: "project_id",
        label: "Firebase project id",
        placeholder: "my-app-1a2b3",
        hint: "Found in Project settings. Not the project number.",
      },
    ],
    warning:
      "Firebase signs every project's tokens with one shared key set, so the JWKS URL alone identifies nobody. The issuer and audience below are what scope this app to your project — without them the gateway would accept a token from any Firebase project in the world.",
    docs: "https://firebase.google.com/docs/auth/admin/verify-id-tokens",
    build: ({ project_id }) => ({
      jwks_url:
        "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
      issuer: `https://securetoken.google.com/${project_id}`,
      audience: project_id,
      user_id_claim: "sub",
      required_claims: [],
    }),
    read: ({ audience }) => ({ project_id: audience }),
  },
  {
    id: "supabase",
    label: "Supabase Auth",
    vendor: "Supabase",
    description: "Per-project JWKS. Requires asymmetric signing keys.",
    inputs: [
      {
        key: "project_ref",
        label: "Project ref",
        placeholder: "abcdefghijklmnop",
        hint: "The subdomain of your project URL: https://<ref>.supabase.co",
      },
    ],
    warning:
      "Only projects migrated to asymmetric JWT signing keys can be verified. A legacy HS256 project publishes no public keys, so its JWKS endpoint returns an empty set and every token is rejected.",
    docs: "https://supabase.com/docs/guides/auth/signing-keys",
    build: ({ project_ref }) => {
      const reference = trimHost(project_ref).replace(/\.supabase\.co$/u, "");
      return {
        jwks_url: `https://${reference}.supabase.co/auth/v1/.well-known/jwks.json`,
        issuer: `https://${reference}.supabase.co/auth/v1`,
        audience: "authenticated",
        user_id_claim: "sub",
        required_claims: [],
      };
    },
    read: ({ issuer }) => ({
      project_ref: trimHost(issuer).replace(/\.supabase\.co\/auth\/v1$/u, ""),
    }),
  },
  {
    id: "auth0",
    label: "Auth0",
    vendor: "Auth0",
    description: "Per-tenant JWKS, with the API identifier as the audience.",
    inputs: [
      {
        key: "domain",
        label: "Tenant domain",
        placeholder: "my-tenant.us.auth0.com",
        hint: "Your Auth0 domain or custom domain, without https://",
      },
      {
        key: "audience",
        label: "API identifier",
        placeholder: "https://api.my-app.com",
        hint: "The Identifier of the API you registered in Auth0. It is not a URL that has to resolve.",
      },
    ],
    warning:
      "Auth0 puts a trailing slash in the iss claim. The preset writes it for you; do not remove it or every token is rejected.",
    docs: "https://auth0.com/docs/secure/tokens/access-tokens/validate-access-tokens",
    build: ({ domain, audience }) => {
      const host = trimHost(domain);
      return {
        jwks_url: `https://${host}/.well-known/jwks.json`,
        // Auth0's iss carries a trailing slash; without it every token is refused.
        issuer: `https://${host}/`,
        audience,
        user_id_claim: "sub",
        required_claims: [],
      };
    },
    read: ({ issuer, audience }) => ({ domain: trimHost(issuer), audience }),
  },
  {
    id: "clerk",
    label: "Clerk",
    vendor: "Clerk",
    description: "Session tokens verified against your Frontend API JWKS.",
    inputs: [
      {
        key: "frontend_api",
        label: "Frontend API host",
        placeholder: "clean-mayfly-62.clerk.accounts.dev",
        hint: "Your Clerk Frontend API URL or custom domain, without https://",
      },
      {
        key: "audience",
        label: "Audience",
        placeholder: "my-app",
        hint: "The aud your Clerk JWT template sets. Clerk's default session token has none — add one in the template, because the gateway requires it.",
      },
    ],
    warning:
      "Clerk's own guidance also checks the azp claim against your permitted origins. This gateway serves native apps, where there is no origin to bind to, so the preset omits it — add an azp requirement manually if your tokens carry one.",
    docs: "https://clerk.com/docs/guides/sessions/manual-jwt-verification",
    build: ({ frontend_api, audience }) => {
      const host = trimHost(frontend_api);
      return {
        jwks_url: `https://${host}/.well-known/jwks.json`,
        issuer: `https://${host}`,
        audience,
        user_id_claim: "sub",
        required_claims: [],
      };
    },
    read: ({ issuer, audience }) => ({ frontend_api: trimHost(issuer), audience }),
  },
  {
    id: "custom",
    label: "Custom issuer",
    description: "Any issuer publishing a JWKS document over HTTPS.",
    inputs: [
      {
        key: "jwks_url",
        label: "JWKS URL",
        placeholder: "https://issuer.example.com/.well-known/jwks.json",
        hint: "If this issuer signs tokens for more than one service, add a claim requirement under Subscription check too.",
      },
      {
        key: "issuer",
        label: "Issuer (iss)",
        placeholder: "https://issuer.example.com",
        hint: "Exactly the iss claim your tokens carry, trailing slash included.",
      },
      {
        key: "audience",
        label: "Audience (aud)",
        placeholder: "https://api.my-app.com",
        hint: "Exactly one aud value your tokens carry.",
      },
    ],
    build: ({ jwks_url, issuer, audience }) => ({
      jwks_url,
      issuer,
      audience,
      user_id_claim: "sub",
      required_claims: [],
    }),
    read: (stored) => ({ ...stored }),
  },
];

export const CUSTOM_ISSUER_PRESET = ISSUER_PRESETS.find((preset) => preset.id === "custom")!;

export const issuerPreset = (id: IssuerProvider): IssuerPreset =>
  ISSUER_PRESETS.find((preset) => preset.id === id) ?? CUSTOM_ISSUER_PRESET;

/**
 * The stored scoping fields as single strings. The Worker stores every value
 * as a list even when one was written, so a list of one is read as that value.
 * A list of several is beyond what any preset writes; the first is shown.
 */
export function storedIssuer(issuer: AuthConfig): StoredIssuer {
  const single = (value: string | string[] | undefined): string =>
    Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
  return {
    jwks_url: issuer.jwks_url ?? "",
    issuer: single(issuer.issuer),
    audience: single(issuer.audience),
  };
}

/**
 * Which preset a stored issuer was made with, and the inputs that made it, so
 * the console can say "Firebase, project my-app" instead of three URLs and
 * reopen the same form to change it.
 *
 * An issuer written by the console names its provider. One that does not — a
 * hand-written block, or one from before the field existed — is guessed at, and
 * the guess only counts when rebuilding from the recovered inputs reproduces
 * the stored fields exactly, so an issuer that merely resembles a vendor falls
 * through to the custom preset rather than being misnamed. An issuer accepting
 * several `iss` or `aud` values is custom by definition: no preset writes a list.
 */
export function matchIssuerPreset(
  issuer: AuthConfig,
): { preset: IssuerPreset; values: Record<string, string> } {
  const stored = storedIssuer(issuer);
  if (issuer.provider) {
    const preset = issuerPreset(issuer.provider);
    return { preset, values: preset.read(stored) };
  }

  const custom = { preset: CUSTOM_ISSUER_PRESET, values: { ...stored } };
  const several = (value: string | string[] | undefined) => Array.isArray(value) && value.length > 1;
  if (several(issuer.issuer) || several(issuer.audience)) return custom;

  for (const preset of ISSUER_PRESETS) {
    if (preset === CUSTOM_ISSUER_PRESET) continue;
    const values = preset.read(stored);
    if (!presetInputsComplete(preset, values)) continue;
    const rebuilt = buildIssuer(preset, values);
    if (
      rebuilt.jwks_url === stored.jwks_url &&
      rebuilt.issuer === stored.issuer &&
      rebuilt.audience === stored.audience
    ) {
      return { preset, values };
    }
  }
  return custom;
}

export interface EntitlementPreset {
  id: "none" | EntitlementCheck;
  label: string;
  vendor?: string;
  description: string;
  inputs: PresetInput[];
  note?: string;
  build: (values: Record<string, string>) => ClaimRequirement[];
}

export const ENTITLEMENT_PRESETS: EntitlementPreset[] = [
  {
    id: "none",
    label: "No entitlement check",
    description: "Any user the issuer signs a token for may call the gateway.",
    inputs: [],
    build: () => [],
  },
  {
    id: "revenuecat",
    label: "RevenueCat entitlement",
    vendor: "RevenueCat",
    description: "Checks a claim your backend writes from RevenueCat webhooks.",
    inputs: [
      {
        key: "path",
        label: "Claim path",
        placeholder: "entitlements",
        hint: "Dot path into the issuer token, e.g. entitlements or claims.entitlements.",
      },
      {
        key: "value",
        label: "Entitlement id",
        placeholder: "pro",
        hint: "Matched with contains, so it works whether the claim is a string or an array.",
      },
    ],
    note:
      "The gateway never talks to RevenueCat. Your backend receives the RevenueCat webhook and writes this claim onto the user's identity token (a Firebase custom claim, a Supabase app_metadata field, an Auth0 action); the gateway only checks that the claim is present. Subscription environment is invisible here — a sandbox purchase cannot bypass anything, because it still requires your signed build and a valid issuer token.",
    build: ({ path, value }) =>
      path && value ? [{ path, contains: value }] : [],
  },
  {
    id: "custom",
    label: "Custom claim",
    description: "Any single claim requirement. More can be added under Subscription check.",
    inputs: [
      { key: "path", label: "Claim path", placeholder: "scope" },
      { key: "value", label: "Required value", placeholder: "ai.invoke" },
    ],
    build: ({ path, value }) =>
      path && value ? [{ path, contains: value }] : [],
  },
];

/**
 * Applying a preset twice must update its claims rather than duplicate them, and
 * must never drop a requirement the operator added by hand.
 */
export function mergeClaims(
  existing: ClaimRequirement[],
  incoming: ClaimRequirement[],
): ClaimRequirement[] {
  const replaced = new Set(incoming.map((claim) => claim.path));
  return [...existing.filter((claim) => !replaced.has(claim.path)), ...incoming];
}

export const describeClaim = (claim: ClaimRequirement): string =>
  claim.equals !== undefined
    ? `${claim.path} equals ${String(claim.equals)}`
    : `${claim.path} contains ${Array.isArray(claim.contains) ? claim.contains.join(" or ") : claim.contains}`;

export const presetInputsComplete = (
  preset: { inputs: PresetInput[] },
  values: Record<string, string>,
): boolean => preset.inputs.every((input) => (values[input.key] ?? "").trim().length > 0);
