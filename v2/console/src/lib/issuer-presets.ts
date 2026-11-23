/**
 * The identity providers and paid checks the console knows how to fill in,
 * ported from v1. A preset turns the few things only the customer knows (a
 * project id, a tenant domain) into the issuer fields the gateway verifies
 * tokens with, and reads them back out so the same form reopens.
 */
import type { IssuerAuthentication } from "@contracts/app-config";

export type IssuerProvider = NonNullable<IssuerAuthentication["provider"]>;

/** The issuer as the console edits it: `issuer` and `audience` may still be a single string. */
export type IssuerDraft = Omit<IssuerAuthentication, "issuer" | "audience"> & {
  issuer: string | string[];
  audience: string | string[];
};

export interface PresetInput {
  key: string;
  label: string;
  placeholder: string;
  hint?: string;
}

export interface IssuerFields {
  jwks_url: string;
  issuer: string;
  audience: string;
}

export interface IssuerPreset {
  id: IssuerProvider;
  label: string;
  description: string;
  inputs: PresetInput[];
  /** Shown above the form: what the preset protects against. */
  warning?: string;
  build: (values: Record<string, string>) => IssuerFields;
  read: (stored: IssuerFields) => Record<string, string>;
}

const trimHost = (value: string) => value.replace(/^https?:\/\//u, "").replace(/\/+$/u, "");

export const ISSUER_PRESETS: IssuerPreset[] = [
  {
    id: "firebase",
    label: "Firebase Authentication",
    description: "Google-signed ID tokens, scoped to your project.",
    inputs: [{ key: "project_id", label: "Firebase project id", placeholder: "my-app-1a2b3", hint: "In Project settings. Not the project number." }],
    warning:
      "Firebase signs every project's tokens with one shared key set. The issuer and audience are what limit this app to your project.",
    build: ({ project_id = "" }) => ({
      jwks_url: "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
      issuer: `https://securetoken.google.com/${project_id}`,
      audience: project_id,
    }),
    read: ({ audience }) => ({ project_id: audience }),
  },
  {
    id: "supabase",
    label: "Supabase Auth",
    description: "Per-project keys. Needs asymmetric signing keys.",
    inputs: [{ key: "project_ref", label: "Project ref", placeholder: "abcdefghijklmnop", hint: "The subdomain of your project URL: https://<ref>.supabase.co" }],
    warning: "Only projects that sign with asymmetric keys can be verified. A project still on the legacy HS256 secret publishes no public keys, so every token is refused.",
    build: ({ project_ref = "" }) => {
      const reference = trimHost(project_ref).replace(/\.supabase\.co$/u, "");
      return {
        jwks_url: `https://${reference}.supabase.co/auth/v1/.well-known/jwks.json`,
        issuer: `https://${reference}.supabase.co/auth/v1`,
        audience: "authenticated",
      };
    },
    read: ({ issuer }) => ({ project_ref: trimHost(issuer).replace(/\.supabase\.co\/auth\/v1$/u, "") }),
  },
  {
    id: "auth0",
    label: "Auth0",
    description: "Per-tenant keys, with your API identifier as the audience.",
    inputs: [
      { key: "domain", label: "Tenant domain", placeholder: "my-tenant.us.auth0.com", hint: "Your Auth0 domain or custom domain, without https://" },
      { key: "audience", label: "API identifier", placeholder: "https://api.my-app.com", hint: "The Identifier of the API you registered in Auth0." },
    ],
    warning: "Auth0 puts a trailing slash in the issuer. It is written for you; removing it refuses every token.",
    build: ({ domain = "", audience = "" }) => {
      const host = trimHost(domain);
      return { jwks_url: `https://${host}/.well-known/jwks.json`, issuer: `https://${host}/`, audience };
    },
    read: ({ issuer, audience }) => ({ domain: trimHost(issuer), audience }),
  },
  {
    id: "clerk",
    label: "Clerk",
    description: "Session tokens, verified against your Frontend API keys.",
    inputs: [
      { key: "frontend_api", label: "Frontend API host", placeholder: "clean-mayfly-62.clerk.accounts.dev", hint: "Your Clerk Frontend API host or custom domain, without https://" },
      { key: "audience", label: "Audience", placeholder: "my-app", hint: "The aud your Clerk JWT template sets. The default session token has none, so add one." },
    ],
    warning:
      "Clerk's own guidance also checks the azp claim against your allowed origins. A native app has no origin to check, so this preset leaves it out. If your tokens carry azp, add a claim requirement for it in the configuration on the Settings tab.",
    build: ({ frontend_api = "", audience = "" }) => {
      const host = trimHost(frontend_api);
      return { jwks_url: `https://${host}/.well-known/jwks.json`, issuer: `https://${host}`, audience };
    },
    read: ({ issuer, audience }) => ({ frontend_api: trimHost(issuer), audience }),
  },
  {
    id: "custom",
    label: "Custom issuer",
    description: "Any issuer that publishes its keys (JWKS) over HTTPS.",
    inputs: [
      { key: "jwks_url", label: "JWKS URL", placeholder: "https://issuer.example.com/.well-known/jwks.json" },
      { key: "issuer", label: "Issuer (iss)", placeholder: "https://issuer.example.com", hint: "Exactly the iss your tokens carry, trailing slash included." },
      { key: "audience", label: "Audience (aud)", placeholder: "https://api.my-app.com", hint: "One aud value your tokens carry." },
    ],
    build: ({ jwks_url = "", issuer = "", audience = "" }) => ({ jwks_url, issuer, audience }),
    read: (stored) => ({ ...stored }),
  },
];

const CUSTOM = ISSUER_PRESETS.find((preset) => preset.id === "custom")!;

export function issuerPreset(id: IssuerProvider | undefined): IssuerPreset {
  return ISSUER_PRESETS.find((preset) => preset.id === id) ?? CUSTOM;
}

/** The first of a stored list, or the string itself. */
const first = (value: string | string[]): string => (Array.isArray(value) ? (value[0] ?? "") : value);

/**
 * The preset an issuer was made with, and the inputs that made it, so the
 * form reopens on them. It counts only when the preset rebuilds the stored
 * fields exactly, whether or not the issuer names its provider: anything else
 * opens in the custom editor, which shows every stored value, so no field is
 * hidden behind a preset that would rewrite it.
 */
export function matchIssuerPreset(issuer: IssuerDraft): { preset: IssuerPreset; values: Record<string, string> } {
  const stored = { jwks_url: issuer.jwks_url, issuer: first(issuer.issuer), audience: first(issuer.audience) };
  const custom = { preset: CUSTOM, values: stored };
  const several = (value: string | string[]) => Array.isArray(value) && value.length > 1;
  // A list of several issuers or audiences is something no preset writes.
  if (several(issuer.issuer) || several(issuer.audience)) return custom;
  const candidates = issuer.provider ? [issuerPreset(issuer.provider)] : ISSUER_PRESETS;
  for (const preset of candidates) {
    if (preset === CUSTOM) continue;
    const values = preset.read(stored);
    const rebuilt = buildIssuer(preset, values);
    if (rebuilt.jwks_url === stored.jwks_url && rebuilt.issuer === stored.issuer && rebuilt.audience === stored.audience) {
      return { preset, values };
    }
  }
  return custom;
}

/** The inputs of a preset still empty. */
export function missingInputs(preset: IssuerPreset, values: Record<string, string>): PresetInput[] {
  return preset.inputs.filter((input) => (values[input.key] ?? "").trim() === "");
}

/** The issuer fields a preset writes from its inputs, trimmed. */
export function buildIssuer(preset: IssuerPreset, values: Record<string, string>): IssuerFields {
  return preset.build(Object.fromEntries(preset.inputs.map((input) => [input.key, (values[input.key] ?? "").trim()])));
}

/** A new issuer: Firebase with its project id still to fill in, verifying `sub`, tokens up to a day old. */
export function emptyIssuer(): IssuerDraft {
  return {
    provider: "firebase",
    ...buildIssuer(issuerPreset("firebase"), {}),
    user_id_claim: "sub",
    required_claims: [],
    max_token_lifetime_seconds: 86400,
  };
}

/** The claim a RevenueCat entitlement arrives in, as RevenueCat's own Firebase function kit writes it. */
export const REVENUECAT_CLAIM_PATH = "revenueCatEntitlements";

/** Whether only paid users may call: the token must carry at least one required claim. */
export function requiresPayment(issuer: IssuerDraft): boolean {
  return issuer.entitlement !== undefined || issuer.required_claims.length > 0;
}
