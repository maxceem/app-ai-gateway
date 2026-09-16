import { build } from "esbuild";
import { chmod, mkdir } from "node:fs/promises";
import { cliManifest } from "./manifest.mjs";
await mkdir(new URL("../dist", import.meta.url), { recursive: true });
await build({
  entryPoints: [new URL("../src/bin.ts", import.meta.url).pathname],
  outfile: new URL("../dist/agw.mjs", import.meta.url).pathname,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: "#!/usr/bin/env node" },
  external: ["wrangler"],
  // Inlines `cli/package.json`'s version and pinned Wrangler, so the bundle
  // carries no manifest read. Running the sources directly reads the same file.
  define: { __AGW_MANIFEST__: JSON.stringify(await cliManifest()) },
});
await chmod(new URL("../dist/agw.mjs", import.meta.url), 0o755);
