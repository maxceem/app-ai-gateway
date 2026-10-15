import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seamlessRelease, releaseFingerprint, companionEnvironment, RELEASE_RETENTION_MS } from '../scripts/seamless.ts';

async function fixture(t, empty = false) {
  const directory = await mkdtemp(join(tmpdir(), 'seamless-release-'));
  const db = new DatabaseSync(':memory:');
  if (!empty) db.exec(await readFile(new URL('../migrations/0008_realtime_releases.sql', import.meta.url), 'utf8'));
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  const main = join(directory, 'index.js'); const rt = join(directory, 'worker.js');
  await writeFile(main, 'main'); await writeFile(rt, 'realtime');
  const workers = new Map(); const versions = new Map(); const calls = []; let build = ''; let version = '';
  const input = { config: { name: 'primary', vars: { DEPLOYMENT_ID: 'installation' } }, configPath: join(directory, 'primary.json'),
    realtimeConfig: { name: 'local', main: 'worker.ts', compatibility_date: '2026-07-24', durable_objects: { bindings: [{ name: 'REALTIME_SESSION', class_name: 'RealtimeSession' }] } },
    realtimeBundle: rt, mainBundle: main, version: '0.7.0', gatewayOrigin: 'https://primary.account.workers.dev', subdomain: 'account', seamless: true,
    deployMain: async id => { calls.push('main'); build = id; version = 'version-' + id; versions.set(version, id); workers.set('primary', {}); },
  };
  const driver = { log: () => {}, settings: async name => workers.get(name) ?? null,
    health: async url => { calls.push('health'); if (url === input.gatewayOrigin) return { ok: true, buildId: build, ready: true, backendContract: 1 };
      return { ok: true, releaseId: workers.get(new URL(url).hostname.split('.')[0]).bindings[0].text, backendContract: 1 }; },
    run: async (args, options = {}) => {
      calls.push({ args, options });
      if (args[0] === 'd1') {
        const sql = args[args.indexOf('--command') + 1];
        let rows = [];
        if (sql.startsWith('CREATE') || sql.includes(';')) db.exec(sql);
        else rows = db.prepare(sql).all();
        return { stdout: JSON.stringify([{ success: true, results: rows }]) };
      }
      if (args[0] === 'deploy') {
        assert.equal(options.companion, true);
        const config = JSON.parse(await readFile(args[args.indexOf('--config') + 1], 'utf8'));
        workers.set(config.name, { bindings: [{ name: 'REALTIME_RELEASE_ID', text: config.vars.REALTIME_RELEASE_ID }] });
        return {};
      }
      if (args[0] === 'versions') return { stdout: JSON.stringify({ resources: { bindings: [{ name: 'GATEWAY_BUILD_ID', type: 'plain_text', text: versions.get(args[2]) }] } }) };
      if (args[0] === 'deployments') return { stdout: JSON.stringify([{ created_on: new Date().toISOString(), versions: [{ version_id: version, percentage: 100 }] }]) };
      if (args[0] === 'rollback') { build = versions.get(args[1]); version = args[1]; return {}; }
      if (args[0] === 'delete') { workers.delete(args[args.indexOf('--name') + 1]); return {}; }
      throw new Error('Unexpected command ' + args);
    },
  };
  return { db, workers, calls, input, driver, rt };
}
const active = f => f.db.prepare('SELECT * FROM gateway_release_state').get();

