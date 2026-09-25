import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migration = (name) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
const apply = (db, sql) => {
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement);
  }
};

test("the forward migration separates retained refusal samples without changing accounting", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys=ON");
    apply(db, migration("0000_initial.sql"));
    apply(db, migration("0001_end_user_none.sql"));
    db.exec(`INSERT INTO mgmt_user(id,name,email,created_at,updated_at) VALUES ('owner','Owner','owner@test.invalid',0,0)`);
    db.exec(`INSERT INTO mgmt_organization(id,name,created_by_user_id,created_at,updated_at)
      VALUES ('account','Account','owner','2026-01-01','2026-01-01')`);
    db.exec(`INSERT INTO app(id,organization_id,name,config_json,auth_type)
      VALUES ('live','account','Live','{}','api_key')`);
    const insert = db.prepare(`INSERT INTO app_usage_event
      (id,event_id,organization_id,app_id,user_id,api_key_id,provider_type,provider_id,
       provider_slug,provider_gateway_id,provider_gateway_type,model,route,endpoint_slug,
       input_tokens,cached_input_tokens,cache_write_tokens,output_tokens,cost_usd,cost_source,
       reported_cost_usd,served_provider,served_model,credential_source,model_author,
       app_version,auth_method,status,client_aborted,latency_ms,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const now = Date.now();
    const recent = new Date(now - 2 * 86_400_000).toISOString();
    const atBoundary = new Date(now - 89 * 86_400_000).toISOString().replace("T", " ").replace("Z", "");
    const expired = new Date(now - 91 * 86_400_000).toISOString();
    const row = (id, eventId, appId, status, createdAt, cost = 0) =>
      insert.run(id,eventId,"account",appId,"user-1","key-1","openai","provider-1",
        "openai-slug","gateway-1","openrouter","gpt-test","openai/v1/responses","chat",
        3,2,1,4,cost,"computed",0.5,"served-provider","served-model","direct","OpenAI",
        "1.0","api_key",status,1,27,createdAt);
    row(42,"served","live","ok",recent,1.25);
    row(43,"error","live","provider_error",recent,0);
    row(44,"refusal-iso","live","blocked_user",recent);
    row(45,"refusal-space","live","blocked_app_rate",atBoundary);
    row(46,"refusal-old","live","blocked_app_budget",expired);
    // Usage outlives app deletion; diagnostics do not.
    row(47,"refusal-deleted","deleted","blocked_billing",recent);
    const before = db.prepare("SELECT * FROM app_usage_event WHERE id=42").get();
    const spend = db.prepare("SELECT scope,user_key,microusd FROM app_usage_spend WHERE app_id='live' ORDER BY scope").all();
    assert.deepEqual(spend.map(({ scope,user_key,microusd }) => ({scope,user_key,microusd})), [
      {scope:"app",user_key:"",microusd:1250000},
      {scope:"user",user_key:"user-1",microusd:1250000},
    ]);
    db.exec(`INSERT INTO app_usage_rollup(grain,bucket,app_id,organization_id,model,provider_type,status,requests,
      input_tokens,cached_input_tokens,cache_write_tokens,output_tokens,cost_usd)
      VALUES ('day','2026-01-01','live','account','gpt-test','openai','ok',7,10,0,0,20,2.5),
             ('day','2026-01-01','live','account','gpt-test','openai','blocked_user',5,0,0,0,0,0)`);

    db.exec("BEGIN");
    apply(db, migration("0002_rejection_events.sql"));
    db.exec("COMMIT");
    const rows = (query) => db.prepare(query).all().map((row) => ({ ...row }));
    assert.deepEqual(rows("SELECT id,event_id,status FROM app_usage_event ORDER BY id"), [
      {id:42,event_id:"served",status:"ok"}, {id:43,event_id:"error",status:"provider_error"},
    ]);
    assert.deepEqual(db.prepare("SELECT * FROM app_usage_event WHERE id=42").get(), before);
    assert.deepEqual(rows("SELECT event_id,reason,scope,user_id,api_key_id FROM app_rejection_event ORDER BY id"), [
      {event_id:"refusal-iso",reason:"blocked_user",scope:null,user_id:"user-1",api_key_id:"key-1"},
      {event_id:"refusal-space",reason:"blocked_app_rate",scope:null,user_id:"user-1",api_key_id:"key-1"},
    ]);
    assert.match(db.prepare("SELECT created_at FROM app_rejection_event WHERE event_id='refusal-space'").get().created_at,
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.equal(Date.parse(db.prepare("SELECT created_at FROM app_rejection_event WHERE event_id='refusal-space'").get().created_at),
      Date.parse(`${atBoundary.replace(" ", "T")}Z`));
    assert.deepEqual(rows("SELECT status,requests FROM app_usage_rollup"), [{status:"ok",requests:7}]);
    assert.deepEqual(rows("SELECT scope,microusd FROM app_usage_spend WHERE app_id='live' ORDER BY scope"),
      [{scope:"app",microusd:1250000},{scope:"user",microusd:1250000}]);
    assert.throws(() => db.exec(`INSERT INTO app_usage_event(event_id,organization_id,app_id,provider_type,model,route,status)
      VALUES ('invalid','account','live','openai','test','test','blocked_user')`), /CHECK constraint failed/);
    db.exec("UPDATE app_usage_event SET cost_usd=2 WHERE id=42");
    assert.deepEqual(rows("SELECT scope,microusd FROM app_usage_spend WHERE app_id='live' ORDER BY scope"),
      [{scope:"app",microusd:2000000},{scope:"user",microusd:2000000}]);
    db.exec(`INSERT OR IGNORE INTO app_usage_event(event_id,organization_id,app_id,provider_type,model,route,status,cost_usd)
      VALUES ('served','account','live','openai','test','test','ok',9)`);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM app_usage_event").get().n,2);
    assert.equal(db.prepare("SELECT microusd FROM app_usage_spend WHERE scope='app' AND app_id='live'").get().microusd,2000000);
    db.exec(`INSERT INTO app_usage_event(event_id,organization_id,app_id,provider_type,model,route,status,cost_usd)
      VALUES ('new','account','live','openai','test','test','ok',0.5)`);
    assert.equal(db.prepare("SELECT microusd FROM app_usage_spend WHERE scope='app' AND app_id='live'").get().microusd,2500000);
    assert.throws(() => db.exec(`INSERT INTO app_usage_event(event_id,organization_id,app_id,provider_type,model,route,status)
      VALUES ('orphan','missing','deleted','openai','test','test','ok')`), /organization no longer exists/);
  } finally {
    db.close();
  }
});
