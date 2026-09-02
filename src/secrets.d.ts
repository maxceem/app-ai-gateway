// Wrangler generates all configured bindings in worker-configuration.d.ts.
// Secret names cannot be declared in wrangler.jsonc without exposing values,
// so they are added to the generated Env through declaration merging.
interface Env {
  JWT_SECRET: string;
  BETTER_AUTH_SECRET: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  ALLOW_PUBLIC_REGISTRATION?: string;
  BILLING?: import("cf-billing").BillingRuntime;
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
    BILLING?: import("cf-billing").BillingRuntime;
    SECRET_VAULT_KMS_URL?: string;
    SECRET_VAULT_KMS_TOKEN?: string;
    SECRET_VAULT_LOCAL_KEK_V1?: string;
  }
}
