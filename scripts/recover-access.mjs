#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hashPassword } from "better-auth/crypto";

const args = process.argv.slice(2);

function value(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function has(name) {
  return args.includes(name);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function sqlString(input) {
  return `'${input.replaceAll("'", "''")}'`;
}

if (has("--help")) {
  console.log(`Usage:
  pnpm recover-access -- --email <email> --password-stdin (--local|--remote) [--env <name>]
  pnpm recover-access -- --email <email> --promote-owner --organization-id <id> (--local|--remote) [--env <name>]

Both recovery operations may be requested together. The script executes only
against the D1 target explicitly selected with --local or --remote.`);
  process.exit(0);
}

const email = value("--email")?.trim().toLowerCase();
const password = has("--password-stdin") ? readFileSync(0, "utf8").replace(/[\r\n]+$/u, "") : undefined;
const organizationId = value("--organization-id")?.trim();
const promoteOwner = has("--promote-owner");
const target = has("--remote") ? "--remote" : has("--local") ? "--local" : undefined;

if (!email) fail("--email is required");
if (!target || (has("--remote") && has("--local"))) {
  fail("Choose exactly one explicit D1 target: --local or --remote");
}
if (!password && !promoteOwner) fail("Provide --password-stdin and/or --promote-owner");
if (password && password.length < 8) fail("The password supplied on stdin must contain at least 8 characters");
if (promoteOwner && !organizationId) fail("--organization-id is required with --promote-owner");

const statements = [];
if (password) {
  const passwordHash = await hashPassword(password);
  statements.push(
    `UPDATE console_user_account
        SET password = ${sqlString(passwordHash)}, updated_at = ${Date.now()}
      WHERE provider_id = 'credential'
        AND user_id = (
          SELECT id FROM console_user WHERE email = ${sqlString(email)} COLLATE NOCASE
        );`,
  );
}
if (promoteOwner) {
  statements.push(
    `UPDATE console_organization_user
        SET role = 'owner'
      WHERE organization_id = ${sqlString(organizationId)}
        AND user_id = (
          SELECT id FROM console_user WHERE email = ${sqlString(email)} COLLATE NOCASE
        );`,
  );
}

const wranglerBin = fileURLToPath(new URL("../node_modules/.bin/wrangler", import.meta.url));
const wranglerArgs = ["d1", "execute", "DB", target, "--command", statements.join("\n")];
const environment = value("--env");
if (environment) wranglerArgs.push("--env", environment);

const result = spawnSync(wranglerBin, wranglerArgs, { stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log("Access recovery SQL completed. Sign in and verify ownership before closing this shell.");
