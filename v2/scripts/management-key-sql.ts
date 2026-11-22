/**
 * The statements `management-key.ts` runs, built apart from the command so a
 * test can run them against a database. Plain strings only: nothing here may
 * import Node, so the Worker's tests can load it too.
 */

export interface ManagementKeyWrite {
  accountId: string;
  /** Set to create the account when it does not exist yet. */
  accountName?: string;
  /** A fresh service user, unique to this run: the account it creates is known by it. */
  userId: string;
  keyId: string;
  /** The key's SHA-256, hex. */
  hash: string;
  hint: string;
  grant: "manage" | "read";
  now: number;
}

const sqlText = (value: string) => `'${value.replaceAll("'", "''")}'`;

export function managementKeyStatements(write: ManagementKeyWrite): string[] {
  const { accountId, accountName, userId, keyId, hash, hint, grant, now } = write;
  const iso = new Date(now).toISOString();
  return [
    `INSERT INTO mgmt_user (id, name, email, kind, email_verified, created_at, updated_at)
     VALUES (${sqlText(userId)}, 'Management key owner', NULL, 'service', 0, ${now}, ${now});`,
    ...(accountName === undefined
      ? []
      : [
          `INSERT OR IGNORE INTO mgmt_organization (id, name, created_by_user_id, created_at, updated_at)
           VALUES (${sqlText(accountId)}, ${sqlText(accountName)}, ${sqlText(userId)}, ${sqlText(iso)}, ${sqlText(iso)});`,
          // The account this run made serves its apps: its owner is a key, with
          // no address to verify. Only an account this run created, never one
          // that already existed and is still waiting for its owner's email.
          `INSERT OR IGNORE INTO account_activation (account_id, activated_at)
           SELECT id, ${now} FROM mgmt_organization WHERE id = ${sqlText(accountId)} AND created_by_user_id = ${sqlText(userId)};`,
        ]),
    `INSERT INTO mgmt_organization_user (id, organization_id, user_id, role, status, joined_at)
     VALUES (${sqlText(`mem_${userId}`)}, ${sqlText(accountId)}, ${sqlText(userId)}, 'owner', 'active', ${sqlText(iso)});`,
    `INSERT INTO mgmt_api_key (id, user_id, organization_id, name, token_hash, token_hint, enabled, created_at, source, "grant", credential_type)
     VALUES (${sqlText(keyId)}, ${sqlText(userId)}, ${sqlText(accountId)},
       'Management key', ${sqlText(hash)}, ${sqlText(hint)}, 1, ${now}, 'cli', ${sqlText(grant)}, 'apiKey');`,
  ];
}
