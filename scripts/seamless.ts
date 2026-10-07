import { REALTIME_BACKEND_CONTRACT } from '../src/realtime/contract.ts';
import { REALTIME_MAX_SESSION_SECONDS, REALTIME_LIMITS } from '../src/realtime/limits.ts';
import { latestDeployment } from './deploy-lib.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';

/** Compatibility declarations are reviewed on changes; migrations stay expand-only. */
export const RELEASE_COMPATIBILITY = { backend: REALTIME_BACKEND_CONTRACT, schema: 1, classes: 1 } as const;
export const RELEASE_RETENTION_MS = (REALTIME_MAX_SESSION_SECONDS + 60 + 3600) * 1000 + REALTIME_LIMITS.outboxRetentionMs;
const LEASE_MS = 10 * 60_000;
type Config = Record<string, unknown> & { name: string; vars?: Record<string, unknown>; account_id?: string };
export interface RunResult { stdout?: string; stderr?: string; status?: number | null }
export interface ReleaseDriver {
  run(args: string[], options?: { capture?: boolean; companion?: boolean }): Promise<RunResult>;
  /** Return only the named Worker's settings, or null for API codes 10007/10090. */
  settings(name: string): Promise<{ bindings?: { name: string; text?: string; type?: string }[] } | null>;
  health(url: string): Promise<Record<string, unknown>>;
  log(message: string): void;
  sleep?: (ms: number) => Promise<void>;
}
export interface ReleaseInput {
  config: Config;
  configPath: string;
  realtimeConfig: Config;
  realtimeBundle: string;
  mainBundle: string;
  version: string;
  gatewayOrigin: string;
  subdomain: string;
  /** Caller handles first-install provisioning and secret setup under this lease. */
  prepare?: () => Promise<void>;
  deployMain: (buildId: string) => Promise<void>;
  action?: 'deploy' | 'cleanup' | 'rollback';
  rollbackId?: string;
}
const quote = (value: string | number) => typeof value === 'number' ? String(value) : "'" + value.replaceAll("'", "''") + "'";
export function companionEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  delete copy.WRANGLER_CI_OVERRIDE_NAME;
  delete copy.WRANGLER_CI_MATCH_TAG;
  return copy;
}
export function releaseFingerprint(bundle: Uint8Array, config: Config, gatewayOrigin: string, primaryName: string): string {
  // Entire bundled code, runtime target/config and trusted installation wiring.
  const { name: _name, main: _main, $schema: _schema, no_bundle: _bundle, vars: _vars, services: _services, ...runtime } = config;
  return createHash('sha256').update(bundle).update(JSON.stringify({ runtime, gatewayOrigin, primaryName, backend: RELEASE_COMPATIBILITY.backend })).digest('hex');
}
function rows(result: RunResult): Record<string, unknown>[] {
  const text = result.stdout ?? '';
  const start = text.indexOf('[');
  if (start < 0) throw new Error('D1 returned no JSON result');
  const batches = JSON.parse(text.slice(start)) as { results?: Record<string, unknown>[]; success?: boolean }[];
  if (batches.some(batch => batch.success === false)) throw new Error('D1 release query failed');
  return batches.flatMap(batch => batch.results ?? []);
}
export async function seamlessRelease(input: ReleaseInput, driver: ReleaseDriver): Promise<{ buildId: string; realtimeId: string; previousDeployment?: string }> {
  const { config } = input;
  const query = async (sql: string) => rows(await driver.run(['d1', 'execute', 'DB', '--remote', '--json', '--config', input.configPath, '--command', sql], { capture: true }));
  // Build/read artifacts before acquiring the lease or changing remote state.
  if (!config.vars?.DEPLOYMENT_ID) throw new Error('Deployment identity is required');
  if (input.action !== 'cleanup' && input.action !== 'rollback') { await readFile(input.mainBundle); await readFile(input.realtimeBundle); }
  const owner = randomUUID();
  // Bootstrap only the advisory lease, before ordinary migrations or secret mutations.
  await query(`CREATE TABLE IF NOT EXISTS gateway_release_state (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), active_realtime_id TEXT, deployment_owner TEXT, deployment_expires_at INTEGER, promotion_at INTEGER, current_deployment_id TEXT); INSERT OR IGNORE INTO gateway_release_state(singleton) VALUES(1)`);
  const acquired = await query(`UPDATE gateway_release_state SET deployment_owner=${quote(owner)}, deployment_expires_at=${Date.now() + LEASE_MS} WHERE singleton=1 AND (deployment_owner IS NULL OR deployment_expires_at <= ${Date.now()}) RETURNING deployment_owner`);
  if (acquired[0]?.deployment_owner !== owner) throw new Error('Another deployment holds the installation lease; retry after it finishes or its 10 minute lease expires');
  const lease = async () => {
    const renewal = await query(`UPDATE gateway_release_state SET deployment_expires_at=${Date.now() + LEASE_MS} WHERE singleton=1 AND deployment_owner=${quote(owner)} AND deployment_expires_at>${Date.now()} RETURNING deployment_owner`);
    if (renewal[0]?.deployment_owner !== owner) throw new Error('Deployment lease expired or changed; promotion stopped');
  };
  let previousDeployment: string | undefined;
  try {
    const promote = async (id: string, promotedBuild: string) => {
      const changed = await query(`UPDATE gateway_release_state SET active_realtime_id=${quote(id)}, current_deployment_id=${quote(promotedBuild)}, promotion_at=${Date.now()} WHERE singleton=1 AND deployment_owner=${quote(owner)} AND deployment_expires_at>${Date.now()} RETURNING active_realtime_id`);
      if (changed[0]?.active_realtime_id !== id) throw new Error('Deployment lease expired before promotion; active release unchanged');
    };
    const tables = await query("SELECT name FROM sqlite_master WHERE type='table' AND name='realtime_release'");
    if (tables.length) {
      const incompatible = await query(`SELECT id FROM realtime_release WHERE backend_contract != ${RELEASE_COMPATIBILITY.backend}`);
      if (incompatible.length) throw new Error('Retained realtime runtimes require a compatible backend; preflight stopped before migrations');
    }
    const history = tables.length ? await query('SELECT d.* FROM gateway_deployment d JOIN gateway_release_state s ON s.current_deployment_id=d.id WHERE s.singleton=1') : [];
    const currentDeployment = history[0];
    if (currentDeployment && (currentDeployment.backend_contract !== RELEASE_COMPATIBILITY.backend || currentDeployment.schema_generation !== RELEASE_COMPATIBILITY.schema || currentDeployment.class_generation !== RELEASE_COMPATIBILITY.classes)) throw new Error('Current deployment is incompatible with this release backend/schema/class lifecycle. Use a reviewed compatible migration release; no migrations or Worker deployments started');
    await input.prepare?.();
    await lease();
    previousDeployment = currentDeployment?.id as string | undefined;
    if (history[0]) driver.log(`Previous deployment: ${history[0].id}; main version: ${history[0].main_version_id}; realtime release: ${history[0].realtime_id}`);
    const installation = createHash('sha256').update(String(config.vars?.DEPLOYMENT_ID)).digest('hex').slice(0, 12);
    const prefix = `agw-rt-${installation}-`;
    const cleanup = async () => {
      const retired = await query(`SELECT id, worker_name FROM realtime_release WHERE delete_after<=${Date.now()} AND retired_at IS NOT NULL AND id != COALESCE((SELECT active_realtime_id FROM gateway_release_state WHERE singleton=1),'')`);
      for (const row of retired) {
        if (typeof row.worker_name !== 'string' || !row.worker_name.startsWith(prefix) || !/^[a-f0-9]{64}$/u.test(String(row.id)) || row.worker_name !== prefix + String(row.id).slice(0, 24)) throw new Error('Refusing cleanup of an unknown realtime resource');
        await lease();
        const settings = await driver.settings(row.worker_name);
        if (settings && settings.bindings?.find(binding => binding.name === 'REALTIME_RELEASE_ID')?.text !== row.id) throw new Error('Retired Worker identity mismatch; cleanup stopped');
        if (settings) await driver.run(['delete', '--config', input.configPath, '--name', row.worker_name, '--force'], { companion: true });
        await query(`DELETE FROM gateway_deployment WHERE realtime_id=${quote(String(row.id))}; DELETE FROM realtime_release WHERE id=${quote(String(row.id))}`);
      }
    };
    if (input.action === 'cleanup') { await cleanup(); return { buildId: '', realtimeId: '', ...(previousDeployment ? { previousDeployment } : {}) }; }
    if (input.action === 'rollback') {
      const target = (await query(`SELECT d.*, r.url FROM gateway_deployment d JOIN realtime_release r ON r.id=d.realtime_id WHERE d.id=${quote(input.rollbackId ?? '')}`))[0];
      if (!currentDeployment || !target || target.backend_contract !== RELEASE_COMPATIBILITY.backend || target.schema_generation !== RELEASE_COMPATIBILITY.schema || target.class_generation !== RELEASE_COMPATIBILITY.classes || currentDeployment && (target.backend_contract !== currentDeployment.backend_contract || target.schema_generation !== currentDeployment.schema_generation || target.class_generation !== currentDeployment.class_generation)) throw new Error('Rollback target is missing or incompatible with the current backend/schema/class lifecycle; no database rollback is performed');
      const settings = await driver.settings(prefix + String(target.realtime_id).slice(0, 24));
      if (settings?.bindings?.find(binding => binding.name === 'REALTIME_RELEASE_ID')?.text !== target.realtime_id) throw new Error('Retained realtime Worker is unavailable; rollback stopped');
      await lease();
      await driver.run(['rollback', String(target.main_version_id), '--config', input.configPath, '--message', 'Explicit compatible release rollback', '--yes']);
      await verifyHealth(driver, input.gatewayOrigin, { buildId: String(target.id), ready: true }, 'Expected restored main build and ready database/bindings were not observed');
      await lease();
      await promote(String(target.realtime_id), String(target.id));
      driver.log(`Rollback complete: ${target.id}. Database unchanged.`);
      return { buildId: String(target.id), realtimeId: String(target.realtime_id), ...(previousDeployment ? { previousDeployment } : {}) };
    }
    const realtimeId = releaseFingerprint(await readFile(input.realtimeBundle), input.realtimeConfig, input.gatewayOrigin, config.name);
    const buildId = randomUUID();
    const name = prefix + realtimeId.slice(0, 24);
    const realtimeUrl = `https://${name}.${input.subdomain}.workers.dev`;
    await lease();
    await input.deployMain(buildId);
    await verifyHealth(driver, input.gatewayOrigin, { buildId, ready: true }, 'Expected new main build and ready database/bindings were not observed');
    const existing = await driver.settings(name);
    if (existing) {
      if (existing.bindings?.find(binding => binding.name === 'REALTIME_RELEASE_ID')?.text !== realtimeId) throw new Error('Realtime Worker name collision; retained Worker will not be changed');
      driver.log(`Reusing immutable realtime release ${realtimeId}`);
    } else {
      const realtimeConfig: Config = { ...input.realtimeConfig, name, ...(config.account_id ? { account_id: config.account_id } : {}), main: resolve(input.realtimeBundle), no_bundle: true,
        vars: { REALTIME_RELEASE_ID: realtimeId, GATEWAY_ORIGIN: input.gatewayOrigin }, services: [{ binding: 'BACKEND', service: config.name, entrypoint: 'RealtimeBackend' }] };
      const path = join(dirname(input.configPath), `realtime-${realtimeId}.json`);
      await writeFile(path, JSON.stringify(realtimeConfig), { mode: 0o600 });
      await lease();
      await driver.run(['deploy', '--config', path], { companion: true });
    }
    await query(`INSERT OR IGNORE INTO realtime_release(id,worker_name,url,backend_contract,created_at) VALUES(${quote(realtimeId)},${quote(name)},${quote(realtimeUrl.replace('https:', 'wss:'))},${RELEASE_COMPATIBILITY.backend},${Date.now()})`);
    await lease();
    await verifyHealth(driver, realtimeUrl, { releaseId: realtimeId }, 'Realtime candidate health identity mismatch; active release unchanged');
    const deployed = latestDeployment((await driver.run(['deployments', 'list', '--json', '--config', input.configPath], { capture: true })).stdout ?? '[]');
    const current = deployed?.versions;
    if (current?.length !== 1 || current[0]?.percentage !== 100) throw new Error('Expected a single 100% main deployment; active realtime release unchanged');
    const version = JSON.parse((await driver.run(['versions', 'view', current[0].version_id, '--json', '--config', input.configPath], { capture: true })).stdout ?? '{}') as { resources?: { bindings?: { name: string; type: string; text?: string }[] } };
    const binding = version.resources?.bindings?.find(binding => binding.name === 'GATEWAY_BUILD_ID' && binding.type === 'plain_text');
    if (binding?.text !== buildId) throw new Error('Current Cloudflare version does not match verified main build; promotion stopped');
    await lease();
    await query(`INSERT OR REPLACE INTO gateway_deployment(id,main_version_id,release_version,realtime_id,backend_contract,schema_generation,class_generation,created_at) VALUES(${quote(buildId)},${quote(current[0].version_id)},${quote(input.version)},${quote(realtimeId)},${RELEASE_COMPATIBILITY.backend},${RELEASE_COMPATIBILITY.schema},${RELEASE_COMPATIBILITY.classes},${Date.now()})`);
    await promote(realtimeId, buildId);
    driver.log(`Promoted 100%: main ${buildId}; realtime ${realtimeId}. Rollback target: ${previousDeployment ?? 'none (first install)'}`);
    try { await cleanup(); } catch { driver.log('Deployment promoted successfully; retired release cleanup is pending. Run deployment cleanup after fixing Cloudflare access.'); }
    return { buildId, realtimeId, ...(previousDeployment ? { previousDeployment } : {}) };
  } finally {
    await query(`UPDATE gateway_release_state SET deployment_owner=NULL, deployment_expires_at=NULL WHERE singleton=1 AND deployment_owner=${quote(owner)}`);
  }
}
async function verifyHealth(driver: ReleaseDriver, origin: string, expected: Record<string, unknown>, failure: string): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const response = await driver.health(origin);
      if (response.ok === true && response.backendContract === RELEASE_COMPATIBILITY.backend && Object.entries(expected).every(([key, value]) => response[key] === value)) return;
      last = new Error(failure);
    } catch (error) { last = error; }
    if (attempt < 19) await (driver.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(1500);
  }
  throw last;
}