test('two promotions retire atomically; main-only update reuses artifact; rollback resets retirement', async t => {
  const f = await fixture(t);
  const first = await seamlessRelease(f.input, f.driver);
  const mainOnly = await seamlessRelease({ ...f.input, config: { ...f.input.config, vars: { ...f.input.config.vars, OTHER: 'changed' } } }, f.driver);
  assert.equal(mainOnly.realtimeId, first.realtimeId); assert.notEqual(mainOnly.buildId, first.buildId);
  assert.equal(f.calls.filter(call => typeof call === 'object' && call.args[0] === 'deploy').length, 1);
  await writeFile(f.rt, 'new realtime code');
  const second = await seamlessRelease(f.input, f.driver);
  assert.equal(active(f).active_realtime_id, second.realtimeId);
  const retired = f.db.prepare('SELECT * FROM realtime_release WHERE id=?').get(first.realtimeId);
  assert.equal(retired.delete_after - retired.retired_at, RELEASE_RETENTION_MS);
  await seamlessRelease({ ...f.input, action: 'rollback', rollbackId: first.buildId }, f.driver);
  assert.equal(active(f).active_realtime_id, first.realtimeId);
  assert.equal(f.db.prepare('SELECT delete_after FROM realtime_release WHERE id=?').get(first.realtimeId).delete_after, null);
  assert.notEqual(f.db.prepare('SELECT retired_at FROM realtime_release WHERE id=?').get(second.realtimeId).retired_at, null);
  assert.equal(active(f).deployment_owner, null);
  const afterRollback = await seamlessRelease(f.input, f.driver);
  assert.equal(afterRollback.previousDeployment, first.buildId);
  const mainIndex = f.calls.indexOf('main');
  const rtIndex = f.calls.findIndex(call => typeof call === 'object' && call.args[0] === 'deploy');
  assert.ok(mainIndex < rtIndex);
});
test('lease conflict and missing artifact fail before deployment', async t => {
  const f = await fixture(t);
  f.db.prepare('UPDATE gateway_release_state SET deployment_owner=?,deployment_expires_at=?').run('other', Date.now() + 600000);
  await assert.rejects(seamlessRelease(f.input, f.driver), /Another deployment/);
  assert.ok(!f.calls.includes('main'));
  const count = f.calls.length;
  await assert.rejects(seamlessRelease({ ...f.input, realtimeBundle: '/missing-artifact' }, f.driver));
  assert.equal(f.calls.length, count);
});
test('failed preparation and candidate health preserve active pointer and release lease', async t => {
  const f = await fixture(t); const first = await seamlessRelease(f.input, f.driver);
  await assert.rejects(seamlessRelease({ ...f.input, prepare: async () => { throw new Error('migration failure'); } }, f.driver), /migration failure/);
  assert.equal(active(f).active_realtime_id, first.realtimeId); assert.equal(active(f).deployment_owner, null);
  await writeFile(f.rt, 'new code');
  await assert.rejects(seamlessRelease(f.input, { ...f.driver, sleep: async () => {}, health: async url => url === f.input.gatewayOrigin ? f.driver.health(url) : { ok: true, releaseId: 'wrong', backendContract: 1 } }), /candidate health/);
  assert.equal(active(f).active_realtime_id, first.realtimeId); assert.equal(active(f).deployment_owner, null);
});
test('cleanup only removes expired known retired workers; rollback fails closed on incompatibility', async t => {
  const f = await fixture(t); const first = await seamlessRelease(f.input, f.driver);
  await writeFile(f.rt, 'new'); const second = await seamlessRelease(f.input, f.driver);
  f.db.prepare('UPDATE realtime_release SET delete_after=0 WHERE id=?').run(first.realtimeId);
  await seamlessRelease({ ...f.input, action: 'cleanup' }, f.driver);
  assert.equal(f.db.prepare('SELECT * FROM realtime_release WHERE id=?').get(first.realtimeId), undefined);
  assert.equal(active(f).active_realtime_id, second.realtimeId);
  f.db.prepare('UPDATE gateway_deployment SET schema_generation=2 WHERE id=?').run(second.buildId);
  await assert.rejects(seamlessRelease({ ...f.input, action: 'rollback', rollbackId: second.buildId }, f.driver), /incompatible/);
});
test('fingerprint covers bundle/runtime/wiring and normalizes packaging; companion isolates primary CI name', () => {
  const cfg = { name: 'local', main: 'src/worker.ts', compatibility_date: '2026-07-24' };
  const hash = releaseFingerprint(Buffer.from('bundle'), cfg, 'https://gateway.test', 'primary');
  assert.equal(hash, releaseFingerprint(Buffer.from('bundle'), { ...cfg, name: 'packaged', main: './worker.js', no_bundle: true }, 'https://gateway.test', 'primary'));
  assert.notEqual(hash, releaseFingerprint(Buffer.from('changed'), cfg, 'https://gateway.test', 'primary'));
  assert.notEqual(hash, releaseFingerprint(Buffer.from('bundle'), { ...cfg, compatibility_date: '2026-10-07' }, 'https://gateway.test', 'primary'));
  const env = { WRANGLER_CI_OVERRIDE_NAME: 'selected-primary', WRANGLER_CI_MATCH_TAG: 'tag', CLOUDFLARE_ACCOUNT_ID: 'account' };
  assert.deepEqual(companionEnvironment(env), { CLOUDFLARE_ACCOUNT_ID: 'account' });
  assert.equal(env.WRANGLER_CI_OVERRIDE_NAME, 'selected-primary');
});

