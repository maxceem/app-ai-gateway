import type { D1Migration } from "@cloudflare/vitest-pool-workers";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_REALTIME_BACKEND: Service<typeof import("../src/realtime/rpc").RealtimeBackend>;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
