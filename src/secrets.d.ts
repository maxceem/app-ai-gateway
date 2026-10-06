// Wrangler generates all configured bindings in worker-configuration.d.ts.
// Secret names cannot be declared in wrangler.jsonc without exposing values,
// so they are added to the generated Env through declaration merging.
interface Env {
  JWT_SECRET: string;
  BETTER_AUTH_SECRET: string;
  DEPLOYMENT_ID?: string;
  CLI_CONSOLE_ORIGIN?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  // The SHA-256, in hex, of the token the CLI bootstraps a self-host with. Set
  // only by the CLI that deployed the Worker; unset means no bootstrap.
  CLI_BOOTSTRAP_TOKEN_DIGEST?: string;
  // How long an upstream provider may take to send its response headers, in
  // seconds. Unset means 120 s: reasoning models can think for a minute before
  // the first byte. The body streams for as long as it needs once headers land.
  PROVIDER_TTFB_TIMEOUT_SECONDS?: string;
  // Queries the nightly maintenance cron may issue, as a whole number. Unset
  // means 50, the D1 subrequest ceiling on the Cloudflare Free plan. A
  // deployment on the Workers Paid plan may raise it towards 1,000 to drain a
  // retention or expired-account backlog faster. Deliberately absent from
  // wrangler.jsonc, so the Deploy to Cloudflare form does not ask about it.
  MAINTENANCE_QUERY_BUDGET?: string;
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
  // Browser origins besides the console's own that may call the MCP endpoint,
  // comma-separated, each an https origin with no path. Unset or empty means
  // only non-browser clients and the console itself; an invalid entry is
  // dropped with a warning. Not a secret.
  MCP_ALLOWED_ORIGINS?: string;
  // `false` refuses OAuth clients that identify themselves with a Client ID
  // Metadata Document (an https client_id). Unset or anything else leaves it on.
  // Not a secret.
  OAUTH_CIMD?: string;
  // OAuth clients the deployment registers itself, as a JSON array of
  // { clientId, name, redirectUris }. Unset means none; an invalid entry is
  // dropped with a warning. Not a secret.
  OAUTH_CLIENTS?: string;
  BILLING?: import("./billing/contract").BillingRuntime;
  // The vault mode, KEK version and registration list are plain `vars` in wrangler.jsonc, so the
  // deploy form shows their defaults in clear text. `wrangler types` narrows a
  // var to the literal it finds there, which is wrong for any deployment that
  // overrides one in a profile overlay or in the dashboard; these declarations
  // merge the honest type back over it.
  SECRET_VAULT_MODE: string;
  SECRET_VAULT_LOCAL_KEK_CURRENT_VERSION: string;
  ALLOWED_REGISTRATION_EMAILS: string;
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
  DEPLOYMENT_ID?: string;
  CLI_CONSOLE_ORIGIN?: string;
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
    CLI_BOOTSTRAP_TOKEN_DIGEST?: string;
    PROVIDER_TTFB_TIMEOUT_SECONDS?: string;
    MAINTENANCE_QUERY_BUDGET?: string;
    TERMS_OF_SERVICE_URL?: string;
    PRIVACY_POLICY_URL?: string;
    PUBLIC_API_URL?: string;
    OAUTH_RELAY_URL?: string;
    MCP_ALLOWED_ORIGINS?: string;
    OAUTH_CIMD?: string;
    OAUTH_CLIENTS?: string;
    BILLING?: import("./billing/contract").BillingRuntime;
    SECRET_VAULT_MODE: string;
    SECRET_VAULT_LOCAL_KEK_CURRENT_VERSION: string;
    ALLOWED_REGISTRATION_EMAILS: string;
    SECRET_VAULT_KMS_URL?: string;
    SECRET_VAULT_KMS_TOKEN?: string;
    SECRET_VAULT_LOCAL_KEK_V1?: string;
  }
}