test('empty control DB bootstrap is retryable and owns lease before migrations', async t => {
  const f = await fixture(t, true);
  const input = { ...f.input, prepare: async () => {
    assert.ok(active(f).deployment_owner);
    f.db.exec(await readFile(new URL('../migrations/0008_realtime_releases.sql', import.meta.url), 'utf8'));
  } };
  const first = await seamlessRelease(input, f.driver);
  const retried = await seamlessRelease({ ...f.input, prepare: async () => {} }, f.driver);
  assert.equal(first.realtimeId, retried.realtimeId);
  assert.equal(active(f).deployment_owner, null);
});
test('main readiness mismatch never creates/promotes realtime and waits a bounded number of times', async t => {
  const f = await fixture(t); let sleeps = 0;
  await assert.rejects(seamlessRelease(f.input, { ...f.driver, sleep: async () => { sleeps++; }, health: async () => ({ ok: true, buildId: 'old', ready: false, backendContract: 1 }) }), /Expected new main/);
  assert.equal(sleeps, 19);
  assert.equal(active(f).active_realtime_id, null);
  assert.equal(active(f).deployment_owner, null);
  assert.equal(f.calls.filter(call => typeof call === 'object' && call.args[0] === 'deploy').length, 0);
});
test('cleanup failure after promotion preserves success and reports pending cleanup', async t => {
  const f = await fixture(t); const first = await seamlessRelease(f.input, f.driver);
  await writeFile(f.rt, 'changed'); await seamlessRelease(f.input, f.driver);
  f.db.prepare('UPDATE realtime_release SET delete_after=0 WHERE id=?').run(first.realtimeId);
  const messages = [];
  const driver = { ...f.driver, log: message => messages.push(message), run: async (...args) => {
    if (args[0][0] === 'delete') throw new Error('management unavailable'); return f.driver.run(...args);
  } };
  const promoted = await seamlessRelease(f.input, driver);
  assert.equal(active(f).current_deployment_id, promoted.buildId);
  assert.ok(messages.some(message => message.includes('cleanup is pending')));
  await assert.rejects(seamlessRelease({ ...f.input, action: 'cleanup' }, driver), /management unavailable/);
});

test('realtime readiness tolerates routing propagation before promotion', async t => {
  const f = await fixture(t); let attempts = 0; let sleeps = 0;
  const release = await seamlessRelease(f.input, { ...f.driver, sleep: async () => { sleeps++; }, health: async url => {
    if (url !== f.input.gatewayOrigin && ++attempts < 3) throw new Error('workers.dev routing not ready');
    return f.driver.health(url);
  } });
  assert.equal(attempts, 3); assert.equal(sleeps, 2);
  assert.equal(active(f).active_realtime_id, release.realtimeId);
});

