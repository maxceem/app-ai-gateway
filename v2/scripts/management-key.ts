/**
 * Creates a management key for an account of a v2 deployment, and prints it
 * once. Until the console signs people in (step 2), this is how a deployment
 * gets its first key.
 *
 *   node --experimental-strip-types scripts/management-key.ts --account <id> [--create-account <name>] \
 *     [--grant manage|read] [--remote -c wrangler.<profile>.jsonc]
 *
 * - The key is printed to stdout once, and never written anywhere. Store it
 *   in a password manager or a secret store. Never commit it.
 * - Only its SHA-256 hash reaches the database, so the command that writes
 *   it carries no secret.
 * - `--create-account` also creates the account (and a service user that owns
 *   it) when it does not exist yet, and activates it: its owner is a key, with
 *   no address to verify. An account that already exists is left as it is.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { managementKeyStatements } from "./management-key-sql.ts";

const args = process.argv.slice(2);
function option(name: string): string | undefined {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
}

const accountId = option("--account");
const accountName = option("--create-account");
const grant = option("--grant") ?? "manage";
const config = option("-c");
const remote = args.includes("--remote");
if (accountId === undefined || !/^[A-Za-z0-9_-]{1,64}$/u.test(accountId) || (grant !== "manage" && grant !== "read")) {
  console.error("usage: management-key.ts --account <id> [--create-account <name>] [--grant manage|read] [--remote -c <config>]");
  process.exit(2);
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
let entropy = "";
while (entropy.length < 48) {
  for (const byte of randomBytes(64)) {
    if (byte < 248 && entropy.length < 48) entropy += ALPHABET[byte % 62];
  }
}
const key = `agw_mgmt_${entropy}`;
const hash = createHash("sha256").update(key).digest("hex");
const statements = managementKeyStatements({
  accountId,
  ...(accountName === undefined ? {} : { accountName }),
  userId: `svc_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
  keyId: `mk_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
  hash,
  hint: key.slice(-4),
  grant: grant as "manage" | "read",
  now: Date.now(),
});

execFileSync(
  "pnpm",
  ["exec", "wrangler", "d1", "execute", "DB", remote ? "--remote" : "--local", ...(config === undefined ? [] : ["-c", config]), "--command", statements.join("\n")],
  { stdio: ["ignore", "ignore", "inherit"] },
);
console.log(key);
