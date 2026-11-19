// Workers Static Assets reads `_headers` only at the root of the assets
// directory (`dist/`), but Vite copies `public/` into its output, `dist/v2/`.
// This moves the file up one level after the build.
import { renameSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
renameSync(`${dist}v2/_headers`, `${dist}_headers`);
