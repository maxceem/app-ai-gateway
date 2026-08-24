#!/usr/bin/env node
import { randomUUID } from "node:crypto";
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
  pnpm migrate-to-orgs -- --email <email> --password <password> (--local|--remote) [options]
  pnpm migrate-to-orgs -- --email <email> --password-stdin (--local|--remote) [options]

Options:
  --name <name>                   Operator display name (defaults to email prefix)
  --organization-name <name>     Organization name (defaults to "<name>'s Organization")
  --organization-id <id>         Explicit organization ID (defaults to a UUID)
  --env <name>                   Wrangler environment
  --persist-to <directory>       Isolated local D1 state; valid only with --local

This one-time migration creates an owner and credential account, creates an
organization, and assigns every app whose organization_id is NULL. The D1 target
must be selected explicitly. Prefer --password-stdin to keep secrets out of shell history.`);
  process.exit(0);
}

const email = value("--email")?.trim().toLowerCase();
const passwordArgument = value("--password");
const password = has("--password-stdin")
  ? readFileSync(0, "utf8").replace(/[\r\n]+$/u, "")
  : passwordArgument;
const name = value("--name")?.trim() || email?.split("@")[0];
const organizationId = value("--organization-id")?.trim() || randomUUID();
const organizationName = value("--organization-name")?.trim() || `${name}'s Organization`;
const target = has("--remote") ? "--remote" : has("--local") ? "--local" : undefined;
const persistTo = value("--persist-to")?.trim();

if (!email || !email.includes("@")) fail("--email must be a valid email address");
if (!target || (has("--remote") && has("--local"))) {
  fail("Choose exactly one explicit D1 target: --local or --remote");
}
if (passwordArgument !== undefined && has("--password-stdin")) {
  fail("Choose exactly one password source: --password or --password-stdin");
}
if (!password || password.length < 8) fail("The password must contain at least 8 characters");
if (!name) fail("--name cannot be empty");
if (!organizationName) fail("--organization-name cannot be empty");
if (persistTo && target !== "--local") fail("--persist-to is valid only with --local");

const nowEpoch = Date.now();
const nowIso = new Date(nowEpoch).toISOString();
const userId = randomUUID();
const accountId = randomUUID();
const membershipId = randomUUID();
const passwordHash = await hashPassword(password);

const statements = [
  `INSERT INTO operator_user(id, name, email, email_verified, created_at, updated_at)
   VALUES (${sqlString(userId)}, ${sqlString(name)}, ${sqlString(email)}, 1, ${nowEpoch}, ${nowEpoch});`,
  `INSERT INTO operator_account(id, account_id, provider_id, user_id, password, created_at, updated_at)
   VALUES (${sqlString(accountId)}, ${sqlString(userId)}, 'credential', ${sqlString(userId)}, ${sqlString(passwordHash)}, ${nowEpoch}, ${nowEpoch});`,
  `INSERT INTO operator_organization(id, name, created_by_user_id, created_at, updated_at)
   VALUES (${sqlString(organizationId)}, ${sqlString(organizationName)}, ${sqlString(userId)}, ${sqlString(nowIso)}, ${sqlString(nowIso)});`,
  `INSERT INTO operator_organization_user(id, organization_id, user_id, role, status, joined_at)
   VALUES (${sqlString(membershipId)}, ${sqlString(organizationId)}, ${sqlString(userId)}, 'owner', 'active', ${sqlString(nowIso)});`,
  `UPDATE apps SET organization_id = ${sqlString(organizationId)} WHERE organization_id IS NULL;`,
];

const wranglerBin = fileURLToPath(new URL("../node_modules/.bin/wrangler", import.meta.url));
const wranglerArgs = ["d1", "execute", "DB", target, "--command", statements.join("\n")];
const environment = value("--env");
if (environment) wranglerArgs.push("--env", environment);
if (persistTo) wranglerArgs.push("--persist-to", persistTo);

const result = spawnSync(wranglerBin, wranglerArgs, { stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

console.log(`Organization migration completed for ${email}.`);
console.log(`Organization ID: ${organizationId}`);
console.log("Next steps:");
console.log("1. Sign in and verify that every expected app is visible.");
console.log("2. Create and securely store an agw_mgmt_ management key if automation needs one.");
console.log("3. Close public registration if this is a private deployment.");
console.log("4. After verification, manually delete the obsolete ADMIN_TOKEN secret:");
console.log("   pnpm exec wrangler secret delete ADMIN_TOKEN [--env <name>]");
