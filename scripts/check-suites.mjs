// The whole-suite run goes through the barrels in `test/suites`, so a test file
// that no barrel imports is silently never run. This is the guard against that,
// and against a file being run twice because two barrels import it.
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const files = (await readdir(`${root}test`)).filter((name) => name.endsWith(".test.ts"));
const barrels = (await readdir(`${root}test/suites`)).filter((name) => name.endsWith(".suite.ts"));

const owners = new Map(files.map((file) => [file.replace(/\.test\.ts$/, ""), []]));
for (const barrel of barrels) {
  const source = await readFile(`${root}test/suites/${barrel}`, "utf8");
  for (const [, name] of source.matchAll(/^import "\.\.\/(.+)\.test";$/gm)) {
    const owner = owners.get(name);
    if (owner === undefined) {
      console.error(`${barrel} imports test/${name}.test.ts, which does not exist`);
      process.exit(1);
    }
    owner.push(barrel);
  }
}

const problems = [...owners]
  .filter(([, list]) => list.length !== 1)
  .map(([name, list]) =>
    list.length === 0
      ? `test/${name}.test.ts is in no barrel, so the suite never runs it`
      : `test/${name}.test.ts is in ${list.length} barrels (${list.join(", ")})`,
  );
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
console.log(`${files.length} test files across ${barrels.length} barrels`);
