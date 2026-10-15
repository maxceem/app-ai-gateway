import { REALTIME_BACKEND_CONTRACT } from '../src/realtime/contract.ts';
import { REALTIME_MAX_SESSION_SECONDS, REALTIME_LIMITS } from '../src/realtime/limits.ts';
import { latestDeployment } from './deploy-lib.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';

/** Compatibility declarations are reviewed on changes; migrations stay expand-only. */
export const RELEASE_COMPATIBILITY = { backend: REALTIME_BACKEND_CONTRACT, schema: 1, classes: 1 } as const;
/** Also written into migrations/0008_realtime_releases.sql's promotion trigger; a test pins the two equal. */
export const RELEASE_RETENTION_MS = (REALTIME_MAX_SESSION_SECONDS + 60 + 3600) * 1000 + REALTIME_LIMITS.outboxRetentionMs;
const LEASE_MS = 10 * 60_000;
/** How often a running release renews its lease, well inside {@link LEASE_MS}. */
const LEASE_HEARTBEAT_MS = 60_000;
/**
 * How old a never-promoted candidate must be before cleanup deletes it. No
 * session can reach one, since discovery only returns the active release; the
 * margin is for a candidate whose own release is still verifying it.
 */
const CANDIDATE_GRACE_MS = 60 * 60_000;
/** The lease lapsed or another release took it; distinct from a failed query. */
class LeaseLost extends Error {}
type Config = Record<string, unknown> & { name: string; vars?: Record<string, unknown>; account_id?: string };
export interface RunResult { stdout?: string; stderr?: string; status?: number | null }
export interface ReleaseDriver {
  /** `signal` stops the command: the main Worker's upload once the lease is lost. */
  run(args: string[], options?: { capture?: boolean; companion?: boolean; signal?: AbortSignal }): Promise<RunResult>;
  /** Return only the named Worker's settings, or null for API codes 10007/10090. */
  settings(name: string): Promise<{ bindings?: { name: string; text?: string; type?: string }[] } | null>;
  health(url: string): Promise<Record<string, unknown>>;
  log(message: string): void;
  sleep?: (ms: number) => Promise<void>;
  /** Overrides {@link LEASE_HEARTBEAT_MS}; tests only. */
  heartbeatMs?: number;
}
export interface ReleaseInput {
  config: Config;
  configPath: string;
  realtimeConfig: Config;
  realtimeBundle: string;
  mainBundle: string;
  version: string;
  /** Where the gateway answers; unset only when no URL reaches it, and then its health goes unchecked. */
  gatewayOrigin: string | undefined;
  /** The account's workers.dev subdomain, which seamless releases are served on. */
  subdomain: string | undefined;
  /** Realtime sessions get a Worker of their own per release; otherwise the gateway serves them. */
  seamless: boolean;
  /** Caller handles first-install provisioning and secret setup under this lease. */
  prepare?: () => Promise<void>;
  /** Deploys the main Worker; stops when `signal` aborts, once the lease is lost. */
  deployMain: (buildId: string, signal: AbortSignal) => Promise<void>;
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
export async function seamlessRelease(input: ReleaseInput, driver: ReleaseDriver): Promise<{ buildId: string; realtimeId: string | null; previousDeployment?: string }> {
  const { config } = input;
  const query = async (sql: string) => rows(await driver.run(['d1', 'execute', 'DB', '--remote', '--json', '--config', input.configPath, '--command', sql], { capture: true }));
  // Build/read artifacts before acquiring the lease or changing remote state.
  if (!config.vars?.DEPLOYMENT_ID) throw new Error('Deployment identity is required');
  if (input.action !== 'cleanup' && input.action !== 'rollback') { await access(input.mainBundle); if (input.seamless) await access(input.realtimeBundle); }
  const owner = randomUUID();
  // Bootstrap only the advisory lease, before ordinary migrations or secret mutations.
  await query(`CREATE TABLE IF NOT EXISTS gateway_release_state (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), active_realtime_id TEXT, deployment_owner TEXT, deployment_expires_at INTEGER, promotion_at INTEGER, current_deployment_id TEXT); INSERT OR IGNORE INTO gateway_release_state(singleton) VALUES(1)`);
  const acquire = async () => (await query(`UPDATE gateway_release_state SET deployment_owner=${quote(owner)}, deployment_expires_at=${Date.now() + LEASE_MS} WHERE singleton=1 AND (deployment_owner IS NULL OR deployment_expires_at <= ${Date.now()}) RETURNING deployment_owner`))[0]?.deployment_owner === owner;
  if (!(await acquire())) throw new Error('Another deployment holds the installation lease; retry after it finishes or its 10 minute lease expires');
  const lease = async () => {
    const renewal = await query(`UPDATE gateway_release_state SET deployment_expires_at=${Date.now() + LEASE_MS} WHERE singleton=1 AND deployment_owner=${quote(owner)} AND deployment_expires_at>${Date.now()} RETURNING deployment_owner`);
    if (renewal[0]?.deployment_owner !== owner) throw new LeaseLost('Deployment lease expired or changed; promotion stopped');
  };
  const leaseLost = new AbortController();
  // Renewed in the background while this release runs, so a slow Worker
  // upload cannot outlive the lease and land after another release has taken
  // it over. A lapsed lease is never revived: the next lease() check stops
  // this release instead.
  let renewing = false;
  const heartbeat = setInterval(() => {
    if (renewing) return;
    renewing = true;
    lease().catch(error => { if (error instanceof LeaseLost) leaseLost.abort(error); }).finally(() => { renewing = false; });
  }, driver.heartbeatMs ?? LEASE_HEARTBEAT_MS);
  heartbeat.unref?.();
  const verifyMain = async (build: string, failure: string) => {
    if (input.gatewayOrigin) await verifyHealth(driver, input.gatewayOrigin, { buildId: build, ready: true }, failure);
    else driver.log('No URL reaches the gateway, so its health check is skipped.');
  };
  /** The main Worker version serving all traffic, and the build it reports. */
  const liveMain = async () => {
    const deployed = latestDeployment((await driver.run(['deployments', 'list', '--json', '--config', input.configPath], { capture: true })).stdout ?? '[]');
    const current = deployed?.versions;
    if (current?.length !== 1 || current[0]?.percentage !== 100) return null;
    const version = JSON.parse((await driver.run(['versions', 'view', current[0].version_id, '--json', '--config', input.configPath], { capture: true })).stdout ?? '{}') as { resources?: { bindings?: { name: string; type: string; text?: string }[] } };
    const binding = version.resources?.bindings?.find(binding => binding.name === 'GATEWAY_BUILD_ID' && binding.type === 'plain_text');
    return { versionId: current[0].version_id, buildId: binding?.text };
  };
  /**
   * A main Worker upload the lease no longer covered may have landed after a
   * newer release finished, replacing the gateway it promoted. Cloudflare has
   * no conditional deploy to prevent that, so it is undone instead: under the
   * lease again, the recorded release's main version is restored when this
   * build turns out to be the one serving.
   */
  const restoreAfterLostLease = async (lostBuild: string): Promise<never> => {
    const lost = `The deployment lease was lost while main build ${lostBuild} was deploying`;
    if (!(await acquire())) throw new Error(`${lost}, and another deployment holds it now. Once that one finishes, check that the gateway reports its build in /v1/healthz, and re-run this deployment if it does not.`);
    const recorded = (await query('SELECT d.id, d.main_version_id FROM gateway_deployment d JOIN gateway_release_state s ON s.current_deployment_id=d.id WHERE s.singleton=1'))[0];
    const live = await liveMain();
    if (live?.buildId !== lostBuild) throw new Error(`${lost}; it is not serving. Re-run the deployment.`);
    if (!recorded) throw new Error(`${lost}; it is serving, and no earlier release is recorded to restore. Re-run the deployment.`);
    await driver.run(['rollback', String(recorded.main_version_id), '--config', input.configPath, '--message', 'Restore the recorded release after a lost deployment lease', '--yes']);
    await verifyMain(String(recorded.id), 'Restored main build was not observed');
    throw new Error(`${lost}; it replaced the recorded release, so the gateway was restored to build ${recorded.id}. Re-run the deployment.`);
  };
  let previousDeployment: string | undefined;
  try {
    const promote = async (id: string | null, promotedBuild: string) => {
      const changed = await query(`UPDATE gateway_release_state SET active_realtime_id=${id === null ? 'NULL' : quote(id)}, current_deployment_id=${quote(promotedBuild)}, promotion_at=${Date.now()} WHERE singleton=1 AND deployment_owner=${quote(owner)} AND deployment_expires_at>${Date.now()} RETURNING active_realtime_id`);
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
      // Retired releases once their sessions' recovery horizon has passed, and
      // candidates that were never promoted, which no session ever reached.
      const retired = await query(`SELECT id, worker_name FROM realtime_release WHERE id != COALESCE((SELECT active_realtime_id FROM gateway_release_state WHERE singleton=1),'')
        AND ((retired_at IS NOT NULL AND delete_after<=${Date.now()}) OR (retired_at IS NULL AND created_at<=${Date.now() - CANDIDATE_GRACE_MS}))`);
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
      const target = (await query(`SELECT d.* FROM gateway_deployment d WHERE d.id=${quote(input.rollbackId ?? '')}`))[0];
      if (!currentDeployment || !target || target.backend_contract !== RELEASE_COMPATIBILITY.backend || target.schema_generation !== RELEASE_COMPATIBILITY.schema || target.class_generation !== RELEASE_COMPATIBILITY.classes || currentDeployment && (target.backend_contract !== currentDeployment.backend_contract || target.schema_generation !== currentDeployment.schema_generation || target.class_generation !== currentDeployment.class_generation)) throw new Error('Rollback target is missing or incompatible with the current backend/schema/class lifecycle; no database rollback is performed');
      // A deployment the gateway served sessions for has no release Worker to check.
      const targetRealtime = typeof target.realtime_id === 'string' ? target.realtime_id : null;
      if (targetRealtime !== null) {
        const settings = await driver.settings(prefix + targetRealtime.slice(0, 24));
        if (settings?.bindings?.find(binding => binding.name === 'REALTIME_RELEASE_ID')?.text !== targetRealtime) throw new Error('Retained realtime Worker is unavailable; rollback stopped');
      }
      await lease();
      await driver.run(['rollback', String(target.main_version_id), '--config', input.configPath, '--message', 'Explicit compatible release rollback', '--yes']);
      await verifyMain(String(target.id), 'Expected restored main build and ready database/bindings were not observed');
      await lease();
      await promote(targetRealtime, String(target.id));
      driver.log(`Rollback complete: ${target.id}. Database unchanged.`);
      return { buildId: String(target.id), realtimeId: targetRealtime, ...(previousDeployment ? { previousDeployment } : {}) };
    }
    /** Creates or reuses this release's own realtime Worker, verified but not yet promoted. */
    const releaseRealtime = async (): Promise<string> => {
      if (!input.subdomain || !input.gatewayOrigin) throw new Error('Seamless realtime releases need your account\'s workers.dev subdomain enabled');
      const realtimeId = releaseFingerprint(await readFile(input.realtimeBundle), input.realtimeConfig, input.gatewayOrigin, config.name);
      const name = prefix + realtimeId.slice(0, 24);
      const realtimeUrl = `https://${name}.${input.subdomain}.workers.dev`;
      const existing = await driver.settings(name);
      if (existing && existing.bindings?.find(binding => binding.name === 'REALTIME_RELEASE_ID')?.text !== realtimeId) throw new Error('Realtime Worker name collision; retained Worker will not be changed');
      // Recorded before the companion exists, so a deploy that stops partway
      // still leaves a row: cleanup is row-driven, and an unrecorded Worker would
      // never be deleted. Until promoted it is a candidate, cleaned after its grace.
      // A reused release keeps its row, with the URL this account serves it on now.
      await query(`INSERT INTO realtime_release(id,worker_name,url,backend_contract,created_at) VALUES(${quote(realtimeId)},${quote(name)},${quote(realtimeUrl.replace('https:', 'wss:'))},${RELEASE_COMPATIBILITY.backend},${Date.now()}) ON CONFLICT(id) DO UPDATE SET url=excluded.url`);
      if (existing) {
        driver.log(`Reusing immutable realtime release ${realtimeId}`);
      } else {
        const realtimeConfig: Config = { ...input.realtimeConfig, name, ...(config.account_id ? { account_id: config.account_id } : {}), main: resolve(input.realtimeBundle), no_bundle: true,
          vars: { REALTIME_RELEASE_ID: realtimeId, GATEWAY_ORIGIN: input.gatewayOrigin }, services: [{ binding: 'BACKEND', service: config.name, entrypoint: 'RealtimeBackend' }] };
        const path = join(dirname(input.configPath), `realtime-${realtimeId}.json`);
        await writeFile(path, JSON.stringify(realtimeConfig), { mode: 0o600 });
        await lease();
        await driver.run(['deploy', '--config', path], { companion: true });
      }
      await lease();
      await verifyHealth(driver, realtimeUrl, { releaseId: realtimeId }, 'Realtime candidate health identity mismatch; active release unchanged');
      return realtimeId;
    };
    const buildId = randomUUID();
    await lease();
    try {
      await input.deployMain(buildId, leaseLost.signal);
      await lease();
    } catch (error) {
      if (leaseLost.signal.aborted || error instanceof LeaseLost) await restoreAfterLostLease(buildId);
      throw error;
    }
    await verifyMain(buildId, 'Expected new main build and ready database/bindings were not observed');
    let realtimeId: string | null = null;
    try {
      // Without seamless releases the gateway serves sessions itself, and
      // promoting no release Worker retires one an earlier seamless release
      // left: the sessions open on it finish there.
      if (input.seamless) realtimeId = await releaseRealtime();
      const live = await liveMain();
      if (!live) throw new Error('Expected a single 100% main deployment; active realtime release unchanged');
      if (live.buildId !== buildId) throw new Error('Current Cloudflare version does not match verified main build; promotion stopped');
      await lease();
      await query(`INSERT OR REPLACE INTO gateway_deployment(id,main_version_id,release_version,realtime_id,backend_contract,schema_generation,class_generation,created_at) VALUES(${quote(buildId)},${quote(live.versionId)},${quote(input.version)},${realtimeId === null ? 'NULL' : quote(realtimeId)},${RELEASE_COMPATIBILITY.backend},${RELEASE_COMPATIBILITY.schema},${RELEASE_COMPATIBILITY.classes},${Date.now()})`);
      await promote(realtimeId, buildId);
    } catch (error) {
      // The new gateway serves either way: with seamless releases, sessions
      // stay on the release Worker it already had, which speaks the same
      // backend contract. A lost lease is another release's to finish, and
      // says so itself.
      if (!(error instanceof LeaseLost)) driver.log(`Main build ${buildId} is serving${input.seamless ? '; realtime sessions stay on the active release' : ''}. Re-run the deployment to record the release.`);
      throw error;
    }
    driver.log(`Promoted 100%: main ${buildId}; realtime ${realtimeId ?? 'served by the gateway'}. Rollback target: ${previousDeployment ?? 'none (first install)'}`);
    try { await cleanup(); } catch { driver.log('Deployment promoted successfully; retired release cleanup is pending. Run deployment cleanup after fixing Cloudflare access.'); }
    return { buildId, realtimeId, ...(previousDeployment ? { previousDeployment } : {}) };
  } finally {
    clearInterval(heartbeat);
    // Never in place of the outcome above: a lease left behind lapses by itself.
    try { await query(`UPDATE gateway_release_state SET deployment_owner=NULL, deployment_expires_at=NULL WHERE singleton=1 AND deployment_owner=${quote(owner)}`); }
    catch { driver.log('Could not release the deployment lease; it lapses within 10 minutes, after which the next deployment can start.'); }
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
