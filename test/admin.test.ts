import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { appleConfig, seedApp, seedProvider, serverConfig } from "./helpers";

describe("admin API", () => {
  it("requires operator authentication and returns exact monthly usage rollups", async () => {
    await seedApp("admin-rollup");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO app_usage_event(
           app_id, user_id, provider_type, model, route, input_tokens,
           cached_input_tokens, cache_write_tokens, output_tokens, cost_usd, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind("admin-rollup", "user-1", "openai", "known", "openai/v1/responses", 10, 2, 0, 3, 0.01, "ok"),
      env.DB.prepare(
        `INSERT INTO app_usage_event(
           app_id, user_id, provider_type, model, route, input_tokens,
           cached_input_tokens, cache_write_tokens, output_tokens, cost_usd, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind("admin-rollup", "user-1", "openai", "known-2", "openai/v1/responses", 4, 0, 1, 2, 0.02, "ok"),
    ]);
    const month = new Date().toISOString().slice(0, 7);
    const url = `https://example.test/v1/admin/apps/admin-rollup/usage?month=${month}`;
    const denied = await exports.default.fetch(url);
    expect(denied.status).toBe(401);

    const response = await exports.default.fetch(url, {
      headers: { authorization: "Bearer agw_mgmt_test-admin-secret" },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      app_id: "admin-rollup",
      month,
      requests: 2,
      input_tokens: 14,
      cached_input_tokens: 2,
      cache_write_tokens: 1,
      output_tokens: 5,
      cost_usd: 0.03,
    });
  });

  it("previews and applies usage repricing while reconciling budget limiters", async () => {
    const appId = "admin-reprice";
    const userId = "user-1";
    await seedApp(appId, { appBudgetUsd: 100 });
    await env.DB.prepare(
      `INSERT INTO app_usage_event(
         app_id, user_id, provider_type, model, route, input_tokens,
         cached_input_tokens, cache_write_tokens, output_tokens, cost_usd, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      appId,
      userId,
      "openai",
      "gpt-5.6-luna",
      "openai/v1/responses",
      50,
      40,
      10,
      20,
      0.000184,
      "ok",
    ).run();
    const userLimiter = env.USER_LIMITER.getByName(`${appId}:${userId}`);
    const appLimiter = env.USER_LIMITER.getByName(appId);
    await userLimiter.addCost(crypto.randomUUID(), Date.now(), 184);
    await appLimiter.addCost(crypto.randomUUID(), Date.now(), 184);
    const month = new Date().toISOString().slice(0, 7);
    const url = `https://example.test/v1/admin/apps/${appId}/usage/reprice`;
    const request = (apply: boolean) => exports.default.fetch(url, {
      method: "POST",
      headers: {
        authorization: "Bearer agw_mgmt_test-admin-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ provider: "openai", model: "gpt-5.6-luna", month, apply }),
    });

    const preview = await request(false);
    expect(preview.status).toBe(200);
    await expect(preview.json()).resolves.toMatchObject({
      applied: false,
      matched_events: 1,
      previous_cost_usd: 0.000184,
      recalculated_cost_usd: 0.0000373,
      reconciled_users: 0,
    });
    expect((await userLimiter.getStatus(Date.now())).monthlyCostMicrousd).toBe(184);

    const applied = await request(true);
    expect(applied.status).toBe(200);
    await expect(applied.json()).resolves.toMatchObject({
      applied: true,
      matched_events: 1,
      recalculated_cost_usd: 0.0000373,
      reconciled_users: 1,
    });
    const row = await env.DB.prepare("SELECT cost_usd FROM app_usage_event WHERE app_id = ?")
      .bind(appId)
      .first<{ cost_usd: number }>();
    expect(row?.cost_usd).toBeCloseTo(0.0000373, 10);
    expect((await userLimiter.getStatus(Date.now())).monthlyCostMicrousd).toBe(37);
    expect((await appLimiter.getStatus(Date.now())).monthlyCostMicrousd).toBe(37);
  });

  /**
   * Repricing recomputes a local estimate. An event billed on what the upstream
   * actually charged has no estimate to go back to, so leaving it out is what
   * keeps the reported figure meaningful.
   */
  it("leaves an event billed on a reported cost out of repricing", async () => {
    const appId = "admin-reprice-reported";
    await seedApp(appId);
    const insert = (costSource: string | null, costUsd: number) => env.DB.prepare(
      `INSERT INTO app_usage_event(
         app_id, user_id, provider_type, model, route, input_tokens,
         cached_input_tokens, cache_write_tokens, output_tokens, cost_usd,
         cost_source, reported_cost_usd, status
       ) VALUES (?, 'user-1', 'openai', 'gpt-5.6-luna', 'openai/v1/responses',
                 50, 40, 10, 20, ?, ?, ?, 'ok')`,
    ).bind(appId, costUsd, costSource, costSource === "reported" ? costUsd : null).run();
    await insert(null, 0.000184);
    await insert("reported", 0.5);
    const month = new Date().toISOString().slice(0, 7);
    const preview = await exports.default.fetch(
      `https://example.test/v1/admin/apps/${appId}/usage/reprice`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer agw_mgmt_test-admin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ provider: "openai", model: "gpt-5.6-luna", month, apply: true }),
      },
    );
    expect(preview.status).toBe(200);
    await expect(preview.json()).resolves.toMatchObject({
      // Only the locally priced event; the reported one was never a candidate.
      matched_events: 1,
      previous_cost_usd: 0.000184,
    });
    const reported = await env.DB.prepare(
      "SELECT cost_usd FROM app_usage_event WHERE app_id = ? AND cost_source = 'reported'",
    ).bind(appId).first<{ cost_usd: number }>();
    expect(reported?.cost_usd).toBe(0.5);
  });

  it("reprices each event with its serving provider instance override", async () => {
    const appId = "admin-reprice-instances";
    await seedApp(appId);
    await seedProvider({
      type: "openai",
      id: "admin-reprice-openai-dev",
      slug: "openai-dev",
      pricing: { "gpt-5.6-luna": { input: 0, output: 0 } },
    });
    const insert = env.DB.prepare(
      `INSERT INTO app_usage_event(
         app_id, user_id, provider_type, provider_id, provider_slug, model, route,
         input_tokens, cached_input_tokens, cache_write_tokens, output_tokens, cost_usd, status
       ) VALUES (?, 'user-1', 'openai', ?, ?, 'gpt-5.6-luna', ?, 50, 40, 10, 20, 1, 'ok')`,
    );
    await env.DB.batch([
      insert.bind(
        appId,
        "provider_operator-test-organization_openai",
        "openai",
        "openai/v1/responses",
      ),
      insert.bind(
        appId,
        "admin-reprice-openai-dev",
        "openai-dev",
        "openai-dev/v1/responses",
      ),
    ]);
    const month = new Date().toISOString().slice(0, 7);
    const response = await exports.default.fetch(
      `https://example.test/v1/admin/apps/${appId}/usage/reprice`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer agw_mgmt_test-admin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          provider: "openai",
          model: "gpt-5.6-luna",
          month,
          apply: false,
        }),
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      matched_events: 2,
      recalculated_cost_usd: 0.0000373,
    });
    await env.DB.prepare("DELETE FROM provider WHERE id = 'admin-reprice-openai-dev'").run();
  });

  // Pricing is resolved per event through the row that served it, so a deleted
  // instance can leave a single event unpriceable. A dry run reports that; only
  // apply refuses to touch a month it cannot reprice completely.
  it("reports unpriceable events on a dry run and refuses to apply them", async () => {
    const appId = "admin-reprice-partial";
    await seedApp(appId);
    await seedProvider({
      type: "openai",
      id: "admin-reprice-custom",
      slug: "openai-custom",
      pricing: { "custom-only-model": { input: 1, output: 2 } },
    });
    const insert = env.DB.prepare(
      `INSERT INTO app_usage_event(
         app_id, user_id, provider_type, provider_id, provider_slug, model, route,
         input_tokens, cached_input_tokens, cache_write_tokens, output_tokens, cost_usd, status
       ) VALUES (?, 'user-1', 'openai', ?, ?, 'custom-only-model', 'openai/v1/responses',
         1000000, 0, 0, 0, 0.5, 'ok')`,
    );
    await env.DB.batch([
      insert.bind(appId, "admin-reprice-custom", "openai-custom"),
      // The row that served this one is gone, so nothing prices its model.
      insert.bind(appId, "admin-reprice-deleted", "openai-deleted"),
    ]);
    const month = new Date().toISOString().slice(0, 7);
    const reprice = (apply: boolean) => exports.default.fetch(
      `https://example.test/v1/admin/apps/${appId}/usage/reprice`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer agw_mgmt_test-admin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ provider: "openai", model: "custom-only-model", month, apply }),
      },
    );

    const preview = await reprice(false);
    expect(preview.status).toBe(200);
    await expect(preview.json()).resolves.toMatchObject({
      applied: false,
      matched_events: 1,
      unpriced_events: 1,
      unpriced_cost_usd: 0.5,
      recalculated_cost_usd: 1,
    });

    const applied = await reprice(true);
    expect(applied.status).toBe(400);
    await expect(applied.json()).resolves.toMatchObject({
      error: { code: "invalid_request", message: "No token price is configured for openai/custom-only-model" },
    });
    // Nothing was written: a refused apply leaves every stored cost alone.
    const untouched = await env.DB
      .prepare("SELECT cost_usd FROM app_usage_event WHERE app_id = ? ORDER BY id")
      .bind(appId)
      .all<{ cost_usd: number }>();
    expect(untouched.results.map((row) => row.cost_usd)).toEqual([0.5, 0.5]);
    await env.DB.prepare("DELETE FROM provider WHERE id = 'admin-reprice-custom'").run();
  });

  it("rejects an insecure issuer URL during app upsert", async () => {
    const response = await exports.default.fetch("https://example.test/v1/admin/apps/insecure-issuer", {
      method: "POST",
      headers: {
        authorization: "Bearer agw_mgmt_test-admin-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Insecure issuer",
        config: appleConfig({ jwks_url: "http://issuer.test/jwks" }),
      }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_request" } });
  });

  it("validates the optional issuer on API-key applications", async () => {
    const config = serverConfig({
      authentication: {
        type: "api_key",
        issuer: {
          jwks_url: "http://issuer.test/jwks",
          user_id_claim: "sub",
          required_claims: [],
          max_token_lifetime_seconds: 3600,
        },
        end_user: { header: "x-end-user-id", required: false, fallback: "api_key" },
      },
    });
    const response = await exports.default.fetch(
      "https://example.test/v1/admin/apps/invalid-api-key-issuer",
      {
        method: "POST",
        headers: {
          authorization: "Bearer agw_mgmt_test-admin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Invalid API key issuer", config }),
      },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_request" } });
  });

  it.each([
    ["development_access", () => {
      const config = serverConfig() as any;
      config.authentication.development_access = true;
      return config;
    }],
    ["app_attest.environments", () => {
      const config = appleConfig({ jwks_url: "https://issuer.test/jwks" }) as any;
      config.authentication.app_attest.environments = ["development"];
      return config;
    }],
  ])("rejects the removed auth field %s instead of stripping it", async (_field, config) => {
    const response = await exports.default.fetch(
      "https://example.test/v1/admin/apps/removed-auth-field",
      {
        method: "POST",
        headers: {
          authorization: "Bearer agw_mgmt_test-admin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Removed auth field", config: config() }),
      },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_request" },
    });
  });

  it("creates, lists, and revokes one-time server API keys", async () => {
    const createApp = await exports.default.fetch(
      "https://example.test/v1/admin/apps/admin-server-keys",
      {
        method: "POST",
        headers: {
          authorization: "Bearer agw_mgmt_test-admin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "Admin server keys",
          config: serverConfig({
            limits: { rpm: 100, rpd: 1000, app_rpm: 500 },
            appBudgetUsd: 10,
          }),
        }),
      },
    );
    expect(createApp.status).toBe(200);

    const created = await exports.default.fetch(
      "https://example.test/v1/admin/apps/admin-server-keys/keys",
      {
        method: "POST",
        headers: {
          authorization: "Bearer agw_mgmt_test-admin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Production Worker" }),
      },
    );
    expect(created.status).toBe(201);
    const createdBody = await created.json<{
      id: string;
      key: string;
      key_prefix: string;
    }>();
    expect(createdBody.key).toMatch(/^agw_[0-9A-Za-z]{40,}$/u);
    expect(createdBody.key_prefix).toBe(createdBody.key.slice(0, 12));

    const listed = await exports.default.fetch(
      "https://example.test/v1/admin/apps/admin-server-keys/keys",
      { headers: { authorization: "Bearer agw_mgmt_test-admin-secret" } },
    );
    expect(listed.status).toBe(200);
    const listText = await listed.text();
    expect(listText).not.toContain(createdBody.key);
    expect(listText).not.toContain("key_hash");
    const listBody = JSON.parse(listText) as { keys: Array<{ id: string; status: string }> };
    expect(listBody.keys).toEqual([
      expect.objectContaining({ id: createdBody.id, status: "active" }),
    ]);

    const revoked = await exports.default.fetch(
      `https://example.test/v1/admin/apps/admin-server-keys/keys/${createdBody.id}/revoke`,
      {
        method: "POST",
        headers: { authorization: "Bearer agw_mgmt_test-admin-secret" },
      },
    );
    expect(revoked.status).toBe(200);
    await expect(revoked.json()).resolves.toMatchObject({
      key: { id: createdBody.id, status: "revoked" },
    });

    await seedApp("issuer-no-keys");
    const issuerCreate = await exports.default.fetch(
      "https://example.test/v1/admin/apps/issuer-no-keys/keys",
      {
        method: "POST",
        headers: {
          authorization: "Bearer agw_mgmt_test-admin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Not allowed" }),
      },
    );
    expect(issuerCreate.status).toBe(400);
  });

  it("rejects unknown auth modes and invalid app-level limits", async () => {
    for (const body of [
      {
        name: "Unknown mode",
        config: serverConfig({ authentication: { type: "unknown" } }),
      },
      {
        name: "Invalid app rate",
        config: serverConfig({ limits: { app_rpm: 0 } }),
      },
      {
        name: "Invalid app budget",
        config: serverConfig({ appBudgetUsd: -1 }),
      },
    ]) {
      const response = await exports.default.fetch(
        "https://example.test/v1/admin/apps/invalid-server-config",
        {
          method: "POST",
          headers: {
            authorization: "Bearer agw_mgmt_test-admin-secret",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "invalid_request" },
      });
    }
  });
});
