import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

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
    }>();
    expect(providerColumns.results.map((column) => column.name)).toEqual([
      "id",
      "organization_id",
      "type",
      "name",
      "secret_blob",
      "secret_hint",
      "gateway",
      "gateway_config_json",
      "pricing_json",
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

  it("allows one active provider row per organization and type", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO console_user(id, name, email, email_verified, created_at, updated_at)
         VALUES ('provider-owner', 'Owner', 'owner@providers.test', 1, 0, 0)`,
      ),
      env.DB.prepare(
        `INSERT INTO console_organization(id, name, created_by_user_id, created_at, updated_at)
         VALUES ('org-providers', 'Providers', 'provider-owner', datetime('now'), datetime('now'))`,
      ),
    ]);
    const insert = (id: string, status: string) =>
      env.DB.prepare(
        `INSERT INTO provider(id, organization_id, type, name, secret_blob, secret_hint, status, created_by)
         VALUES (?, 'org-providers', 'openai', 'Prod OpenAI', 'local1.1.iv.ct', 'abcd', ?, 'provider-owner')`,
      ).bind(id, status).run();

    await insert("provider-1", "active");
    await expect(insert("provider-2", "active")).rejects.toThrow(/UNIQUE constraint failed/u);
    // A revoked row does not occupy the slot.
    await insert("provider-3", "revoked");
    await expect(insert("provider-4", "sideways")).rejects.toThrow(/CHECK constraint failed/u);
  });
});
