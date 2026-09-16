#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWranglerConfig, wranglerBin } from "./wrangler-config.mjs";
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
  pnpm recover-access -- --email <email> --password-stdin (--local|--remote) [--profile <name>]
  pnpm recover-access -- --email <email> --promote-owner --organization-id <id> (--local|--remote) [--profile <name>]

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
    `UPDATE mgmt_user_account
        SET password = ${sqlString(passwordHash)}, updated_at = ${Date.now()}
      WHERE provider_id = 'credential'
        AND user_id = (
          SELECT id FROM mgmt_user WHERE kind = 'human' AND email = ${sqlString(email)} COLLATE NOCASE
        );`,
  );
}
if (promoteOwner) {
  statements.push(
    `UPDATE mgmt_organization_user
        SET role = 'owner'
      WHERE organization_id = ${sqlString(organizationId)}
        AND user_id = (
          SELECT id FROM mgmt_user WHERE kind = 'human' AND email = ${sqlString(email)} COLLATE NOCASE
        );`,
    // Promoting a person is a claim, so it ends the account's recovery
    // deadline the same way the CLI claim does. Leaving the deadline behind
    // would hand them an account no credential — theirs included — can act in
    // once it passed.
    `UPDATE mgmt_organization
        SET expires_at = NULL, updated_at = ${sqlString(new Date().toISOString())}
      WHERE id = ${sqlString(organizationId)}
        AND EXISTS (
          SELECT 1 FROM mgmt_organization_user m
          JOIN mgmt_user u ON u.id = m.user_id
          WHERE m.organization_id = mgmt_organization.id AND m.role = 'owner' AND u.kind = 'human'
        );`,
  );
}

const recoveryDirectory = mkdtempSync(join(tmpdir(), "agw-recovery-"));
const recoveryFile = join(recoveryDirectory, "recovery.sql");
try {
  writeFileSync(recoveryFile, statements.join("\n"), { mode: 0o600 });
  const wranglerArgs = ["d1", "execute", "DB", target, "--file", recoveryFile];
  wranglerArgs.push(...resolveWranglerConfig(value("--profile")).configArgs);
  const result = spawnSync(wranglerBin, wranglerArgs, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  else console.log("Access recovery completed. Sign in and verify ownership before closing this shell.");
} finally {
  rmSync(recoveryDirectory, { recursive: true, force: true });
}
