// Wrangler generates all configured bindings in worker-configuration.d.ts.
// Secret names cannot be declared in wrangler.jsonc without exposing values,
// so they are added to the generated Env through declaration merging.
interface Env {
  JWT_SECRET: string;
  ADMIN_TOKEN: string;
  CF_AIG_GATEWAY_ID: string;
  CF_AIG_TOKEN: string;
}

declare namespace Cloudflare {
  interface Env {
    JWT_SECRET: string;
    ADMIN_TOKEN: string;
    CF_AIG_GATEWAY_ID: string;
    CF_AIG_TOKEN: string;
  }
}
