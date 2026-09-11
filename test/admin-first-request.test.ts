import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { seedApp } from "./helpers";
import { compactUsageEvents } from "../src/core/usage-retention";

/**
 * `has_proxied_requests` on the application list.
 *
 * It exists because the `usage` totals beside it cover one month, and a
 * first-run interface keyed on those would call an organization new again every
 * time a quiet month began. These cover what makes it worth having: it is
 * scoped to the calling organization, independent of the month asked for, and
 * it does not go back to false once true.
 *
 * The tests run in order against one database, walking an organization from
 * empty to having served traffic.
 */
const AUTH = { authorization: "Bearer agw_mgmt_test-admin-secret" };

const listApps = async (month?: string) => {
  const url = month
    ? `https://example.test/v1/admin/apps?month=${month}`
    : "https://example.test/v1/admin/apps";
  const response = await exports.default.fetch(url, { headers: AUTH });
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    month: string;
    has_proxied_requests: boolean;
    apps: { id: string; usage: { requests: number } }[];
  }>;
};

const recordRequest = (appId: string, status: string) =>
  env.DB.prepare(
    `INSERT INTO app_usage_event(
       app_id, user_id, provider_type, model, route, status
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(appId, "user-1", "openai", "gpt-test", "openai/v1/responses", status).run();

describe("whether an organization has ever proxied a request", () => {
  it("is false for an organization with no applications at all", async () => {
    await expect(listApps()).resolves.toMatchObject({
      has_proxied_requests: false,
      apps: [],
    });
  });

  it("is still false once an application exists but has served nothing", async () => {
    await seedApp("first-request-app");

    const body = await listApps();
    expect(body.apps).toHaveLength(1);
    expect(body.has_proxied_requests).toBe(false);
  });

  it("ignores another organization's traffic", async () => {
    // `app.organization_id` is a foreign key, so the neighbour has to exist.
    await env.DB.prepare(
      `INSERT OR IGNORE INTO console_organization(
         id, name, created_by_user_id, created_at, updated_at
       ) VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
    ).bind("other-organization", "Neighbour", "operator-test-owner").run();
    await seedApp("first-request-other-org", { organizationId: "other-organization" });
    await recordRequest("first-request-other-org", "ok");

    const body = await listApps();
    expect(body.apps.map((row) => row.id)).not.toContain("first-request-other-org");
    expect(body.has_proxied_requests).toBe(false);
  });

  /**
   * A refused request still reached the gateway and was recorded against the
   * organization, so it answers the question this field is asked: whether
   * anything has ever called in. Whether the provider then served it is what
   * `usage.blocked` is for.
   */
  it("turns true on the first recorded request, refused or not", async () => {
    await recordRequest("first-request-app", "blocked_billing");

    await expect(listApps()).resolves.toMatchObject({ has_proxied_requests: true });
  });

  /**
   * The whole reason the field exists. The month's usage totals are empty here,
   * and an interface reading those would decide the organization had never sent
   * a request and start explaining how to send one again.
   */
  it("stays true for a month the organization sent nothing in", async () => {
    const quiet = "1999-01";

    const body = await listApps(quiet);
    expect(body.month).toBe(quiet);
    expect(body.apps[0]).toMatchObject({ usage: { requests: 0 } });
    expect(body.has_proxied_requests).toBe(true);
  });

  it("stays true after retention compacts all its raw events", async () => {
    await env.DB.prepare("UPDATE app_usage_event SET created_at = '2020-01-01T00:00:00.000Z'").run();
    await compactUsageEvents(env);
    expect(await env.DB.prepare("SELECT id FROM app_usage_event LIMIT 1").first()).toBeNull();
    await expect(listApps()).resolves.toMatchObject({ has_proxied_requests: true });
  });
});
