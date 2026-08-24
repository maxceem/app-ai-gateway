import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("initial database migration", () => {
  it("creates the complete current schema", async () => {
    const userColumns = await env.DB.prepare("PRAGMA table_info(users)").all<{ name: string }>();
    const usageColumns = await env.DB.prepare("PRAGMA table_info(usage_events)").all<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>();
    const appColumns = await env.DB.prepare("PRAGMA table_info(apps)").all<{
      name: string;
      notnull: number;
    }>();
    const apiKeyColumns = await env.DB.prepare("PRAGMA table_info(api_keys)").all<{ name: string }>();
    const developmentCredentialColumns = await env.DB
      .prepare("PRAGMA table_info(development_credentials)")
      .all<{ name: string }>();
    const apiKeyIndexes = await env.DB.prepare("PRAGMA index_list(api_keys)").all<{
      name: string;
      unique: number;
    }>();

    expect(userColumns.results.map((column) => column.name)).toContain("attest_env");
    expect(usageColumns.results.map((column) => column.name)).toContain("auth_method");
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
    const operatorTables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'operator_%' ORDER BY name",
    ).all<{ name: string }>();
    expect(operatorTables.results.map((row) => row.name)).toEqual([
      "operator_account",
      "operator_api_key",
      "operator_organization",
      "operator_organization_user",
      "operator_session",
      "operator_user",
      "operator_verification",
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
    expect(developmentCredentialColumns.results.map((column) => column.name)).toEqual([
      "app_id",
      "secret_hash",
      "secret_prefix",
      "created_at",
      "rotated_at",
    ]);
  });

  it("rejects usage events without a cost", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO usage_events(app_id, user_id, provider, model, route, cost_usd, status)
         VALUES ('migration-cost', 'user-1', 'openai', 'gpt-5.6-sol', 'openai/v1/responses', NULL, 'ok')`,
      ).run(),
    ).rejects.toThrow(/NOT NULL constraint failed: usage_events.cost_usd/u);
  });
});
