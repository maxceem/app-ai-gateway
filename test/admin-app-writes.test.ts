import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  insertAppWithinCapacity,
  upsertAppWithinCapacity,
  type AtomicAppWrite,
} from "../src/core/app-writes";
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
    expect(await insertAppWithinCapacity(
      env.DB,
      appWrite("write-guard-app", "write-guard-owner", "Original"),
      undefined,
    )).toBe(true);

    expect(await upsertAppWithinCapacity(
      env.DB,
      appWrite("write-guard-app", "write-guard-attacker", "Clobbered"),
      undefined,
    )).toBe(false);
    const row = await env.DB.prepare(
      "SELECT organization_id, name FROM app WHERE id = ?",
    ).bind("write-guard-app").first<{ organization_id: string; name: string }>();
    expect(row).toEqual({ organization_id: "write-guard-owner", name: "Original" });
  });

  it("atomically enforces maxApps across concurrent app inserts", async () => {
    await seedOrganization("atomic-insert-limit");
    const results = await Promise.all([
      insertAppWithinCapacity(env.DB, appWrite("atomic-insert-a", "atomic-insert-limit"), 1),
      insertAppWithinCapacity(env.DB, appWrite("atomic-insert-b", "atomic-insert-limit"), 1),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM app WHERE organization_id = ?",
    ).bind("atomic-insert-limit").first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it("atomically enforces maxApps across concurrent upsert creation", async () => {
    await seedOrganization("atomic-upsert-limit");
    const results = await Promise.all([
      upsertAppWithinCapacity(env.DB, appWrite("atomic-upsert-a", "atomic-upsert-limit"), 1),
      upsertAppWithinCapacity(env.DB, appWrite("atomic-upsert-b", "atomic-upsert-limit"), 1),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM app WHERE organization_id = ?",
    ).bind("atomic-upsert-limit").first<{ count: number }>();
    expect(count?.count).toBe(1);
  });
});
