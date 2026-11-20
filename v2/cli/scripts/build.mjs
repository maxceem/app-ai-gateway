import { build } from "esbuild";
import { chmod, mkdir, readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
await mkdir(new URL("../dist", import.meta.url), { recursive: true });
await build({
  entryPoints: [new URL("../src/bin.ts", import.meta.url).pathname],
  outfile: new URL("../dist/agw.mjs", import.meta.url).pathname,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: "#!/usr/bin/env node" },
  // Inlines the version, so the bundle reads no `package.json`. Running the
  // sources directly reads the same file.
  define: { __AGW_VERSION__: JSON.stringify(manifest.version) },
});
await chmod(new URL("../dist/agw.mjs", import.meta.url), 0o755);
