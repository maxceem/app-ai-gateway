import { createInterface } from "node:readline/promises";
import { stdin, stderr } from "node:process";
import { fail } from "./common.ts";
import type { Flags } from "./parser.ts";

/**
 * How many characters of a hidden value are acknowledged on screen.
 *
 * One asterisk per character, so a paste is visibly received rather than
 * leaving somebody staring at a prompt that looks dead. The mask stops here
 * because a pasted key is often hundreds of characters: past a line's worth,
 * more asterisks only wrap the terminal and scroll the prompt away, and they
 * say nothing the first sixty-four have not already said. The value itself is
 * never echoed.
 */
const MASK_LIMIT = 64;

/**
 * What to write so that the mask on screen matches a value of this length:
 * asterisks for what has arrived, `\b \b` for what a backspace removed.
 */
export function maskDelta(shown: number, length: number): string {
  const target = Math.min(length, MASK_LIMIT);
  return target > shown ? "*".repeat(target - shown) : "\b \b".repeat(shown - target);
}

export async function prompt(
  label: string,
  flags: Flags,
  { hidden = false, defaultValue }: { hidden?: boolean; defaultValue?: string } = {},
): Promise<string> {
  if (flags["no-input"] || !stdin.isTTY || !stderr.isTTY)
    fail(
      "input_required",
      `${label} is required.`,
      hidden
        ? "Use --key-stdin or --browser --no-open."
        : "Supply the required flag with --no-input.",
    );
  if (!hidden) {
    const rl = createInterface({ input: stdin, output: stderr });
    try {
      return (
        (
          await rl.question(
            `${label}${defaultValue ? ` [${defaultValue}]` : ""}: `,
          )
        ).trim() || (defaultValue ?? "")
      );
    } finally {
      rl.close();
    }
  }
  stderr.write(`${label}: `);
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = "";
    let shown = 0;
    function mask(): void {
      const delta = maskDelta(shown, value.length);
      if (delta) stderr.write(delta);
      shown = Math.min(value.length, MASK_LIMIT);
    }
    function done(error?: Error): void {
      stdin.off("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stderr.write("\n");
      if (error) reject(error);
      else resolve(value);
    }
    function onData(chunk: Buffer): void {
      for (const char of chunk.toString()) {
        if (char === "") {
          done(new Error("cancelled"));
          return;
        }
        if (char === "\r" || char === "\n") {
          done();
          return;
        }
        if (char === "" || char === "\b") {
          value = value.slice(0, -1);
          mask();
          continue;
        }
        if (char >= " ") {
          value += char;
          mask();
        }
        if (value.length > 16384) {
          done(new Error("input too long"));
          return;
        }
      }
    }
    stdin.on("data", onData);
  });
}

export async function secret(flags: Flags, label = "API key"): Promise<string | undefined> {
  if (flags.browser) return undefined;
  let value: string;
  if (flags["key-stdin"]) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stdin) {
      size += chunk.length;
      if (size > 16384) fail("invalid_input", "Secret input exceeds 16 KiB.");
      chunks.push(chunk);
    }
    value = Buffer.concat(chunks).toString().trim();
  } else value = await prompt(label, flags, { hidden: true });
  if (!value || /[\r\n\0]/.test(value))
    fail("invalid_input", "Supply one nonempty secret line.");
  return value;
}

export async function confirm(message: string, flags: Flags): Promise<void> {
  if (flags.yes) return;
  if (
    (await prompt(`${message} Type yes to continue`, flags)).toLowerCase() !==
    "yes"
  )
    fail("cancelled", "Action cancelled.", "No mutation was made.", 4);
}
