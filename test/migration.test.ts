import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/** Idempotent, so each test that needs an owning organization can ask for it. */
async function seedProviderOrganization(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO console_user(id, name, email, email_verified, created_at, updated_at)
       VALUES ('provider-owner', 'Owner', 'owner@providers.test', 1, 0, 0)`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO console_organization(id, name, created_by_user_id, created_at, updated_at)
       VALUES ('org-providers', 'Providers', 'provider-owner', datetime('now'), datetime('now'))`,
    ),
  ]);
}

describe("initial database migration", () => {
  it("creates the complete current schema", async () => {
    const userColumns = await env.DB.prepare("PRAGMA table_info(app_user)").all<{ name: string }>();
    const usageColumns = await env.DB.prepare("PRAGMA table_info(app_usage_event)").all<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>();
    const appColumns = await env.DB.prepare("PRAGMA table_info(app)").all<{
      name: string;
      notnull: number;
    }>();
    const apiKeyColumns = await env.DB.prepare("PRAGMA table_info(app_api_key)").all<{ name: string }>();
    const apiKeyIndexes = await env.DB.prepare("PRAGMA index_list(app_api_key)").all<{
      name: string;
      unique: number;
    }>();

    expect(userColumns.results.map((column) => column.name)).not.toContain("attest_env");
    expect(usageColumns.results.map((column) => column.name)).toContain("auth_method");
    expect(usageColumns.results.map((column) => column.name)).toContain("api_key_id");
    expect(usageColumns.results.map((column) => column.name)).toContain("provider_type");
    expect(usageColumns.results.map((column) => column.name)).toContain("provider_id");
    expect(usageColumns.results.map((column) => column.name)).toContain("provider_slug");
    expect(usageColumns.results.map((column) => column.name)).toContain("event_id");
    // Additive and nullable: adding it must not have rebuilt a populated table.
    expect(usageColumns.results.find((column) => column.name === "cost_source")).toMatchObject({
      notnull: 0,
      dflt_value: null,
    });
    // The whole Stage 2 wave on the usage table is additive: a rebuild of the
    // largest table a deployment owns is exactly what this migration avoided.
    for (const name of [
      "provider_gateway_id",
      "provider_gateway_type",
      "reported_cost_usd",
      "served_provider",
      "served_model",
      "credential_source",
      "model_author",
    ]) {
      expect({ name, column: usageColumns.results.find((column) => column.name === name) })
        .toEqual({ name, column: expect.objectContaining({ notnull: 0, dflt_value: null }) });
    }
    expect(usageColumns.results.map((column) => column.name)).not.toContain("provider");
    expect(usageColumns.results.find((column) => column.name === "cost_usd")).toMatchObject({
      notnull: 1,
      dflt_value: "0",
    });
    expect(appColumns.results.map((column) => column.name)).toEqual([
      "id",
      "organization_id",
      "name",
      "config_json",
      "status",
      "created_at",
      "updated_at",
    ]);
    expect(appColumns.results.find((column) => column.name === "organization_id")?.notnull).toBe(1);
    const appTables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND (name = 'app' OR name LIKE 'app_%') ORDER BY name",
    ).all<{ name: string }>();
    expect(appTables.results.map((row) => row.name)).toEqual([
      "app",
      "app_api_key",
      "app_auth_challenge",
      "app_usage_event",
      "app_user",
    ]);
    const providerColumns = await env.DB.prepare("PRAGMA table_info(provider)").all<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>();
    expect(providerColumns.results.map((column) => column.name)).toEqual([
      "id",
      "organization_id",
      "type",
      "slug",
      "name",
      "secret_blob",
      "secret_hint",
      "provider_gateway_id",
      "gateway_route_json",
      "pricing_json",
      "status",
      "created_by",
      "created_at",
      "updated_at",
      // Last, because 0017 appended it: a plain ADD COLUMN, not another rebuild
      // of a populated tenant table.
      "base_url",
    ]);
    expect(providerColumns.results.find((column) => column.name === "gateway_route_json"))
      .toMatchObject({ notnull: 0 });
    expect(providerColumns.results.find((column) => column.name === "base_url"))
      .toMatchObject({ notnull: 0, dflt_value: null });
    const gatewayColumns = await env.DB.prepare("PRAGMA table_info(provider_gateway)")
      .all<{ name: string }>();
    expect(gatewayColumns.results.map((column) => column.name)).toEqual([
      "id",
      "organization_id",
      "type",
      "name",
      "config_json",
      "secret_blob",
      "secret_hint",
      "status",
      "created_by",
      "created_at",
      "updated_at",
    ]);
    const consoleTables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'console_%' ORDER BY name",
    ).all<{ name: string }>();
    expect(consoleTables.results.map((row) => row.name)).toEqual([
      "console_api_key",
      "console_organization",
      "console_organization_user",
      "console_user",
      "console_user_account",
      "console_user_session",
      "console_verification",
    ]);
    expect(apiKeyColumns.results.map((column) => column.name)).toEqual([
      "id",
      "app_id",
      "name",
      "key_hash",
      "key_prefix",
      "status",
      "created_at",
      "last_used_at",
    ]);
    expect(apiKeyIndexes.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "idx_api_keys_app" }),
      expect.objectContaining({ name: "api_keys_key_hash_unique", unique: 1 }),
    ]));
  });

  it("rejects usage events without a cost", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO app_usage_event(app_id, user_id, provider_type, model, route, cost_usd, status)
         VALUES ('migration-cost', 'user-1', 'openai', 'gpt-5.6-sol', 'openai/v1/responses', NULL, 'ok')`,
      ).run(),
    ).rejects.toThrow(/NOT NULL constraint failed: app_usage_event.cost_usd/u);
  });

  it("rejects a repeated usage event id while tolerating rows recorded before it existed", async () => {
    const insert = (eventId: string | null) =>
      env.DB.prepare(
        `INSERT INTO app_usage_event(event_id, app_id, user_id, provider_type, model, route, cost_usd, status)
         VALUES (?, 'migration-event-id', 'user-1', 'openai', 'gpt-5.6-sol', 'openai/v1/responses', 0, 'ok')`,
      ).bind(eventId).run();

    // Pre-migration rows carry NULL, and SQLite counts every NULL as distinct.
    await insert(null);
    await expect(insert(null)).resolves.toBeDefined();
    await insert("migration-event-1");
    await expect(insert("migration-event-1")).rejects.toThrow(/UNIQUE constraint failed/u);
  });

  it("allows one active provider row per organization and slug", async () => {
    await seedProviderOrganization();
    const insert = (id: string, slug: string, status: string) =>
      env.DB.prepare(
        `INSERT INTO provider(id, organization_id, type, slug, name, secret_blob, secret_hint, status, created_by)
         VALUES (?, 'org-providers', 'openai', ?, 'Prod OpenAI', 'local1.1.iv.ct', 'abcd', ?, 'provider-owner')`,
      ).bind(id, slug, status).run();

    await insert("provider-1", "openai", "active");
    await expect(insert("provider-2", "openai", "active")).rejects.toThrow(/UNIQUE constraint failed/u);
    await expect(insert("provider-2", "openai-dev", "active")).resolves.toBeDefined();
    // A revoked row does not occupy the slot.
    await insert("provider-3", "openai", "revoked");
    await expect(insert("provider-4", "sideways", "sideways")).rejects.toThrow(/CHECK constraint failed/u);
  });

  /**
   * The type CHECK is deliberately wider than the runtime registry: widening it
   * is a table rebuild, so the whole roadmap was admitted at once and the
   * contracts refuse the types no registry entry backs yet.
   */
  it("admits every planned provider type and still refuses an unknown one", async () => {
    await seedProviderOrganization();
    const insert = (id: string, type: string) =>
      env.DB.prepare(
        `INSERT INTO provider(id, organization_id, type, slug, name, secret_blob, secret_hint, status, created_by)
         VALUES (?, 'org-providers', ?, ?, 'Planned', 'local1.1.iv.ct', 'abcd', 'active', 'provider-owner')`,
      ).bind(id, type, `slug-${type}`).run();

    for (const type of [
      "deepseek", "groq", "mistral", "together", "fireworks", "openrouter",
      "cerebras", "moonshot", "huggingface", "baseten", "bytedance",
    ]) {
      await expect(insert(`planned-${type}`, type)).resolves.toBeDefined();
    }
    await expect(insert("planned-cohere", "cohere")).rejects.toThrow(/CHECK constraint failed/u);
  });

  it("admits every planned gateway type and still refuses an unknown one", async () => {
    await seedProviderOrganization();
    const insert = (id: string, type: string) =>
      env.DB.prepare(
        `INSERT INTO provider_gateway(id, organization_id, type, name, config_json, secret_blob, secret_hint, created_by)
         VALUES (?, 'org-providers', ?, 'Planned gateway', '{}', 'local1.1.iv.ct', 'abcd', 'provider-owner')`,
      ).bind(id, type).run();

    await expect(insert("planned-cf", "cf_aig")).resolves.toBeDefined();
    await expect(insert("planned-vercel", "vercel")).resolves.toBeDefined();
    await expect(insert("planned-litellm", "litellm")).rejects.toThrow(/CHECK constraint failed/u);
  });
});

/**
 * The suite-wide fixture applies every migration to an empty database, which is
 * the one situation in which a table rebuild cannot trip a foreign key. These
 * run against a second, empty database so a migration meets the data a real
 * deployment has.
 */
const upTo = (tag: string) =>
  env.TEST_MIGRATIONS.slice(0, env.TEST_MIGRATIONS.findIndex((entry) => entry.name.startsWith(tag)) + 1);

describe("migration 0011 against a populated database", () => {
  it("rebuilds the app table while child rows still reference it", async () => {
    const db = env.MIGRATION_DB;
    await applyD1Migrations(db, upTo("0010_"));

    const now = new Date();
    await db.batch([
      db.prepare(
        `INSERT INTO console_user(id, name, email, email_verified, created_at, updated_at)
         VALUES ('rebuild-owner', 'Owner', 'owner@rebuild.test', 1, ?, ?)`,
      ).bind(now.getTime(), now.getTime()),
      db.prepare(
        `INSERT INTO console_organization(id, name, created_by_user_id, created_at, updated_at)
         VALUES ('rebuild-org', 'Rebuild', 'rebuild-owner', ?, ?)`,
      ).bind(now.toISOString(), now.toISOString()),
      db.prepare(
        `INSERT INTO app(id, organization_id, name, config_json, status)
         VALUES ('rebuild-app', 'rebuild-org', 'Rebuild app', '{}', 'active')`,
      ),
      // Each of the three tables that REFERENCE app. Without a deferred check,
      // DROP TABLE app in the rebuild fails on these.
      db.prepare(
        `INSERT INTO app_api_key(id, app_id, name, key_hash, key_prefix)
         VALUES ('rebuild-key', 'rebuild-app', 'Key', 'hash', 'agw_prefix')`,
      ),
      db.prepare("INSERT INTO app_user(app_id, id, status) VALUES ('rebuild-app', 'user-1', 'active')"),
      db.prepare(
        `INSERT INTO app_auth_challenge(challenge, app_id, expires_at)
         VALUES ('rebuild-challenge', 'rebuild-app', ?)`,
      ).bind(now.toISOString()),
    ]);

    await expect(applyD1Migrations(db, upTo("0011_"))).resolves.toBeUndefined();

    const appColumns = await db.prepare("PRAGMA table_info(app)").all<{
      name: string;
      notnull: number;
    }>();
    expect(appColumns.results.find((column) => column.name === "organization_id")?.notnull).toBe(1);
    for (const [table, column, value] of [
      ["app", "id", "rebuild-app"],
      ["app_api_key", "id", "rebuild-key"],
      ["app_user", "app_id", "rebuild-app"],
      ["app_auth_challenge", "challenge", "rebuild-challenge"],
    ] as const) {
      const row = await db.prepare(
        `SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`,
      ).bind(value).first<{ count: number }>();
      expect({ table, count: row?.count }).toEqual({ table, count: 1 });
    }

    // The rebuilt table is still the target of the children's foreign keys.
    await expect(
      db.prepare(
        "INSERT INTO app_user(app_id, id, status) VALUES ('no-such-app', 'user-2', 'active')",
      ).run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/u);
  });
});

/**
 * The one wave that rebuilds both tenant tables. `provider` references
 * `provider_gateway`, so on a populated database the second rebuild drops a
 * table whose rows are still pointed at — the same trap 0011 hit with `app`,
 * and the reason this migration defers foreign keys rather than switching them
 * off, which does nothing inside D1's transaction.
 */
describe("migration 0016 against a populated database", () => {
  it("rebuilds provider and provider_gateway without losing a row or a reference", async () => {
    const db = env.MIGRATION_DB;
    await applyD1Migrations(db, upTo("0015_"));

    const now = new Date();
    await db.batch([
      db.prepare(
        `INSERT INTO console_user(id, name, email, email_verified, created_at, updated_at)
         VALUES ('wave-owner', 'Owner', 'owner@wave.test', 1, ?, ?)`,
      ).bind(now.getTime(), now.getTime()),
      db.prepare(
        `INSERT INTO console_organization(id, name, created_by_user_id, created_at, updated_at)
         VALUES ('wave-org', 'Wave', 'wave-owner', ?, ?)`,
      ).bind(now.toISOString(), now.toISOString()),
      db.prepare(
        `INSERT INTO provider_gateway(id, organization_id, type, name, config_json, secret_blob, secret_hint, created_by)
         VALUES ('wave-gateway', 'wave-org', 'cf_aig', 'Wave gateway',
                 '{"accountId":"acct-1","gatewayId":"gw-1"}', 'local1.1.iv.ct', 'abcd', 'wave-owner')`,
      ),
      // Both credential sources, so the surviving XOR is exercised from each side.
      db.prepare(
        `INSERT INTO provider(id, organization_id, type, slug, name, secret_blob, secret_hint, pricing_json, status, created_by)
         VALUES ('wave-direct', 'wave-org', 'openai', 'openai', 'Direct OpenAI', 'local1.1.iv.ct', 'abcd',
                 '{"gpt-5.6-sol":{"input":1,"output":2}}', 'active', 'wave-owner')`,
      ),
      db.prepare(
        `INSERT INTO provider(id, organization_id, type, slug, name, provider_gateway_id, status, created_by)
         VALUES ('wave-routed', 'wave-org', 'anthropic', 'anthropic-aig', 'Anthropic via CF',
                 'wave-gateway', 'active', 'wave-owner')`,
      ),
      db.prepare(
        `INSERT INTO app_usage_event(app_id, user_id, provider_type, model, route, cost_usd, status)
         VALUES ('wave-app', 'user-1', 'openai', 'gpt-5.6-sol', 'openai/v1/responses', 0.25, 'ok')`,
      ),
    ]);

    await expect(applyD1Migrations(db, upTo("0016_"))).resolves.toBeUndefined();

    const rows = await db.prepare(
      "SELECT id, type, slug, secret_hint, provider_gateway_id, gateway_route_json, pricing_json FROM provider ORDER BY id",
    ).all<Record<string, unknown>>();
    expect(rows.results).toEqual([
      {
        id: "wave-direct",
        type: "openai",
        slug: "openai",
        secret_hint: "abcd",
        provider_gateway_id: null,
        // The new column arrives empty rather than defaulted, so an existing
        // row is not silently given a route it never asked for.
        gateway_route_json: null,
        pricing_json: '{"gpt-5.6-sol":{"input":1,"output":2}}',
      },
      {
        id: "wave-routed",
        type: "anthropic",
        slug: "anthropic-aig",
        secret_hint: null,
        provider_gateway_id: "wave-gateway",
        gateway_route_json: null,
        pricing_json: null,
      },
    ]);
    const gateway = await db.prepare(
      "SELECT type, name, config_json, secret_hint FROM provider_gateway",
    ).all<Record<string, unknown>>();
    expect(gateway.results).toEqual([{
      type: "cf_aig",
      name: "Wave gateway",
      config_json: '{"accountId":"acct-1","gatewayId":"gw-1"}',
      secret_hint: "abcd",
    }]);

    // The usage row keeps its cost and gains the wave's columns as unknowns.
    const event = await db.prepare(
      `SELECT cost_usd, provider_gateway_id, provider_gateway_type, reported_cost_usd,
              served_provider, served_model, credential_source, model_author
       FROM app_usage_event WHERE app_id = 'wave-app'`,
    ).first<Record<string, unknown>>();
    expect(event).toEqual({
      cost_usd: 0.25,
      provider_gateway_id: null,
      provider_gateway_type: null,
      reported_cost_usd: null,
      served_provider: null,
      served_model: null,
      credential_source: null,
      model_author: null,
    });

    // Both rebuilt tables are still the targets of the same foreign keys, and
    // the widened CHECKs and the surviving XOR all still bite.
    await expect(
      db.prepare(
        `INSERT INTO provider(id, organization_id, type, slug, name, provider_gateway_id, status, created_by)
         VALUES ('wave-orphan', 'wave-org', 'openai', 'orphan', 'Orphan', 'no-such-gateway', 'active', 'wave-owner')`,
      ).run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/u);
    await expect(
      db.prepare(
        `INSERT INTO provider(id, organization_id, type, slug, name, secret_blob, secret_hint, provider_gateway_id, status, created_by)
         VALUES ('wave-both', 'wave-org', 'openai', 'both', 'Both', 'local1.1.iv.ct', 'abcd', 'wave-gateway', 'active', 'wave-owner')`,
      ).run(),
    ).rejects.toThrow(/CHECK constraint failed/u);
    await expect(
      db.prepare(
        `INSERT INTO provider(id, organization_id, type, slug, name, secret_blob, secret_hint, status, created_by)
         VALUES ('wave-new-type', 'wave-org', 'openrouter', 'openrouter', 'OpenRouter', 'local1.1.iv.ct', 'abcd', 'active', 'wave-owner')`,
      ).run(),
    ).resolves.toBeDefined();
    await expect(
      db.prepare(
        `INSERT INTO provider_gateway(id, organization_id, type, name, config_json, secret_blob, secret_hint, created_by)
         VALUES ('wave-vercel', 'wave-org', 'vercel', 'Vercel', '{}', 'local1.1.iv.ct', 'abcd', 'wave-owner')`,
      ).run(),
    ).resolves.toBeDefined();
  });
});
