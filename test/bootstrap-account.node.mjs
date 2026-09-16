import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, chmod, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapAccount } from "../scripts/bootstrap-account.mjs";

const options = { url: "https://gateway.test" };
const capabilities = { deployment: { mode: "self_hosted", id: "deployment-test" } };
const response = {
  deployment: { id: "deployment-test" },
  credential: { token: "fixture-management-token" },
};
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), "agw-bootstrap-test-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("lost bootstrap response retries durable proofs and recovers private output", async (t) => {
  const dir = await directory(t);
  const requests = [];
  let fail = true;
  const fetchImpl = async (url, init) => {
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    if (url.endsWith("/capabilities")) return Response.json(capabilities);
    requests.push(JSON.parse(init.body));
    assert.deepEqual(
      JSON.parse(await readFile(join(dir, "state.json"), "utf8")).pollToken,
      requests[0].pollToken,
    );
    if (fail) {
      fail = false;
      throw Error("fixture-network-secret-must-not-escape");
    }
    return Response.json(response);
  };
  await assert.rejects(
    bootstrapAccount({ ...options, directory: dir, fetchImpl }),
    (error) =>
      !error.message.includes("fixture-network-secret") &&
      error.message.includes("same saved state"),
  );
  const result = await bootstrapAccount({ ...options, directory: dir, fetchImpl });
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(await readFile(result.keyFile, "utf8"), response.credential.token + "\n");
  assert.equal((await stat(result.keyFile)).mode & 0o077, 0);
  assert.equal((await stat(join(dir, "state.json"))).mode & 0o077, 0);
  assert.equal((await bootstrapAccount({ ...options, directory: dir, fetchImpl })).recovered, true);
  assert.equal(requests.length, 2);
  await assert.rejects(bootstrapAccount({ ...options, url: "https://other.test", directory: dir, fetchImpl }), /different deployment/);
});

test("concurrent initialization is locked before a second network request", async (t) => {
  const dir = await directory(t);
  let unblock, entered;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    unblock = resolve;
  });
  const first = bootstrapAccount({
    ...options,
    directory: dir,
    fetchImpl: async (url) => {
      if (url.endsWith("/capabilities")) return Response.json(capabilities);
      entered();
      await gate;
      return Response.json(response);
    },
  });
  await waiting;
  await assert.rejects(
    bootstrapAccount({
      ...options,
      directory: dir,
      fetchImpl: () => assert.fail("locked process made a request"),
    }),
    /locked/,
  );
  unblock();
  await first;
  await assert.rejects(stat(join(dir, "initialization.lock")), { code: "ENOENT" });
});

test("publication never overwrites a file that appears while bootstrap runs", async (t) => {
  const dir = await directory(t);
  await assert.rejects(
    bootstrapAccount({
      ...options,
      directory: dir,
      fetchImpl: async (url) => {
        if (url.endsWith("/capabilities")) return Response.json(capabilities);
        await writeFile(join(dir, "management-key"), "existing-value\n", { mode: 0o600 });
        return Response.json(response);
      },
    }),
    /not overwritten/,
  );
  assert.equal(await readFile(join(dir, "management-key"), "utf8"), "existing-value\n");
});

test("corrupt or insecure saved state and empty credentials fail closed", async (t) => {
  const dir = await directory(t);
  const fetchImpl = async (url) => {
    assert.ok(url.endsWith("/capabilities"));
    return Response.json(capabilities);
  };
  const path = join(dir, "state.json");
  await writeFile(path, '{"pollToken":"SENTINEL-PRIVATE-PROOF', { mode: 0o600 });
  await assert.rejects(
    bootstrapAccount({ ...options, directory: dir, fetchImpl }),
    (error) => error.message.includes("malformed") && !error.message.includes("SENTINEL"),
  );
  await chmod(path, 0o644);
  await assert.rejects(bootstrapAccount({ ...options, directory: dir, fetchImpl }), /0600/);
  await unlink(path);
  await writeFile(join(dir, "management-key"), "", { mode: 0o600 });
  await assert.rejects(
    bootstrapAccount({ ...options, directory: dir, fetchImpl }),
    /empty or malformed/,
  );
  await chmod(join(dir, "management-key"), 0o644);
  await assert.rejects(bootstrapAccount({ ...options, directory: dir, fetchImpl }), /0600/);
});

test("JSON response parse failures do not expose remote credential text", async (t) => {
  const dir = await directory(t);
  await assert.rejects(
    bootstrapAccount({
      ...options,
      directory: dir,
      fetchImpl: async () => new Response('{"credential":"SENTINEL-PRIVATE-KEY'),
    }),
    (error) => !error.message.includes("SENTINEL"),
  );
});