test('older release engine refuses current schema/class generations before migration or rollback', async t => {
  const f = await fixture(t); const first = await seamlessRelease(f.input, f.driver);
  await writeFile(f.rt, 'new code'); const current = await seamlessRelease(f.input, f.driver);
  for (const column of ['schema_generation', 'class_generation']) {
    f.db.prepare(`UPDATE gateway_deployment SET ${column}=2 WHERE id=?`).run(current.buildId);
    const before = f.calls.length; let prepared = false;
    for (const action of ['deploy', 'rollback']) await assert.rejects(seamlessRelease({ ...f.input, action, rollbackId: first.buildId, prepare: async () => { prepared = true; } }, f.driver), /Current deployment is incompatible.*migration release/);
    assert.equal(prepared, false);
    assert.ok(f.calls.slice(before).every(call => typeof call === 'object' && !['rollback', 'deploy'].includes(call.args[0])));
    assert.equal(active(f).current_deployment_id, current.buildId);
    f.db.prepare(`UPDATE gateway_deployment SET ${column}=1 WHERE id=?`).run(current.buildId);
  }
});
test('a slow main deploy keeps its lease renewed, and a lapsed one stops before promotion', async t => {
  const f = await fixture(t);
  const stall = async (expiresInMs, waitMs) => {
    f.db.prepare('UPDATE gateway_release_state SET deployment_expires_at=?').run(Date.now() + expiresInMs);
    await new Promise(resolve => setTimeout(resolve, waitMs));
    // A competing release tries to take the lease once the original window has passed.
    return f.db.prepare('UPDATE gateway_release_state SET deployment_owner=? WHERE deployment_expires_at<=? RETURNING deployment_owner').all('competitor', Date.now());
  };
  let competitor;
  const renewed = await seamlessRelease({ ...f.input, deployMain: async id => { competitor = await stall(500, 800); await f.input.deployMain(id); } }, { ...f.driver, heartbeatMs: 10 });
  assert.equal(competitor.length, 0);
  assert.equal(active(f).active_realtime_id, renewed.realtimeId);
  await writeFile(f.rt, 'slower code');
  await assert.rejects(seamlessRelease({ ...f.input, deployMain: async id => { await stall(20, 80); await f.input.deployMain(id); } }, { ...f.driver, heartbeatMs: 60_000 }), /lease was lost/);
  assert.equal(active(f).active_realtime_id, renewed.realtimeId);
  // The upload landed without the lease, so the recorded release serves again.
  assert.equal((await f.driver.health(f.input.gatewayOrigin)).buildId, renewed.buildId);
});
test('cleanup deletes a candidate that failed verification and was never promoted', async t => {
  const f = await fixture(t); await seamlessRelease(f.input, f.driver);
  await writeFile(f.rt, 'broken candidate');
  await assert.rejects(seamlessRelease(f.input, { ...f.driver, sleep: async () => {}, health: async url => url === f.input.gatewayOrigin ? f.driver.health(url) : { ok: true, releaseId: 'wrong', backendContract: 1 } }), /candidate health/);
  const failed = f.db.prepare('SELECT * FROM realtime_release WHERE retired_at IS NULL AND id != (SELECT active_realtime_id FROM gateway_release_state)').get();
  assert.ok(failed && f.workers.has(failed.worker_name));
  await seamlessRelease({ ...f.input, action: 'cleanup' }, f.driver);
  assert.ok(f.db.prepare('SELECT * FROM realtime_release WHERE id=?').get(failed.id), 'a fresh candidate is kept through its grace period');
  f.db.prepare('UPDATE realtime_release SET created_at=0 WHERE id=?').run(failed.id);
  await writeFile(f.rt, 'fixed candidate');
  const fixed = await seamlessRelease(f.input, f.driver);
  assert.equal(f.db.prepare('SELECT * FROM realtime_release WHERE id=?').get(failed.id), undefined);
  assert.ok(!f.workers.has(failed.worker_name));
  assert.equal(active(f).active_realtime_id, fixed.realtimeId);
});

