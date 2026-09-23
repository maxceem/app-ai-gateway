import { test } from "node:test";
import assert from "node:assert/strict";
import { advance, matchExisting, selectedInstallation } from "../src/installation.ts";
import type { CloudflareClient } from "../src/cloudflare.ts";
import type { InstallationJournal } from "../src/state.ts";
import { hasCode, stubContext } from "./helpers.ts";

test("a journal reaches a phase and its patch in one write", async () => {
  let saves = 0;
  const ctx = stubContext({
    save: async () => {
      saves++;
    },
  });
  const journal: InstallationJournal = {
    id: "deployment-1",
    name: "worker",
    accountId: "account-cf",
    version: "0.1.0",
    phase: "prepared",
    secrets: { JWT_SECRET: "SENTINEL-JWT" },
  };
  await advance(ctx, journal, "deployed", { databaseId: "db-1" });
  assert.equal(journal.phase, "deployed");
  assert.equal(journal.databaseId, "db-1");
  // One write, and the phase is on disk with what changed alongside it: a
  // journal that recorded a phase without its patch would resume from a step
  // it had not finished.
  assert.equal(saves, 1);
  await advance(ctx, journal, "ready", {
    pendingDomain: "ai.example.com",
    secrets: undefined,
  });
  assert.equal(journal.phase, "ready");
  assert.equal(journal.pendingDomain, "ai.example.com");
  // A patched `undefined` drops the field, which is how a secret the Worker
  // now holds leaves the state file for good.
  assert.equal(Object.hasOwn(journal, "secrets"), false);
  assert.equal(JSON.stringify(journal).includes("SENTINEL"), false);
  assert.equal(saves, 2);
});

/** Answers for one Worker: the identity binding, its D1 and its domains. */
function boundWorker(): CloudflareClient {
  return {
    authenticate: async () => {},
    account: async () => "account-cf",
    all: (async (path: string) =>
      path.endsWith("/workers/domains")
        ? [{ hostname: "existing.example.com", service: "worker" }]
        : []) as CloudflareClient["all"],
    request: (async () =>
      ({
        success: true,
        result: {
          bindings: [
            { name: "DEPLOYMENT_ID", type: "plain_text", text: "deployment-1" },
            { name: "DB", type: "d1", id: "db" },
          ],
        },
      })) as unknown as CloudflareClient["request"],
    run: async () => "",
  };
}

test("an inventory is matched against the installation it was given", async () => {
  const journal: InstallationJournal = {
    id: "deployment-1",
    name: "worker",
    accountId: "account-cf",
    databaseId: "db",
    version: "0.1.0",
    phase: "ready",
    url: "https://worker.example",
    pendingDomain: "new.example.com",
  };
  const installations: Record<string, InstallationJournal> = { "deployment-1": journal };
  const asked: (string | undefined)[] = [];
  const ctx = stubContext({
    // The connection this command is on is a different deployment entirely,
    // which is the situation a setup resuming a pending domain is in.
    active: {
      url: "https://cloud.example",
      authenticated: true,
      deployment: { id: "other", mode: "cloud" },
    },
    url: "https://cloud.example",
    state: { installations },
    save: async () => {},
    publicCall: async (name: string, options: { url?: string }) => {
      assert.equal(name, "getCliCapabilities");
      asked.push(options.url);
      return { data: { deployment: { id: "deployment-1" }, serverVersion: "0.2.0" } };
    },
  });
  const matched = await matchExisting(ctx, boundWorker(), { "dry-run": true }, {
    url: journal.url!,
    deploymentId: journal.id,
    installations,
  });
  assert.equal(matched.id, "deployment-1");
  assert.equal(matched.pendingDomain, "new.example.com");
  // Verified at the installation's own URL, not the selected connection's, and
  // its inventory read back from the Worker the journal names.
  assert.deepEqual(asked, ["https://worker.example"]);
  assert.equal(matched.version, "0.2.0");
  assert.deepEqual(matched.domains, ["existing.example.com"]);
  // The selected connection is the other question, and it has its own answer:
  // this one is on cloud, so there is no installation of it to match.
  assert.throws(() => selectedInstallation(ctx), hasCode("not_self_hosted"));
});
