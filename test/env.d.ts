import type { D1Migration } from "@cloudflare/vitest-pool-workers";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
      /** Empty at start of run; only test/migration.test.ts writes to it. */
      MIGRATION_DB: D1Database;
    }
  }
}

export {};
