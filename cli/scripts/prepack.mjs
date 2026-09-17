import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { assertVersionsAgree } from "./manifest.mjs";

/**
 * Guards `npm pack` and `npm publish`, and rebuilds only the executable.
 *
 * It must not run the release build. Packing the gateway again would produce an
 * archive with new timestamps and therefore a new digest, and the bundle would
 * be published carrying that digest while the asset on the GitHub release is
 * the one the earlier build packed — every install would refuse it. So the
 * archive that was uploaded is the archive this checks against, and the bundle
 * is rebuilt from the integrity file that was written beside it.
 */
const version = await assertVersionsAgree();
const advice =
  `Run \`pnpm run cli:release:github\` first: publishing ${version} means publishing the digest ` +
  "of the archive that release build packed and uploaded.";

let integrity;
try {
  integrity = JSON.parse(
    await readFile(new URL("../dist/release-integrity.json", import.meta.url), "utf8"),
  );
} catch {
  throw new Error(`cli/dist/release-integrity.json is missing. ${advice}`);
}
if (integrity.version !== version)
  throw new Error(
    `cli/dist/release-integrity.json describes ${integrity.version}, not ${version}. ${advice}`,
  );

let archive;
try {
  archive = await readFile(new URL(`../dist/gateway-${version}.tar.gz`, import.meta.url));
} catch {
  throw new Error(`cli/dist/gateway-${version}.tar.gz is missing. ${advice}`);
}
if (createHash("sha256").update(archive).digest("hex") !== integrity.sha256)
  throw new Error(
    `cli/dist/gateway-${version}.tar.gz is not the archive cli/dist/release-integrity.json describes. ${advice}`,
  );

await import("./build.mjs");
console.log(
  `Packing agw ${version}; it will download ${integrity.url} and require sha256 ${integrity.sha256}.`,
);
