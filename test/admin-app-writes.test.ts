import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { insertApp, updateApp, type AtomicAppWrite } from "../src/management/app-writes";
import { parseAppConfig } from "../src/shared/app-config";
import { serverConfig } from "./helpers";

async function seedOrganization(id: string): Promise<void> {
  const userId = `${id}-owner`;
  const now = new Date();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO mgmt_user(id, name, email, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
    ).bind(userId, `${id} owner`, `${id}@example.test`, now.getTime(), now.getTime()),
    env.DB.prepare(
      `INSERT INTO mgmt_organization(id, name, created_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(id, id, userId, now.toISOString(), now.toISOString()),
    env.DB.prepare(
      `INSERT INTO mgmt_organization_user(id, organization_id, user_id, role, status, joined_at)
       VALUES (?, ?, ?, 'owner', 'active', ?)`,
    ).bind(`${id}-membership`, id, userId, now.toISOString()),
  ]);
}

function appWrite(id: string, organizationId: string, name = id): AtomicAppWrite & { expectedRevision: number } {
  return {
    id,
    organizationId,
    name,
    config: parseAppConfig(serverConfig()),
    status: "active",
    expectedRevision: 1,
  };
}

describe("atomic organization app writes", () => {
  it("does not update an app owned by another organization", async () => {
    await seedOrganization("write-guard-owner");
    await seedOrganization("write-guard-attacker");
    expect(await insertApp(
      env.DB,
      appWrite("write-guard-app", "write-guard-owner", "Original"),
    )).toMatchObject({ id: "write-guard-app", name: "Original" });

    expect(await updateApp(
      env.DB,
      appWrite("write-guard-app", "write-guard-attacker", "Clobbered"),
    )).toBeNull();
    const row = await env.DB.prepare(
      "SELECT organization_id, name FROM app WHERE id = ?",
    ).bind("write-guard-app").first<{ organization_id: string; name: string }>();
    expect(row).toEqual({ organization_id: "write-guard-owner", name: "Original" });
  });

  it("creates nothing when the id it was given does not exist", async () => {
    await seedOrganization("update-only-org");

    expect(await updateApp(
      env.DB,
      appWrite("never-created-app", "update-only-org", "Ghost"),
    )).toBeNull();
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM app WHERE id = ?",
    ).bind("never-created-app").first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it("writes the row it was given when the organization matches", async () => {
    await seedOrganization("update-writes-org");
    expect(await insertApp(
      env.DB,
      appWrite("update-writes-app", "update-writes-org", "Before"),
    )).not.toBeNull();

    // The returned row is the stored one, which is what the route answers with
    // instead of reading the app back through a second statement.
    const written = await updateApp(
      env.DB,
      appWrite("update-writes-app", "update-writes-org", "After"),
    );
    expect(written).toMatchObject({
      id: "update-writes-app",
      organizationId: "update-writes-org",
      name: "After",
      status: "active",
    });
    expect(written?.config).toEqual(serverConfig());
    const row = await env.DB.prepare(
      "SELECT name FROM app WHERE id = ?",
    ).bind("update-writes-app").first<{ name: string }>();
    expect(row?.name).toBe("After");
  });

  it("lets one of two concurrent creates of the same id win", async () => {
    await seedOrganization("atomic-insert-org");
    const results = await Promise.all([
      insertApp(env.DB, appWrite("atomic-insert-app", "atomic-insert-org", "A")),
      insertApp(env.DB, appWrite("atomic-insert-app", "atomic-insert-org", "B")),
    ]);

    expect(results.filter((row) => row !== null)).toHaveLength(1);
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM app WHERE organization_id = ?",
    ).bind("atomic-insert-org").first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it("allows only one concurrent writer with the original revision", async () => {
    await seedOrganization("revision-race-org");
    const initial = appWrite("revision-race-app", "revision-race-org", "Original");
    await insertApp(env.DB, initial);
    const writes = await Promise.all([
      updateApp(env.DB, { ...initial, name: "First", expectedRevision: 1 }),
      updateApp(env.DB, { ...initial, name: "Second", expectedRevision: 1 }),
    ]);
    expect(writes.filter(Boolean)).toHaveLength(1);
    expect(writes.find(Boolean)?.revision).toBe(2);
    expect(await updateApp(env.DB, { ...initial, name: "Stale", expectedRevision: 1 })).toBeNull();
  });

  it("no longer caps how many apps an organization may hold", async () => {
    await seedOrganization("uncapped-org");
    for (const id of ["uncapped-a", "uncapped-b", "uncapped-c"]) {
      expect(await insertApp(env.DB, appWrite(id, "uncapped-org"))).not.toBeNull();
    }
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM app WHERE organization_id = ?",
    ).bind("uncapped-org").first<{ count: number }>();
    expect(count?.count).toBe(3);
  });
});
