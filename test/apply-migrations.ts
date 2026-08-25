import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll } from "vitest";
import { hashApiKeyToken } from "@maxceem/cf-auth";

export const TEST_OPERATOR_USER_ID = "operator-test-owner";
export const TEST_ORGANIZATION_ID = "operator-test-organization";
export const TEST_MANAGEMENT_KEY = "agw_mgmt_test-admin-secret";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const now = new Date();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO console_user(
        id, name, email, email_verified, created_at, updated_at
      ) VALUES (?, ?, ?, 1, ?, ?)`,
    ).bind(
      TEST_OPERATOR_USER_ID,
      "Test Owner",
      "owner@example.test",
      now.getTime(),
      now.getTime(),
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO console_organization(
        id, name, created_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      TEST_ORGANIZATION_ID,
      "Test Organization",
      TEST_OPERATOR_USER_ID,
      now.toISOString(),
      now.toISOString(),
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO console_organization_user(
        id, organization_id, user_id, role, status, joined_at
      ) VALUES (?, ?, ?, 'owner', 'active', ?)`,
    ).bind(
      "operator-test-membership",
      TEST_ORGANIZATION_ID,
      TEST_OPERATOR_USER_ID,
      now.toISOString(),
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO console_api_key(
        id, organization_id, name, token_hash, created_at
      ) VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      "operator-test-key",
      TEST_ORGANIZATION_ID,
      "Test management key",
      await hashApiKeyToken(TEST_MANAGEMENT_KEY),
      now.toISOString(),
    ),
  ]);
});
