import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state.ts";
import { hasCode, signedInState } from "./helpers.ts";

/** The sign-in on disk: private, written under a lock, refused when unsafe. */

test("the state is written privately, and every update starts from what is on disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agw-v2-state-"));
  try {
    const store = new StateStore(dir);
    assert.deepEqual(await store.read(), { schemaVersion: 1, active: null });
    await store.update((state) => {
      state.active = signedInState("https://console.gw.example", "agw_oat_1").active;
    });
    if (process.platform !== "win32") assert.equal((await stat(store.path)).mode & 0o777, 0o600);
    // Two updates at once each see the other's write: the lock serialises them.
    await Promise.all([
      store.update((state) => {
        state.active!.account = { id: "org_2", name: "Two" };
      }),
      store.update((state) => {
        state.active!.login!.accessToken = "agw_oat_2";
      }),
    ]);
    const after = await store.read();
    assert.equal(after.active?.account?.id, "org_2");
    assert.equal(after.active?.login?.accessToken, "agw_oat_2");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a state file others can read, or one this release does not know, is refused", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "agw-v2-state-"));
  try {
    const store = new StateStore(dir);
    await store.update(() => {});
    await chmod(store.path, 0o644);
    await assert.rejects(store.read(), hasCode("unsafe_storage"));
    await chmod(store.path, 0o600);
    await writeFile(store.path, JSON.stringify({ schemaVersion: 2, active: null }));
    await assert.rejects(store.read(), hasCode("invalid_state"));
    assert.match(await readFile(store.path, "utf8"), /schemaVersion/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
