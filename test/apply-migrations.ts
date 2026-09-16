import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll } from "vitest";
import { hashApiKey } from "../src/core/apikeys";
import { seedAllProviders } from "./helpers";

export const TEST_SERVICE_USER_ID = "operator-test-owner";
export const TEST_ORGANIZATION_ID = "operator-test-organization";
export const TEST_MANAGEMENT_KEY = "agw_mgmt_test-admin-secret";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const now = new Date();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO mgmt_user(
        id, name, email, kind, email_verified, created_at, updated_at
      ) VALUES (?, ?, NULL, 'service', 0, ?, ?)`,
    ).bind(
      TEST_SERVICE_USER_ID,
      "Test Owner",
      now.getTime(),
      now.getTime(),
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO mgmt_organization(
        id, name, created_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      TEST_ORGANIZATION_ID,
      "Test Organization",
      TEST_SERVICE_USER_ID,
      now.toISOString(),
      now.toISOString(),
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO mgmt_user(
        id, name, email, kind, email_verified, created_at, updated_at
      ) VALUES ('operator-test-human', 'Human Owner', 'owner@test.invalid', 'human', 1, ?, ?)`,
    ).bind(now.getTime(), now.getTime()),
    env.DB.prepare(
      `INSERT OR IGNORE INTO mgmt_organization_user(
        id, organization_id, user_id, role, status, joined_at
      ) VALUES (?, ?, ?, 'owner', 'active', ?)`,
    ).bind(
      "operator-test-membership",
      TEST_ORGANIZATION_ID,
      TEST_SERVICE_USER_ID,
      now.toISOString(),
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO mgmt_organization_user(
        id, organization_id, user_id, role, status, joined_at
      ) VALUES ('operator-test-human-membership', ?, 'operator-test-human', 'owner', 'active', ?)`,
    ).bind(TEST_ORGANIZATION_ID, now.toISOString()),
    env.DB.prepare(
      `INSERT OR IGNORE INTO mgmt_api_key(
        id, user_id, organization_id, name, token_hash, token_hint, enabled, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
    ).bind(
      "identity-test-key",
      TEST_SERVICE_USER_ID,
      TEST_ORGANIZATION_ID,
      "Test management key",
      await hashApiKey(TEST_MANAGEMENT_KEY),
      TEST_MANAGEMENT_KEY.slice(-4),
      now.getTime(),
    ),
  ]);
  // Every suite that proxies needs the test organization to have credentials,
  // so the default fixture configures all five providers natively.
  await seedAllProviders();
});
