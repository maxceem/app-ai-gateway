import { env } from "cloudflare:workers";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { prepared } from "../src/db/sql";
import {
  ACCOUNT_RECOVERY_MS,
  UNCLAIMED_ACCESS_MS,
  accountAccessDenial,
  type AccountAccessMode,
  type AccountLifecycle,
} from "../src/policy/accounts";
import {
  registrationAllowed,
  registrationOpen,
  resolveDeployment,
} from "../src/policy/deployment";
import {
  accountAccessCondition,
  expiredUnclaimedAccountsCondition,
} from "../src/policy/sql";

const actions = ["read", "setup", "proxy"] as const;
const DAY = 86_400_000;

function policy(mode: "cloud" | "self_hosted", emails?: string) {
  return resolveDeployment({
    ...(mode === "cloud" ? { BILLING: {} } : {}),
    ...(emails === undefined ? {} : { ALLOWED_REGISTRATION_EMAILS: emails }),
  } as unknown as Env);
}

describe("deployment registration policy", () => {
  it("lets anyone register on cloud, whatever a self-host's list says", () => {
    for (const emails of [undefined, "", "owner@example.com"]) {
      const cloud = policy("cloud", emails);
      expect(registrationOpen(cloud)).toBe(true);
      expect(registrationAllowed(cloud, "stranger@example.com")).toBe(true);
      expect(registrationAllowed(cloud, null)).toBe(true);
    }
  });

  it("closes a self-host whose list is unset or empty", () => {
    for (const emails of [undefined, "", " , ,"]) {
      const selfHost = policy("self_hosted", emails);
      expect(registrationOpen(selfHost)).toBe(false);
      expect(registrationAllowed(selfHost, "owner@example.com")).toBe(false);
    }
  });

  it("admits only a listed email on a self-host, however either side is spelled", () => {
    const selfHost = policy("self_hosted", " Owner@Example.com ,second@example.com,");
    expect(registrationOpen(selfHost)).toBe(true);
    expect(registrationAllowed(selfHost, "owner@example.com")).toBe(true);
    expect(registrationAllowed(selfHost, "  OWNER@example.COM ")).toBe(true);
    expect(registrationAllowed(selfHost, "second@example.com")).toBe(true);
    expect(registrationAllowed(selfHost, "stranger@example.com")).toBe(false);
    expect(registrationAllowed(selfHost, "owner@example.com.evil")).toBe(false);
    expect(registrationAllowed(selfHost, null)).toBe(false);
  });

  it("admits anyone on a self-host that lists *", () => {
    const selfHost = policy("self_hosted", "*");
    expect(registrationOpen(selfHost)).toBe(true);
    expect(registrationAllowed(selfHost, "stranger@example.com")).toBe(true);
  });

  it("reads the bootstrap token digest as lower-case hex, or null where unset", () => {
    expect(policy("self_hosted").bootstrapTokenDigest).toBeNull();
    expect(resolveDeployment({ CLI_BOOTSTRAP_TOKEN_DIGEST: " ABC123 " } as unknown as Env).bootstrapTokenDigest)
      .toBe("abc123");
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
  ) return "unclaimed_access_expired";
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
        createdAt: storedInstant(now - UNCLAIMED_ACCESS_MS + 1, "iso"),
        expiresAt: storedInstant(now + 60 * DAY + 1, "iso"),
        claimed: false,
        expected: "open",
      },
      {
        label: "trial-exact-iso",
        createdAt: storedInstant(now - UNCLAIMED_ACCESS_MS, "iso"),
        expiresAt: storedInstant(now + 60 * DAY, "iso"),
        claimed: false,
        expected: "trial",
      },
      {
        label: "trial-exact-sqlite",
        createdAt: storedInstant(now - UNCLAIMED_ACCESS_MS, "sqlite"),
        expiresAt: storedInstant(now + 60 * DAY, "sqlite"),
        claimed: false,
        expected: "trial",
      },
      {
        label: "trial-after-iso",
        createdAt: storedInstant(now - UNCLAIMED_ACCESS_MS - 1, "iso"),
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
          expect(accountAccessDenial(policy(mode).rules, account, action, now), JSON.stringify({
            case: definition.label,
            mode,
            action,
            implementation: "pure",
          })).toBe(expected);
          const condition = accountAccessCondition(policy(mode).rules, account.id, action, now);
          const allowed = await prepared(env.DB, sql`SELECT ${condition} AS allowed`)
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

    const missing = accountAccessCondition(policy("cloud").rules, "missing-account", "read", now);
    expect(Boolean(await prepared(env.DB, sql`SELECT ${missing} AS allowed`)
      .first<number>("allowed"))).toBe(false);
  });

  it("uses SQLite's later clock to reject a mutation from a stale caller", async () => {
    const staleCallerNow = Date.now() - DAY;
    const account = await seedAccount("stale-caller", {
      createdAt: storedInstant(Date.now() - 2 * DAY, "iso"),
      expiresAt: storedInstant(Date.now() - 5_000, "iso"),
      claimed: false,
    });
    const condition = accountAccessCondition(policy("self_hosted").rules,
      account.id,
      "read",
      staleCallerNow,
    );
    const result = await prepared(env.DB,
      sql`UPDATE mgmt_organization SET name='Mutated' WHERE id=${account.id} AND ${condition}`,
    ).run();
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
    const rows = await prepared(env.DB, sql`SELECT o.id FROM mgmt_organization o
       WHERE o.id IN (${expired.id},${afterCutoff.id},${claimed.id}) AND ${condition} ORDER BY o.id`)
      .all<{ id: string }>();
    expect(rows.results.map((row) => row.id)).toEqual([expired.id]);
  });
});
