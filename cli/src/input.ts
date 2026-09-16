import { createInterface } from "node:readline/promises";
import { stdin, stderr } from "node:process";
import { fail } from "./common.ts";
import type { Flags } from "./parser.ts";

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
          continue;
        }
        if (char >= " ") value += char;
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
