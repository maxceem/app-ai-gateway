import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

/** Idempotent, so each test that needs an owning organization can ask for it. */
async function seedProviderOrganization(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO mgmt_user(id, name, email, email_verified, created_at, updated_at)
       VALUES ('provider-owner', 'Owner', 'owner@providers.test', 1, 0, 0)`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO mgmt_organization(id, name, created_by_user_id, created_at, updated_at)
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
    const spendColumns = await env.DB.prepare("PRAGMA table_info(app_usage_spend)")
      .all<{ name: string; notnull: number }>();
    const apiKeyColumns = await env.DB.prepare("PRAGMA table_info(app_api_key)").all<{ name: string }>();
    const apiKeyIndexes = await env.DB.prepare("PRAGMA index_list(app_api_key)").all<{
      name: string;
      unique: number;
    }>();
    const managementKeyColumns = await env.DB.prepare("PRAGMA table_info(mgmt_api_key)")
      .all<{ name: string }>();

    expect(usageColumns.results.map((column) => column.name)).toContain("auth_method");
    expect(usageColumns.results.map((column) => column.name)).toContain("api_key_id");
    expect(usageColumns.results.map((column) => column.name)).toContain("provider_type");
    expect(usageColumns.results.map((column) => column.name)).toContain("provider_id");
    expect(usageColumns.results.map((column) => column.name)).toContain("provider_slug");
    expect(usageColumns.results.map((column) => column.name)).toContain("event_id");
    // Everything the gateway records opportunistically is nullable and
    // undefaulted: a proxied request that never reached a provider still has to
    // produce a usage row, so only the accounting columns below are mandatory.
    expect(usageColumns.results.find((column) => column.name === "cost_source")).toMatchObject({
      notnull: 0,
      dflt_value: null,
    });
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
    // `provider_type` and `provider_slug` carry this; a bare `provider` would be
    // ambiguous between the two.
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
      "revision",
      "status",
      "created_at",
      "updated_at",
    ]);
    expect(appColumns.results.find((column) => column.name === "organization_id")?.notnull).toBe(1);
    expect(spendColumns.results.map((column) => column.name)).toEqual([
      "id",
      "organization_id",
      "app_id",
      "scope",
      "user_key",
      "month",
      "microusd",
      "revision",
      "pending",
      "last_attempt_at",
    ]);
    expect(spendColumns.results.find((column) => column.name === "organization_id")?.notnull).toBe(0);
    const spendTriggers = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'app_usage_event_%' ORDER BY name",
    ).all<{ name: string }>();
    expect(spendTriggers.results.map((row) => row.name)).toEqual([
      "app_usage_event_owner_guard_before_insert",
      "app_usage_event_spend_after_cost_update",
      "app_usage_event_spend_after_insert",
    ]);
    const appTables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND (name = 'app' OR name LIKE 'app_%') ORDER BY name",
    ).all<{ name: string }>();
    expect(appTables.results.map((row) => row.name)).toEqual([
      "app",
      "app_api_key",
      "app_auth_challenge",
      "app_auth_event",
      "app_usage_event",
      "app_usage_rollup",
      "app_usage_spend",
      "app_user",
    ]);
    // The auth event log mirrors usage's conventions, with the two differences
    // that made it a sibling table rather than more columns on that one: a
    // nullable user (most refusals establish no identity) and its own retention.
    const authEventColumns = await env.DB.prepare("PRAGMA table_info(app_auth_event)").all<{
      name: string;
      notnull: number;
    }>();
    expect(authEventColumns.results.map((column) => column.name)).toEqual([
      "id",
      "event_id",
      "app_id",
      "user_id",
      "event",
      "auth_method",
      "outcome",
      "reason",
      "app_version",
      "latency_ms",
      "claim_delay_ms",
      "created_at",
    ]);
    expect(authEventColumns.results.find((column) => column.name === "user_id")?.notnull).toBe(0);
    expect(authEventColumns.results.find((column) => column.name === "outcome")?.notnull).toBe(1);
    // Nullable: most identities never enter the pending-claim state at all.
    expect(userColumns.results.find((column) => column.name === "claim_pending_since")).toMatchObject({
      notnull: 0,
    });
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
      "base_url",
      "gateway_route_json",
      "pricing_json",
      "status",
      "created_by",
      "created_at",
      "updated_at",
      "revision",
    ]);
    expect(providerColumns.results.find((column) => column.name === "gateway_route_json"))
      .toMatchObject({ notnull: 0 });
    expect(providerColumns.results.find((column) => column.name === "base_url"))
      .toMatchObject({ notnull: 0, dflt_value: null });
    expect(providerColumns.results.find((column) => column.name === "revision"))
      .toMatchObject({ notnull: 1, dflt_value: "1" });
    const gatewayColumns = await env.DB.prepare("PRAGMA table_info(provider_gateway)")
      .all<{ name: string; notnull: number; dflt_value: string | null }>();
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
      "revision",
    ]);
    expect(gatewayColumns.results.find((column) => column.name === "revision"))
      .toMatchObject({ notnull: 1, dflt_value: "1" });
    const mgmtTables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'mgmt_%' ORDER BY name",
    ).all<{ name: string }>();
    expect(mgmtTables.results.map((row) => row.name)).toEqual([
      "mgmt_api_key",
      "mgmt_handoff",
      "mgmt_organization",
      "mgmt_organization_user",
      "mgmt_resource_receipt",
      "mgmt_user",
      "mgmt_user_account",
      "mgmt_user_session",
      "mgmt_verification",
    ]);
    const organizationColumns = await env.DB.prepare(
      "PRAGMA table_info(mgmt_organization)",
    ).all<{ name: string }>();
    expect(organizationColumns.results.map((column) => column.name)).toEqual([
      "id",
      "name",
      "expires_at",
      "created_by_user_id",
      "created_at",
      "updated_at",
    ]);
    const verificationColumns = await env.DB.prepare(
      "PRAGMA table_info(mgmt_verification)",
    ).all<{ name: string }>();
    expect(verificationColumns.results.map((column) => column.name)).toEqual([
      "id",
      "identifier",
      "value",
      "expires_at",
      "created_at",
      "updated_at",
    ]);
    expect(managementKeyColumns.results.map((column) => column.name)).toEqual([
      "id",
      "user_id",
      "organization_id",
      "name",
      "token_hash",
      "token_hint",
      "enabled",
      "expires_at",
      "created_at",
      "revoked_at",
    ]);
    const gatewayStateTables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('mgmt_handoff','cli_rate_limit','mgmt_resource_receipt') ORDER BY name",
    ).all<{ name: string }>();
    expect(gatewayStateTables.results.map((row) => row.name)).toEqual([
      "mgmt_handoff",
      "mgmt_resource_receipt",
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

  it("rejects a repeated usage event id while tolerating rows that carry none", async () => {
    const insert = (eventId: string | null) =>
      env.DB.prepare(
        `INSERT INTO app_usage_event(event_id, app_id, user_id, provider_type, model, route, cost_usd, status)
         VALUES (?, 'migration-event-id', 'user-1', 'openai', 'gpt-5.6-sol', 'openai/v1/responses', 0, 'ok')`,
      ).bind(eventId).run();

    // `event_id` is nullable, and SQLite counts every NULL as distinct, so the
    // uniqueness guarantee only binds rows that actually carry one.
    await insert(null);
    await expect(insert(null)).resolves.toBeDefined();
    await insert("migration-event-1");
    await expect(insert("migration-event-1")).rejects.toThrow(/UNIQUE constraint failed/u);
  });

  it("allows one provider row per organization and slug, whatever its status", async () => {
    await seedProviderOrganization();
    const insert = (id: string, slug: string, status: string) =>
      env.DB.prepare(
        `INSERT INTO provider(id, organization_id, type, slug, name, secret_blob, secret_hint, status, created_by)
         VALUES (?, 'org-providers', 'openai', ?, 'Prod OpenAI', 'local1.1.iv.ct', 'abcd', ?, 'provider-owner')`,
      ).bind(id, slug, status).run();

    await insert("provider-1", "openai", "active");
    await expect(insert("provider-2", "openai", "active")).rejects.toThrow(/UNIQUE constraint failed/u);
    await expect(insert("provider-2", "openai-dev", "active")).resolves.toBeDefined();
    // A disabled row occupies the slot too — the index is unconditional — which
    // is what keeps a paused instance's slug from being taken out from under it.
    await insert("provider-3", "openai-paused", "disabled");
    await expect(insert("provider-4", "openai-paused", "active"))
      .rejects.toThrow(/UNIQUE constraint failed/u);
    // `revoked` belongs to gateways, not providers: a provider row is paused
    // with `disabled` or deleted outright.
    await expect(insert("provider-4", "openai-old", "revoked"))
      .rejects.toThrow(/CHECK constraint failed/u);
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