test('a companion deploy that stops partway leaves a row cleanup can find', async t => {
  const f = await fixture(t); await seamlessRelease(f.input, f.driver);
  await writeFile(f.rt, 'interrupted candidate');
  const interrupted = { ...f.driver, run: async (args, options) => {
    if (args[0] === 'deploy') { const config = JSON.parse(await readFile(args[args.indexOf('--config') + 1], 'utf8')); f.workers.set(config.name, { bindings: [{ name: 'REALTIME_RELEASE_ID', text: config.vars.REALTIME_RELEASE_ID }] }); throw new Error('Interrupted after upload'); }
    return f.driver.run(args, options);
  } };
  await assert.rejects(seamlessRelease(f.input, interrupted), /Interrupted after upload/);
  const orphan = f.db.prepare('SELECT * FROM realtime_release WHERE id != (SELECT active_realtime_id FROM gateway_release_state)').get();
  assert.ok(orphan && f.workers.has(orphan.worker_name), 'the uploaded companion is recorded');
  f.db.prepare('UPDATE realtime_release SET created_at=0 WHERE id=?').run(orphan.id);
  await seamlessRelease({ ...f.input, action: 'cleanup' }, f.driver);
  assert.ok(!f.workers.has(orphan.worker_name));
  assert.equal(f.db.prepare('SELECT * FROM realtime_release WHERE id=?').get(orphan.id), undefined);
});

test('a reused release takes the URL the account serves it on now', async t => {
  const f = await fixture(t); const first = await seamlessRelease(f.input, f.driver);
  const again = await seamlessRelease({ ...f.input, subdomain: 'renamed' }, f.driver);
  assert.equal(again.realtimeId, first.realtimeId);
  assert.match(f.db.prepare('SELECT url FROM realtime_release WHERE id=?').get(first.realtimeId).url, /\.renamed\.workers\.dev$/u);
});

test('a deploy that lost its lease mid-upload restores the release that finished meanwhile', async t => {
  const f = await fixture(t); await seamlessRelease(f.input, f.driver);
  let newer;
  const stalled = seamlessRelease({ ...f.input, deployMain: async id => {
    // Stalled past its lease: another release takes over and promotes.
    f.db.prepare('UPDATE gateway_release_state SET deployment_expires_at=?').run(Date.now() - 1);
    newer = await seamlessRelease(f.input, f.driver);
    // Only then does the stalled upload land, over the newer gateway.
    await f.input.deployMain(id);
  } }, f.driver);
  await assert.rejects(stalled, /restored to build/);
  assert.equal(active(f).current_deployment_id, newer.buildId);
  assert.equal((await f.driver.health(f.input.gatewayOrigin)).buildId, newer.buildId);
  assert.equal(active(f).deployment_owner, null);
});

test('the heartbeat stops the main upload once another release holds the lease', async t => {
  const f = await fixture(t); await seamlessRelease(f.input, f.driver);
  let aborted = false;
  const upload = async (id, signal) => {
    f.db.prepare("UPDATE gateway_release_state SET deployment_owner='competitor'").run();
    await new Promise(resolve => { signal.addEventListener('abort', resolve, { once: true }); setTimeout(resolve, 2000); });
    aborted = signal.aborted;
    if (aborted) throw signal.reason;
    await f.input.deployMain(id);
  };
  await assert.rejects(seamlessRelease({ ...f.input, deployMain: upload }, { ...f.driver, heartbeatMs: 10 }), /another deployment holds it/);
  assert.ok(aborted, 'the upload was stopped');
});

test('a lease that cannot be released does not turn a promoted release into a failure', async t => {
  const f = await fixture(t);
  const flaky = { ...f.driver, run: async (args, options) => {
    if (args[0] === 'd1' && args[args.indexOf('--command') + 1].includes('deployment_owner=NULL')) throw new Error('Simulated D1 outage');
    return f.driver.run(args, options);
  } };
  const released = await seamlessRelease(f.input, flaky);
  assert.equal(active(f).active_realtime_id, released.realtimeId);
});

