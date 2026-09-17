import { spawnSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
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
const { wrangler, upgradeFrom } = await cliManifest();
// The whole directory, not just this version's. Nothing here reaches npm any
// more, but this tree is what the archive is packed from and what a
// contributor's own CLI runs against, so a release left behind by an earlier
// build has to go: it is a gateway this CLI refuses to deploy anyway, carrying
// whatever that version got wrong.
const out = resolve(root, "cli/dist/release", version);
await rm(resolve(root, "cli/dist/release"), { recursive: true, force: true });
await mkdir(out, { recursive: true });
// Same reasoning for the packed archives: only the one cut here may be left for
// `cli/scripts/publish-release.mjs` to upload.
for (const entry of await readdir(resolve(root, "cli/dist")))
  if (entry.startsWith("gateway-") && entry.endsWith(".tar.gz"))
    await rm(resolve(root, "cli/dist", entry), { force: true });
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
  upgradeFrom,
  files,
};
const serialized = JSON.stringify(manifest, null, 2) + "\n";
await writeFile(join(out, "manifest.json"), serialized);

// The archive the published CLI downloads, packed from the tree just built.
//
// `tar` from the system for creation only — reading one back is the untrusted
// side, and `cli/src/archive.ts` does that itself. `--format ustar` is what
// makes the pair work: the default on some platforms is pax, whose extended
// headers that reader refuses on purpose. Members are named individually so
// their paths are relative to the version directory with no `./` prefix, and
// the gzip wrapper is written here rather than by `tar` because Node's leaves
// no timestamp in the header.
const archive = resolve(root, `cli/dist/gateway-${version}.tar.gz`);
const members = (await readdir(out)).sort();
const packed = spawnSync(
  "tar",
  ["--format", "ustar", "--numeric-owner", "-cf", "-", "-C", out, ...members],
  { maxBuffer: 256 * 1024 * 1024 },
);
if (packed.status !== 0 || !packed.stdout?.length)
  throw new Error(`Packing the release archive failed: ${packed.stderr ?? ""}`);
const compressed = gzipSync(packed.stdout, { level: 9 });
await writeFile(archive, compressed);

// Where that archive will live, and the two digests the CLI holds it to. A fork
// publishing its own builds points them at its own releases; nothing else about
// the trust chain changes, because the bundle is built from this file below and
// carries whatever it says.
const base =
  process.env.AGW_RELEASE_URL_BASE ??
  "https://github.com/maxceem/app-ai-gateway/releases/download";
await writeFile(
  new URL("../dist/release-integrity.json", import.meta.url),
  JSON.stringify({
    version,
    url: `${base}/v${version}/gateway-${version}.tar.gz`,
    sha256: createHash("sha256").update(compressed).digest("hex"),
    manifest: createHash("sha256").update(serialized).digest("hex"),
  }),
);
// Last, so the bundle inlines the integrity file that was just written.
await import("./build.mjs");
