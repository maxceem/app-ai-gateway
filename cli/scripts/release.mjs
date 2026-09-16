import { spawnSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { assertVersionsAgree, cliManifest } from "./manifest.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
// One version, checked here rather than trusted: `cli/package.json` names the
// npm release and the root `package.json` names the gateway release the bundle
// carries. The CLI refuses to deploy any other gateway version, so a release
// built while they disagree could never be installed.
const version = await assertVersionsAgree();
const { wrangler } = await cliManifest();
const out = resolve(root, "cli/dist/release", version);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  if (result.status !== 0) throw new Error("Release build failed");
}
run("pnpm", ["run", "console:build"]);
run(process.execPath, [
  resolve(root, "cli/node_modules/wrangler/bin/wrangler.js"),
  "deploy",
  "--dry-run",
  "--outdir",
  join(out, "worker"),
]);
await rm(join(out, "worker/index.js.map"), { force: true });
await rm(join(out, "worker/README.md"), { force: true });
await cp(resolve(root, "console/dist"), join(out, "console"), {
  recursive: true,
});
await cp(resolve(root, "migrations"), join(out, "migrations"), {
  recursive: true,
  filter: (source) => !source.includes("/meta"),
});
const config = parse(await readFile(resolve(root, "wrangler.jsonc"), "utf8"));
delete config.$schema;
config.main = "./worker/index.js";
config.no_bundle = true;
config.assets.directory = "./console";
config.d1_databases = [{ binding: "DB", migrations_dir: "migrations" }];
config.vars.ALLOW_ADDITIONAL_REGISTRATIONS = "false";
await writeFile(join(out, "wrangler.json"), JSON.stringify(config, null, 2));
const files = {};
async function walk(dir) {
  for (const entry of await readdir(join(out, dir), { withFileTypes: true })) {
    const path = dir ? dir + "/" + entry.name : entry.name;
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile())
      files[path] = createHash("sha256")
        .update(await readFile(join(out, path)))
        .digest("hex");
    else throw new Error("Release cannot contain links");
  }
}
await walk("");
const manifest = {
  format: 1,
  version,
  node: "22.19.0",
  wrangler,
  schema: 1,
  upgradeFrom: [version],
  files,
};
const serialized = JSON.stringify(manifest, null, 2) + "\n";
await writeFile(join(out, "manifest.json"), serialized);
await writeFile(
  new URL("../dist/release-integrity.json", import.meta.url),
  JSON.stringify({
    version,
    sha256: createHash("sha256").update(serialized).digest("hex"),
  }),
);
await import("./build.mjs");
