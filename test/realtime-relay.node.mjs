// The realtime Worker runs no gateway code, so gateway releases and price
// updates reuse it and leave its sessions open. This builds its real bundle
// and checks what went in.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

test("the realtime Worker bundles only its own folder", async () => {
  const out = await mkdtemp(join(tmpdir(), "realtime-relay-"));
  try {
    const built = spawnSync(
      process.execPath,
      [join(root, "node_modules/wrangler/bin/wrangler.js"), "deploy", "--dry-run", "--config", "wrangler.realtime.jsonc", "--outdir", out],
      { cwd: root, encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
    );
    assert.equal(built.status, 0, built.stderr);
    const bundle = await readFile(join(out, "worker.js"), "utf8");
    // esbuild names each module it includes in a `// path` comment.
    const modules = [...bundle.matchAll(/^\/\/ ((?:src|node_modules)\/\S+)$/gmu)].map((match) => match[1]);
    assert.ok(modules.includes("src/realtime/relay/worker.ts"), "the bundle lists its modules");
    const outside = modules.filter((path) => !path.startsWith("src/realtime/relay/"));
    assert.deepEqual(
      outside,
      [],
      "Import only from src/realtime/relay/ in the realtime Worker. Ask the gateway through " +
        "src/realtime/relay/contract.ts for anything else; `import type` is fine.",
    );
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test("the realtime Worker runs on the gateway's compatibility date", async () => {
  // One compatibility date for every deployment, kept in wrangler.jsonc.
  const date = (file) => /"compatibility_date"\s*:\s*"([^"]+)"/u.exec(readFileSync(join(root, file), "utf8"))?.[1];
  assert.ok(date("wrangler.jsonc"));
  assert.equal(date("wrangler.realtime.jsonc"), date("wrangler.jsonc"));
});
