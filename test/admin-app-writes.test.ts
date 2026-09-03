import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { insertApp, upsertApp, type AtomicAppWrite } from "../src/core/app-writes";
import type { StoredAppConfig } from "../src/core/types";
import { serverConfig } from "./helpers";

async function seedOrganization(id: string): Promise<void> {
  const userId = `${id}-owner`;
  const now = new Date();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO console_user(id, name, email, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
    ).bind(userId, `${id} owner`, `${id}@example.test`, now.getTime(), now.getTime()),
    env.DB.prepare(
      `INSERT INTO console_organization(id, name, created_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(id, id, userId, now.toISOString(), now.toISOString()),
    env.DB.prepare(
      `INSERT INTO console_organization_user(id, organization_id, user_id, role, status, joined_at)
       VALUES (?, ?, ?, 'owner', 'active', ?)`,
    ).bind(`${id}-membership`, id, userId, now.toISOString()),
  ]);
}

function appWrite(id: string, organizationId: string, name = id): AtomicAppWrite {
  return {
    id,
    organizationId,
    name,
    config: serverConfig() as unknown as StoredAppConfig,
    status: "active",
  };
}

describe("atomic organization app writes", () => {
  it("does not update an app owned by another organization on conflict", async () => {
    await seedOrganization("write-guard-owner");
    await seedOrganization("write-guard-attacker");
    expect(await insertApp(
      env.DB,
      appWrite("write-guard-app", "write-guard-owner", "Original"),
    )).toBe(true);

    expect(await upsertApp(
      env.DB,
      appWrite("write-guard-app", "write-guard-attacker", "Clobbered"),
    )).toBe(false);
    const row = await env.DB.prepare(
      "SELECT organization_id, name FROM app WHERE id = ?",
    ).bind("write-guard-app").first<{ organization_id: string; name: string }>();
    expect(row).toEqual({ organization_id: "write-guard-owner", name: "Original" });
  });

  it("lets one of two concurrent creates of the same id win", async () => {
    await seedOrganization("atomic-insert-org");
    const results = await Promise.all([
      insertApp(env.DB, appWrite("atomic-insert-app", "atomic-insert-org", "A")),
      insertApp(env.DB, appWrite("atomic-insert-app", "atomic-insert-org", "B")),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM app WHERE organization_id = ?",
    ).bind("atomic-insert-org").first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it("no longer caps how many apps an organization may hold", async () => {
    await seedOrganization("uncapped-org");
    for (const id of ["uncapped-a", "uncapped-b", "uncapped-c"]) {
      expect(await insertApp(env.DB, appWrite(id, "uncapped-org"))).toBe(true);
    }
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM app WHERE organization_id = ?",
    ).bind("uncapped-org").first<{ count: number }>();
    expect(count?.count).toBe(3);
  });
});
