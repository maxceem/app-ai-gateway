import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach } from "vitest";
import { pauseLedgerWork } from "./helpers.ts";
import { localVault } from "./local-vault.ts";
import { setVaultForTests } from "../src/vault/client.ts";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

// The ledger objects set no alarm unless a test lets them (`allowLedgerWork()`):
// an alarm would run the real sweep and nightly clean-up at the real time, over
// rows each test dates at its own, and an alarm left set keeps the run from
// ending. Paused from the start, so writes in `beforeAll` set none either.
pauseLedgerWork();
beforeEach(() => pauseLedgerWork());

// The vault Worker's own code, run in this Worker, so each test's fetch
// stand-in sees what the vault sends. `vault-binding.test.ts` runs the same
// code through the real `VAULT` binding.
setVaultForTests(localVault);
