import { env } from "cloudflare:workers";
import { createCfAuthTables } from "@maxceem/cf-auth/schema";
import { getTableName, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { database } from "../src/db";
import {
  ACCOUNT_RECOVERY_MS,
  ACCOUNT_TRIAL_MS,
  accountAccessDenial,
  type AccountAccessMode,
  type AccountLifecycle,
} from "../src/policy/accounts";
import {
  registrationAllowed,
  registrationRule,
  resolveDeployment,
} from "../src/policy/deployment";
import {
  accountAccessCondition,
  expiredUnclaimedAccountsCondition,
  registrationCreateCondition,
} from "../src/policy/sql";

const actions = ["read", "setup", "proxy"] as const;
const DAY = 86_400_000;
const selfHostedRegistrationExpected = {
  "false:false": [true, false, false, false],
  "false:true": [true, false, true, true],
  "true:false": [true, true, false, false],
  "true:true": [true, true, true, true],
} as const;

function policy(mode: "cloud" | "self_hosted", additional = false) {
  return resolveDeployment({
    ...(mode === "cloud" ? { BILLING: {} } : {}),
    ALLOW_ADDITIONAL_REGISTRATIONS: additional ? "  TrUe " : "false",
  } as unknown as Env);
}

describe("deployment registration policy", () => {
  it("keeps pure preflight and configured-table SQL decisions in parity", async () => {
    const prefix = `policy_${crypto.randomUUID().replaceAll("-", "")}_`;
    const tables = createCfAuthTables({ tablePrefix: prefix });
    const userTable = getTableName(tables.user);
    const organizationTable = getTableName(tables.organization);
    await env.DB.exec(
      `CREATE TABLE "${userTable}" (kind TEXT NOT NULL);
       CREATE TABLE "${organizationTable}" (id TEXT NOT NULL);`,
    );

    for (const mode of ["cloud", "self_hosted"] as const) {
      for (const additional of [false, true]) {
        for (const claim of [false, true]) {
          const rule = registrationRule(policy(mode, additional), claim);
          for (const humanExists of [false, true]) {
            for (const accountExists of [false, true]) {
              await env.DB.batch([
                env.DB.prepare(`DELETE FROM "${userTable}"`),
                env.DB.prepare(`DELETE FROM "${organizationTable}"`),
              ]);
              if (humanExists) {
                await env.DB.prepare(`INSERT INTO "${userTable}"(kind) VALUES ('human')`).run();
              }
              if (accountExists) {
                await env.DB.prepare(`INSERT INTO "${organizationTable}"(id) VALUES ('account')`)
                  .run();
              }
              const stateIndex = (humanExists ? 2 : 0) + (accountExists ? 1 : 0);
              const key = `${String(claim)}:${String(additional)}` as
                keyof typeof selfHostedRegistrationExpected;
              const selfHostedExpected = selfHostedRegistrationExpected[key][stateIndex];
              const expected = mode === "cloud" ? true : selfHostedExpected;
              expect(registrationAllowed(rule, { humanExists, accountExists })).toBe(expected);
              const row = await database(env.DB).get<{ allowed: number }>(sql`
                SELECT ${registrationCreateCondition(rule, tables)} AS allowed
              `);
              expect(Boolean(row?.allowed), JSON.stringify({
                mode,
                additional,
                claim,
                humanExists,
                accountExists,
              })).toBe(expected);
            }
          }
        }
      }
    }
  });
});

function storedInstant(at: number, shape: "iso" | "sqlite"): string {
  const iso = new Date(at).toISOString();
  return shape === "iso" ? iso : iso.slice(0, 19).replace("T", " ");
}

async function seedAccount(
  label: string,
  account: Omit<AccountLifecycle, "id" | "name">,
): Promise<AccountLifecycle> {
  const suffix = crypto.randomUUID();
  const id = `policy-account-${label}-${suffix}`;
  const serviceId = `policy-service-${suffix}`;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO mgmt_user(id,name,email,email_verified,kind,created_at,updated_at)
       VALUES (?,'Policy service',NULL,0,'service',?,?)`,
    ).bind(serviceId, now, now),
    env.DB.prepare(
      `INSERT INTO mgmt_organization(id,name,created_by_user_id,expires_at,created_at,updated_at)
       VALUES (?,'Policy account',?,?,?,?)`,
    ).bind(id, serviceId, account.expiresAt, account.createdAt, account.createdAt),
  ]);
  if (account.claimed) {
    const humanId = `policy-human-${suffix}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO mgmt_user(id,name,email,email_verified,kind,created_at,updated_at)
         VALUES (?,'Policy human',?,1,'human',?,?)`,
      ).bind(humanId, `${suffix}@policy.test`, now, now),
      env.DB.prepare(
        `INSERT INTO mgmt_organization_user(id,organization_id,user_id,role,status,joined_at)
         VALUES (?,?,?,'owner','active',?)`,
      ).bind(`policy-member-${suffix}`, id, humanId, account.createdAt),
    ]);
  }
  return { id, name: "Policy account", ...account };
}

type Expected = "open" | "trial" | "recovery";

function expectedDenial(
  expected: Expected,
  mode: "cloud" | "self_hosted",
  action: AccountAccessMode,
) {
  if (expected === "recovery") return "account_expired";
  if (
    expected === "trial" &&
    mode === "cloud" &&
    (action === "setup" || action === "proxy")
  ) return "billing_trial_expired";
  return null;
}

describe("account deadline policy", () => {
  it("matches pure decisions to real D1 SQL at trial and recovery boundaries", async () => {
    // This clock is later than SQLite's wall clock, making exact SQL boundaries deterministic.
    const now = Math.floor((Date.now() + 200 * DAY) / 1_000) * 1_000;
    const cases: Array<{
      label: string;
      createdAt: string;
      expiresAt: string | null;
      claimed: boolean;
      expected: Expected;
    }> = [
      {
        label: "trial-just-before-iso",
        createdAt: storedInstant(now - ACCOUNT_TRIAL_MS + 1, "iso"),
        expiresAt: storedInstant(now + 60 * DAY + 1, "iso"),
        claimed: false,
        expected: "open",
      },
      {
        label: "trial-exact-iso",
        createdAt: storedInstant(now - ACCOUNT_TRIAL_MS, "iso"),
        expiresAt: storedInstant(now + 60 * DAY, "iso"),
        claimed: false,
        expected: "trial",
      },
      {
        label: "trial-exact-sqlite",
        createdAt: storedInstant(now - ACCOUNT_TRIAL_MS, "sqlite"),
        expiresAt: storedInstant(now + 60 * DAY, "sqlite"),
        claimed: false,
        expected: "trial",
      },
      {
        label: "trial-after-iso",
        createdAt: storedInstant(now - ACCOUNT_TRIAL_MS - 1, "iso"),
        expiresAt: storedInstant(now + 60 * DAY - 1, "iso"),
        claimed: false,
        expected: "trial",
      },
      {
        label: "recovery-just-before-iso",
        createdAt: storedInstant(now - ACCOUNT_RECOVERY_MS + 1, "iso"),
        expiresAt: storedInstant(now + 1, "iso"),
        claimed: false,
        expected: "trial",
      },
      {
        label: "recovery-exact-iso",
        createdAt: storedInstant(now - ACCOUNT_RECOVERY_MS, "iso"),
        expiresAt: storedInstant(now, "iso"),
        claimed: false,
        expected: "recovery",
      },
      {
        label: "recovery-after-iso",
        createdAt: storedInstant(now - ACCOUNT_RECOVERY_MS - 1, "iso"),
        expiresAt: storedInstant(now - 1, "iso"),
        claimed: false,
        expected: "recovery",
      },
      {
        label: "recovery-just-before-sqlite",
        createdAt: storedInstant(now - ACCOUNT_RECOVERY_MS + 1_000, "sqlite"),
        expiresAt: storedInstant(now + 1_000, "sqlite"),
        claimed: false,
        expected: "trial",
      },
      {
        label: "recovery-exact-sqlite",
        createdAt: storedInstant(now - ACCOUNT_RECOVERY_MS, "sqlite"),
        expiresAt: storedInstant(now, "sqlite"),
        claimed: false,
        expected: "recovery",
      },
      {
        label: "recovery-after-sqlite",
        createdAt: storedInstant(now - ACCOUNT_RECOVERY_MS - 1_000, "sqlite"),
        expiresAt: storedInstant(now - 1_000, "sqlite"),
        claimed: false,
        expected: "recovery",
      },
      {
        label: "claimed-exemption",
        createdAt: "invalid-created-at",
        expiresAt: "invalid-expiry",
        claimed: true,
        expected: "open",
      },
      {
        label: "no-expiry-exemption",
        createdAt: "invalid-created-at",
        expiresAt: null,
        claimed: false,
        expected: "open",
      },
      {
        label: "invalid-recovery-fails-closed",
        createdAt: storedInstant(now, "iso"),
        expiresAt: "invalid-expiry",
        claimed: false,
        expected: "recovery",
      },
      {
        label: "invalid-trial-fails-closed",
        createdAt: "invalid-created-at",
        expiresAt: storedInstant(now + DAY, "iso"),
        claimed: false,
        expected: "trial",
      },
    ];

    for (const definition of cases) {
      const account = await seedAccount(definition.label, definition);
      for (const mode of ["cloud", "self_hosted"] as const) {
        for (const action of actions) {
          const expected = expectedDenial(definition.expected, mode, action);
          expect(accountAccessDenial(mode, account, action, now), JSON.stringify({
            case: definition.label,
            mode,
            action,
            implementation: "pure",
          })).toBe(expected);
          const condition = accountAccessCondition(mode, account.id, action, now);
          const allowed = await env.DB.prepare(`SELECT ${condition.sql} AS allowed`)
            .bind(...condition.params)
            .first<number>("allowed");
          expect(Boolean(allowed), JSON.stringify({
            case: definition.label,
            mode,
            action,
            implementation: "sql",
          })).toBe(expected === null);
        }
      }
    }

    const missing = accountAccessCondition("cloud", "missing-account", "read", now);
    expect(Boolean(await env.DB.prepare(`SELECT ${missing.sql} AS allowed`)
      .bind(...missing.params).first<number>("allowed"))).toBe(false);
  });

  it("uses SQLite's later clock to reject a mutation from a stale caller", async () => {
    const staleCallerNow = Date.now() - DAY;
    const account = await seedAccount("stale-caller", {
      createdAt: storedInstant(Date.now() - 2 * DAY, "iso"),
      expiresAt: storedInstant(Date.now() - 5_000, "iso"),
      claimed: false,
    });
    const condition = accountAccessCondition("self_hosted",
      account.id,
      "read",
      staleCallerNow,
    );
    const result = await env.DB.prepare(
      `UPDATE mgmt_organization SET name='Mutated' WHERE id=? AND ${condition.sql}`,
    ).bind(account.id, ...condition.params).run();
    expect(result.meta.changes).toBe(0);
    expect(await env.DB.prepare("SELECT name FROM mgmt_organization WHERE id=?")
      .bind(account.id).first<string>("name")).toBe("Policy account");
  });

  it("selects cleanup accounts with one fixed cutoff and exempts human owners", async () => {
    const cutoff = Date.now() - DAY;
    const expired = await seedAccount("cleanup-expired", {
      createdAt: storedInstant(cutoff - ACCOUNT_RECOVERY_MS, "iso"),
      expiresAt: storedInstant(cutoff - 1, "iso"),
      claimed: false,
    });
    const afterCutoff = await seedAccount("cleanup-after-cutoff", {
      createdAt: storedInstant(cutoff - ACCOUNT_RECOVERY_MS, "iso"),
      // Expired by SQLite's current clock, but outside this batch's captured set.
      expiresAt: storedInstant(cutoff + 1, "iso"),
      claimed: false,
    });
    const claimed = await seedAccount("cleanup-claimed", {
      createdAt: storedInstant(cutoff - ACCOUNT_RECOVERY_MS, "iso"),
      expiresAt: storedInstant(cutoff - 1, "iso"),
      claimed: true,
    });
    const condition = expiredUnclaimedAccountsCondition(cutoff);
    const rows = await env.DB.prepare(
      `SELECT o.id FROM mgmt_organization o
       WHERE o.id IN (?,?,?) AND ${condition.sql} ORDER BY o.id`,
    ).bind(expired.id, afterCutoff.id, claimed.id, ...condition.params)
      .all<{ id: string }>();
    expect(rows.results.map((row) => row.id)).toEqual([expired.id]);
  });
});
