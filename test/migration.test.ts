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
    expect(usageColumns.results.find((column) => column.name === "cost_usd")).toMatchObject({
      notnull: 1,
      dflt_value: "0",
    });
    expect(appColumns.results.map((column) => column.name)).toEqual([
      "id",
      "name",
      "config_json",
      "status",
      "created_at",
      "updated_at",
      "organization_id",
    ]);
    expect(appColumns.results.find((column) => column.name === "organization_id")?.notnull).toBe(0);
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
        `INSERT INTO app_usage_event(app_id, user_id, provider, model, route, cost_usd, status)
         VALUES ('migration-cost', 'user-1', 'openai', 'gpt-5.6-sol', 'openai/v1/responses', NULL, 'ok')`,
      ).run(),
    ).rejects.toThrow(/NOT NULL constraint failed: app_usage_event.cost_usd/u);
  });
});
