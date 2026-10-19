// Writes GatewayDemo/Resources/snippets.json: the code the demo's </> sheet
// shows for each kind of chat, cut from the demo's own source, so what the
// sheet shows is what the app runs.
//
//   node --experimental-strip-types examples/ios/scripts/generate-snippets.ts
//   node --experimental-strip-types examples/ios/scripts/generate-snippets.ts --check
//
// A snippet is the lines between two markers in any Swift file of the app:
//
//   // snippet chat,image: What these lines do
//   ...
//   // snippet end
//
// Each kind shows its snippets with the client setup first, then the rest in
// file order. `--check` fails when the bundled file is out of date.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const KINDS = ["chat", "image", "transcription", "voice"] as const;
type Kind = (typeof KINDS)[number];
interface Snippet { file: string; caption: string; code: string }

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "../GatewayDemo");
const out = join(app, "Resources/snippets.json");

function swiftFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return swiftFiles(path);
    return entry.name.endsWith(".swift") ? [path] : [];
  });
}

/** Lines without their shared indentation, and without blank lines at either end. */
function dedent(lines: string[]): string {
  while (lines.length && !lines[0]!.trim()) lines.shift();
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  const indent = Math.min(...lines.filter((line) => line.trim()).map((line) => line.length - line.trimStart().length));
  return lines.map((line) => line.slice(indent).trimEnd()).join("\n");
}

const START = /^\s*\/\/ snippet ([a-z,]+): (.+)$/u;
const END = /^\s*\/\/ snippet end$/u;
const snippets = Object.fromEntries(KINDS.map((kind) => [kind, [] as Snippet[]])) as Record<Kind, Snippet[]>;

// The client is set up once for every kind, so its file reads first.
const files = swiftFiles(app).sort((a, b) =>
  Number(!a.endsWith("GatewayBackend.swift")) - Number(!b.endsWith("GatewayBackend.swift")) || a.localeCompare(b));
for (const path of files) {
  const file = relative(app, path);
  let open: { kinds: Kind[]; caption: string; line: number; lines: string[] } | null = null;
  readFileSync(path, "utf8").split("\n").forEach((line, index) => {
    const start = START.exec(line);
    if (start) {
      if (open) throw new Error(`${file}:${index + 1}: a snippet starts inside the one from line ${open.line}`);
      const kinds = start[1]!.split(",");
      const unknown = kinds.find((kind) => !KINDS.includes(kind as Kind));
      if (unknown) throw new Error(`${file}:${index + 1}: unknown kind "${unknown}"`);
      open = { kinds: kinds as Kind[], caption: start[2]!, line: index + 1, lines: [] };
    } else if (END.test(line)) {
      if (!open) throw new Error(`${file}:${index + 1}: "snippet end" without a start`);
      for (const kind of open.kinds) snippets[kind].push({ file, caption: open.caption, code: dedent(open.lines) });
      open = null;
    } else if (open) {
      open.lines.push(line);
    }
  });
  if (open) throw new Error(`${file}: the snippet from line ${(open as { line: number }).line} has no end`);
}

const missing = KINDS.filter((kind) => snippets[kind].length === 0);
if (missing.length) throw new Error(`No snippets for ${missing.join(", ")}`);

const json = `${JSON.stringify(snippets, null, 2)}\n`;
if (process.argv.includes("--check")) {
  let current = "";
  try { current = readFileSync(out, "utf8"); } catch { /* missing counts as stale */ }
  if (current !== json) {
    console.error(`${relative(process.cwd(), out)} is out of date: run examples/ios/scripts/generate-snippets.ts`);
    process.exit(1);
  }
  console.log("Snippets are up to date");
} else {
  writeFileSync(out, json);
  console.log(`Wrote ${out}`);
}
