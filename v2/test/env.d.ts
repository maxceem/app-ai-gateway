import type { D1Migration } from "@cloudflare/vitest-pool-workers";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
      /** "1" in the split-key run (`vitest.config.ts`, `test/split-keys.ts`). */
      TEST_SPLIT_KEYS?: string;
    }
  }
}

export {};
