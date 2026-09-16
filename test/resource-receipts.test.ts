import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { seedServerApp, serverConfig } from "./helpers";

const AUTH = { authorization: "Bearer agw_mgmt_test-admin-secret" };
const token = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
function headers(id: string, proof: string) {
  return { ...AUTH, "content-type": "application/json", "Idempotency-Key": id, "X-Idempotency-Proof": proof };
}
function create(path: string, body: unknown, id: string, proof: string) {
  return exports.default.fetch(`https://example.test/v1/admin${path}`, {
    method: "POST", headers: headers(id, proof), body: JSON.stringify(body),
  });
}
const appBody = (name: string) => ({ name, config: serverConfig() });

describe("atomic resource creation receipts", () => {
  it("replays an app and its original one-time key after a lost response", async () => {
    const id = token(); const proof = token(); const body = appBody("Receipt app replay");
    const first = await create("/apps", body, id, proof);
    expect(first.status).toBe(201);
    const original = await first.json() as any;
    const retry = await create("/apps", body, id, proof);
    expect(retry.status).toBe(201);
    expect(await retry.json()).toEqual(original);
    const apps = await env.DB.prepare("SELECT COUNT(*) AS count FROM app WHERE name = ?")
      .bind(body.name).first<{ count: number }>();
    expect(apps?.count).toBe(1);
    const keys = await env.DB.prepare("SELECT COUNT(*) AS count FROM app_api_key WHERE app_id = ?")
      .bind(original.app.id).first<{ count: number }>();
    expect(keys?.count).toBe(1);
    const stored = await env.DB.prepare("SELECT request_hash,outcome,protected_credential FROM mgmt_resource_receipt WHERE kind='cli.resource.app.add' AND outcome LIKE ?")
      .bind(`%${original.app.id}%`).first<{ request_hash: string; outcome: string; protected_credential: string }>();
    expect(JSON.stringify(stored)).not.toContain(original.api_key.key);
  });

  it("lets concurrent identical requests create exactly one app and key", async () => {
    const id = token(); const proof = token(); const body = appBody("Receipt concurrent app");
    const responses = await Promise.all(Array.from({ length: 4 }, () => create("/apps", body, id, proof)));
    expect(responses.map(r => r.status)).toEqual([201, 201, 201, 201]);
    const results = await Promise.all(responses.map(r => r.json())) as any[];
    expect(new Set(results.map(r => r.app.id)).size).toBe(1);
    expect(new Set(results.map(r => r.api_key.key)).size).toBe(1);
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM app WHERE name = ?")
      .bind(body.name).first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it("requires both proofs and rejects another proof or body without mutating", async () => {
    const id = token(); const proof = token(); const body = appBody("Receipt binding");
    expect((await create("/apps", body, id, proof)).status).toBe(201);
    expect((await create("/apps", body, id, token())).status).toBe(403);
    expect((await create("/apps", appBody("Wrong receipt body"), id, proof)).status).toBe(409);
    const partial = await exports.default.fetch("https://example.test/v1/admin/apps", {
      method: "POST", headers: { ...AUTH, "content-type": "application/json", "Idempotency-Key": token() }, body: JSON.stringify(body),
    });
    expect(partial.status).toBe(400);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM app WHERE name = 'Wrong receipt body'").first<{ count: number }>())?.count).toBe(0);
  });

  it("rolls back app, key and receipt together if any mutation statement fails", async () => {
    const id = token(); const proof = token(); const body = appBody("Receipt mutation rollback");
    await env.DB.prepare(`CREATE TRIGGER receipt_test_key_failure BEFORE INSERT ON app_api_key
      WHEN (SELECT name FROM app WHERE id=NEW.app_id)='Receipt mutation rollback'
      BEGIN SELECT RAISE(ABORT,'receipt_test_key_failure'); END`).run();
    try {
      expect((await create("/apps", body, id, proof)).status).toBe(500);
      expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM app WHERE name=?").bind(body.name).first<{ count: number }>())?.count).toBe(0);
    } finally { await env.DB.prepare("DROP TRIGGER receipt_test_key_failure").run(); }
    const retry = await create("/apps", body, id, proof);
    expect(retry.status).toBe(201);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM app WHERE name=?").bind(body.name).first<{ count: number }>())?.count).toBe(1);
  });

  it("replays key creation under concurrency and refuses redelivery after revocation", async () => {
    const appId = "receipt-server-keys";
    await seedServerApp(appId);
    const id = token(); const proof = token(); const body = { name: "Receipt CI key" };
    const responses = await Promise.all([create(`/apps/${appId}/keys`, body, id, proof), create(`/apps/${appId}/keys`, body, id, proof)]);
    expect(responses.map(r => r.status)).toEqual([201, 201]);
    const results = await Promise.all(responses.map(r => r.json())) as any[];
    expect(results[0]).toEqual(results[1]);
    const keyId = results[0].id;
    expect((await exports.default.fetch(`https://example.test/v1/admin/apps/${appId}/keys/${keyId}/revoke`, { method: "POST", headers: AUTH })).status).toBe(200);
    const retry = await create(`/apps/${appId}/keys`, body, id, proof);
    expect(retry.status).toBe(410);
    expect(await retry.json()).toMatchObject({ error: { code: "resource_key_unavailable", data: { keyId } } });
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM app_api_key WHERE app_id=? AND name=?").bind(appId, body.name).first<{ count: number }>())?.count).toBe(1);
  });

  it("keeps recovery references after the secret exchange expires and never remints", async () => {
    const id = token(); const proof = token(); const body = appBody("Receipt expired key");
    const first = await (await create("/apps", body, id, proof)).json() as any;
    const changed = await env.DB.prepare("UPDATE mgmt_resource_receipt SET protected_credential_expires_at=0 WHERE outcome LIKE ?").bind(`%${first.app.id}%`).run();
    expect(changed.meta.changes).toBe(1);
    const retry = await create("/apps", body, id, proof);
    expect(retry.status).toBe(410);
    expect(await retry.json()).toMatchObject({ error: { code: "resource_receipt_expired", data: { appId: first.app.id, keyId: first.api_key.id } } });
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM app WHERE name=?").bind(body.name).first<{ count: number }>())?.count).toBe(1);
  });
});
