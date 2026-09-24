import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { seedServerApp, serverConfig } from "./helpers";

/** The CLI surface answers for a deployment with a public identity. */
const runtime = new Proxy(env, {
  get(target, key, receiver) {
    if (key === "DEPLOYMENT_ID") return "operation-tests";
    return Reflect.get(target, key, receiver);
  },
});

const AUTH = { authorization: "Bearer agw_mgmt_test-admin-secret" };
const token = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");

/** Sends one CLI operation with the test management key. */
function send(kind: string, payload: unknown, operationToken: string) {
  return worker.request("https://example.test/v1/cli/operations", {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ kind, payload, token: operationToken }),
  }, runtime);
}
const appBody = (name: string) => ({ name, config: serverConfig() });

describe("immediate app operations", () => {
  it("replays an app and its original one-time key after a lost response", async () => {
    const operationToken = token();
    const body = appBody("Operation app replay");
    const first = await send("app.add", body, operationToken);
    expect(first.status, await first.clone().text()).toBe(200);
    const original = await first.json() as any;
    expect(original).toMatchObject({ state: "completed", result: { app: { name: body.name } } });
    expect(original.result.api_key.key).toMatch(/^agw_/u);
    const retry = await send("app.add", body, operationToken);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(original);
    const apps = await env.DB.prepare("SELECT COUNT(*) AS count FROM app WHERE name = ?")
      .bind(body.name).first<{ count: number }>();
    expect(apps?.count).toBe(1);
    const keys = await env.DB.prepare("SELECT COUNT(*) AS count FROM app_api_key WHERE app_id = ?")
      .bind(original.result.app.id).first<{ count: number }>();
    expect(keys?.count).toBe(1);
    // The plaintext is only ever sealed: neither the record nor the request holds it.
    const stored = await env.DB.prepare("SELECT request_json,request_hash,outcome_json,sealed_outcome FROM mgmt_operation WHERE id=?")
      .bind(original.id).first();
    expect(JSON.stringify(stored)).not.toContain(original.result.api_key.key);
  });

  it("lets concurrent identical requests create exactly one app and key", async () => {
    const operationToken = token();
    const body = appBody("Operation concurrent app");
    const responses = await Promise.all(Array.from({ length: 4 }, () => send("app.add", body, operationToken)));
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    const results = await Promise.all(responses.map((r) => r.json())) as any[];
    expect(new Set(results.map((r) => r.result.app.id)).size).toBe(1);
    expect(new Set(results.map((r) => r.result.api_key.key)).size).toBe(1);
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM app WHERE name = ?")
      .bind(body.name).first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it("refuses another body under the same token without mutating", async () => {
    const operationToken = token();
    expect((await send("app.add", appBody("Operation binding"), operationToken)).status).toBe(200);
    expect((await send("app.add", appBody("Wrong operation body"), operationToken)).status).toBe(409);
    expect((await send("app.key.add", { app: "anything", name: "x" }, operationToken)).status).toBe(409);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM app WHERE name = 'Wrong operation body'").first<{ count: number }>())?.count).toBe(0);
  });

  it("answers a stored row that breaks its kind's rules as an internal error", async () => {
    const operationToken = token();
    const first = await send("app.add", appBody("Operation malformed row"), operationToken);
    expect(first.status).toBe(200);
    const { id } = await first.json() as { id: string };
    await env.DB.prepare("UPDATE mgmt_operation SET initiating_credential_id=NULL WHERE id=?").bind(id).run();
    const retry = await send("app.add", appBody("Operation malformed row"), operationToken);
    expect(retry.status).toBe(500);
    await expect(retry.json()).resolves.toMatchObject({ error: { code: "internal_error" } });
  });

  it("judges the token on the row a racing request stored, not on the first read", async () => {
    const operationToken = token();
    const body = appBody("Operation lost race");
    // Stands in for a concurrent request with another body under the same token,
    // whose row lands between this request's read and its own ignored insert.
    await env.DB.prepare(`CREATE TRIGGER operation_test_race BEFORE INSERT ON mgmt_operation
      WHEN NEW.request_hash <> 'racer'
      BEGIN INSERT INTO mgmt_operation(id,kind,state,organization_id,initiating_user_id,
        initiating_credential_id,request_hash,expires_at,created_at,updated_at)
        VALUES (NEW.id,NEW.kind,'pending',NEW.organization_id,NEW.initiating_user_id,
        NEW.initiating_credential_id,'racer',NEW.expires_at,NEW.created_at,NEW.updated_at); END`).run();
    try {
      expect((await send("app.add", body, operationToken)).status).toBe(409);
    } finally { await env.DB.prepare("DROP TRIGGER operation_test_race").run(); }
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM app WHERE name=?").bind(body.name).first<{ count: number }>())?.count).toBe(0);
  });

  it("rolls back app, key and completion together if any statement fails, and completes on retry", async () => {
    const operationToken = token();
    const body = appBody("Operation mutation rollback");
    await env.DB.prepare(`CREATE TRIGGER operation_test_key_failure BEFORE INSERT ON app_api_key
      WHEN (SELECT name FROM app WHERE id=NEW.app_id)='Operation mutation rollback'
      BEGIN SELECT RAISE(ABORT,'operation_test_key_failure'); END`).run();
    try {
      expect((await send("app.add", body, operationToken)).status).toBe(500);
      expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM app WHERE name=?").bind(body.name).first<{ count: number }>())?.count).toBe(0);
    } finally { await env.DB.prepare("DROP TRIGGER operation_test_key_failure").run(); }
    const retry = await send("app.add", body, operationToken);
    expect(retry.status).toBe(200);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM app WHERE name=?").bind(body.name).first<{ count: number }>())?.count).toBe(1);
  });

  it("replays key creation under concurrency", async () => {
    const appId = "operation-server-keys";
    await seedServerApp(appId);
    const operationToken = token();
    const body = { app: appId, name: "Operation CI key" };
    const responses = await Promise.all([send("app.key.add", body, operationToken), send("app.key.add", body, operationToken)]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    const results = await Promise.all(responses.map((r) => r.json())) as any[];
    expect(results[0]).toEqual(results[1]);
    expect(results[0].result.api_key).toMatchObject({ name: body.name, key: expect.stringMatching(/^agw_/u) });
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM app_api_key WHERE app_id=? AND name=?").bind(appId, body.name).first<{ count: number }>())?.count).toBe(1);
    expect((await send("app.key.add", { app: "someone-elses-app", name: "x" }, token())).status).toBe(404);
  });

  it("does not hand over a sealed key that was revoked after it was minted", async () => {
    const appId = "operation-revoked-key";
    await seedServerApp(appId);
    const operationToken = token();
    const body = { app: appId, name: "Operation revoked key" };
    const first = await (await send("app.key.add", body, operationToken)).json() as any;
    expect(first.result.api_key.key).toMatch(/^agw_/u);
    await env.DB.prepare("UPDATE app_api_key SET status='revoked' WHERE id=?").bind(first.result.api_key.id).run();
    const retry = await (await send("app.key.add", body, operationToken)).json() as any;
    expect(retry.result.api_key.id).toBe(first.result.api_key.id);
    expect(retry.result.api_key).not.toHaveProperty("key");
  });

  it("keeps what was created after the key's window closes, and never remints", async () => {
    const operationToken = token();
    const body = appBody("Operation expired key");
    const first = await (await send("app.add", body, operationToken)).json() as any;
    const changed = await env.DB.prepare("UPDATE mgmt_operation SET sealed_until=0 WHERE id=?").bind(first.id).run();
    expect(changed.meta.changes).toBe(1);
    const retry = await (await send("app.add", body, operationToken)).json() as any;
    // Where the resource is, and its key's id — but the plaintext is gone.
    expect(retry.result.app.id).toBe(first.result.app.id);
    expect(retry.result.api_key.id).toBe(first.result.api_key.id);
    expect(retry.result.api_key).not.toHaveProperty("key");
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM app WHERE name=?").bind(body.name).first<{ count: number }>())?.count).toBe(1);
  });
});