test('a gateway that serves realtime itself deploys no release Worker and needs no workers.dev', async t => {
  const f = await fixture(t);
  const simple = { ...f.input, seamless: false, subdomain: undefined };
  await writeFile(f.rt, ''); await rm(f.rt);
  const released = await seamlessRelease(simple, f.driver);
  assert.equal(released.realtimeId, null);
  assert.equal(f.calls.filter(call => typeof call === 'object' && call.args[0] === 'deploy').length, 0);
  assert.equal(active(f).active_realtime_id, null);
  assert.equal(active(f).current_deployment_id, released.buildId);
  assert.equal(f.db.prepare('SELECT realtime_id FROM gateway_deployment WHERE id=?').get(released.buildId).realtime_id, null);
});

test('switching modes retires the release Worker for its sessions to finish, and back promotes one', async t => {
  const f = await fixture(t);
  const seamless = await seamlessRelease(f.input, f.driver);
  // To simple: the release Worker keeps the sessions it has and is cleaned up after them.
  const simple = await seamlessRelease({ ...f.input, seamless: false }, f.driver);
  assert.equal(active(f).active_realtime_id, null);
  const retired = f.db.prepare('SELECT * FROM realtime_release WHERE id=?').get(seamless.realtimeId);
  assert.notEqual(retired.retired_at, null);
  assert.ok(f.workers.has(retired.worker_name), 'its sessions and usage recovery still run there');
  f.db.prepare('UPDATE realtime_release SET delete_after=0 WHERE id=?').run(seamless.realtimeId);
  await seamlessRelease({ ...f.input, seamless: false }, f.driver);
  assert.ok(!f.workers.has(retired.worker_name));
  // A rollback across modes restores that deployment's routing.
  await writeFile(f.rt, 'seamless again');
  const again = await seamlessRelease(f.input, f.driver);
  assert.equal(active(f).active_realtime_id, again.realtimeId);
  await seamlessRelease({ ...f.input, action: 'rollback', rollbackId: simple.buildId }, f.driver);
  assert.equal(active(f).active_realtime_id, null);
  assert.notEqual(f.db.prepare('SELECT retired_at FROM realtime_release WHERE id=?').get(again.realtimeId).retired_at, null);
});

test('a stopped upload that lands late is still found and undone', async t => {
  const f = await fixture(t); const first = await seamlessRelease(f.input, f.driver);
  const upload = async (id, signal) => {
    // Another release takes the lease and finishes, recording nothing new.
    f.db.prepare("UPDATE gateway_release_state SET deployment_owner='competitor'").run();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    f.db.prepare('UPDATE gateway_release_state SET deployment_owner=NULL, deployment_expires_at=NULL').run();
    // Cloudflare had the upload already: it goes live after the stop.
    setTimeout(() => { f.input.deployMain(id); }, 60);
    throw signal.reason;
  };
  await assert.rejects(seamlessRelease({ ...f.input, deployMain: upload }, { ...f.driver, heartbeatMs: 10, sleep: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 20))) }), /restored to build/);
  assert.equal((await f.driver.health(f.input.gatewayOrigin)).buildId, first.buildId);
});

test('a repair that cannot keep its lease still names the build that may be serving', async t => {
  const f = await fixture(t); await seamlessRelease(f.input, f.driver);
  let lost;
  const upload = async (id, signal) => {
    f.db.prepare("UPDATE gateway_release_state SET deployment_owner='competitor'").run();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    f.db.prepare('UPDATE gateway_release_state SET deployment_owner=NULL, deployment_expires_at=NULL').run();
    lost = id;
    throw signal.reason;
  };
  // The lease is taken again while the repair watches for the stopped upload.
  const sleep = async () => { f.db.prepare("UPDATE gateway_release_state SET deployment_owner='third'").run(); };
  await assert.rejects(seamlessRelease({ ...f.input, deployMain: upload }, { ...f.driver, heartbeatMs: 10, sleep }), error => error.message.includes('repairing that failed') && error.message.includes(lost));
});
