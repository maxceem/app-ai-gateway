// Wrangler generates all configured bindings in worker-configuration.d.ts.
// Secret names cannot be declared in wrangler.jsonc without exposing values,
// so they are added to the generated Env through declaration merging.
interface Env {
  JWT_SECRET: string;
  BETTER_AUTH_SECRET: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  ALLOW_PUBLIC_REGISTRATION?: string;
  // How long an upstream provider may take to send its response headers, in
  // seconds. Unset means 120 s: reasoning models can think for a minute before
  // the first byte. The body streams for as long as it needs once headers land.
  PROVIDER_TTFB_TIMEOUT_SECONDS?: string;
  // Optional links shown on the sign-up screen, set as plain vars by a
  // deployment profile. Both must be present for the consent line to appear.
  TERMS_OF_SERVICE_URL?: string;
  PRIVACY_POLICY_URL?: string;
  // Origin the console advertises to application clients, for a deployment that
  // serves this Worker on a second host. Unset means the console's own origin.
  PUBLIC_API_URL?: string;
  // Origin of an OAuth callback relay, for local instances whose hostname
  // changes and so cannot be registered with Google. Not a secret, and unset in
  // every deployment that owns its callback URL. See the deployment guide.
  OAUTH_RELAY_URL?: string;
  BILLING?: import("./billing/contract").BillingRuntime;
  // The vault mode and KEK version are plain `vars` in wrangler.jsonc, so the
  // deploy form shows their defaults in clear text. `wrangler types` narrows a
  // var to the literal it finds there, which is wrong for any deployment that
  // overrides one in a profile overlay or in the dashboard; these declarations
  // merge the honest type back over it.
  SECRET_VAULT_MODE: string;
  SECRET_VAULT_LOCAL_KEK_CURRENT_VERSION: string;
  // Vault credentials. Each is required only in its own SECRET_VAULT_MODE, and
  // src/vault validates the full per-mode set on first use rather than trusting
  // these optional markers. Higher local KEK versions are read by name.
  SECRET_VAULT_KMS_URL?: string;
  SECRET_VAULT_KMS_TOKEN?: string;
  SECRET_VAULT_LOCAL_KEK_V1?: string;
}

declare namespace Cloudflare {
  interface Env {
    JWT_SECRET: string;
    BETTER_AUTH_SECRET: string;
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
    ALLOW_PUBLIC_REGISTRATION?: string;
    PROVIDER_TTFB_TIMEOUT_SECONDS?: string;
    TERMS_OF_SERVICE_URL?: string;
    PRIVACY_POLICY_URL?: string;
    PUBLIC_API_URL?: string;
    OAUTH_RELAY_URL?: string;
    BILLING?: import("./billing/contract").BillingRuntime;
    SECRET_VAULT_MODE: string;
    SECRET_VAULT_LOCAL_KEK_CURRENT_VERSION: string;
    SECRET_VAULT_KMS_URL?: string;
    SECRET_VAULT_KMS_TOKEN?: string;
    SECRET_VAULT_LOCAL_KEK_V1?: string;
  }
}
