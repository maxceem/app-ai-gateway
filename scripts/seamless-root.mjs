import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Cloudflare, resultOf } from '../cli/src/cloudflare.ts';
import { CliError } from '../cli/src/common.ts';
import { seamlessRelease, companionEnvironment } from './seamless.ts';
import { projectRoot, wranglerBin, readJsonc } from './wrangler-config.mjs';

/** Checkout and one-click adapter. Primary keeps Cloudflare's CI identity; companion does not. */
export async function deployCheckout({ config, configPath, deploymentId, prepare, bootstrap, action = 'deploy', rollbackId }) {
  const run = async (args, options = {}) => {
    const result = spawnSync(wranglerBin, args, { cwd: projectRoot, encoding: 'utf8', env: options.companion ? companionEnvironment(process.env) : process.env,
      stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.status !== 0) throw new Error(`Wrangler ${args[0]} failed: ${result.stderr ?? ''}`);
    if (!options.capture) { process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? ''); }
    return result;
  };
  // Both artifacts and their configs must build before any remote mutation.
  const root = join(projectRoot, '.wrangler', 'releases');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'run-'));
  try {
  const preflight = { ...config, main: resolve(projectRoot, config.main), ...(config.assets ? { assets: { ...config.assets, directory: resolve(projectRoot, config.assets.directory) } } : {}),
    d1_databases: config.d1_databases.map(db => ({ ...db, migrations_dir: resolve(projectRoot, db.migrations_dir ?? 'migrations') })) };
  const sourcePath = join(directory, 'source.json');
  await writeFile(sourcePath, JSON.stringify(preflight));
  await run(['deploy', '--dry-run', '--config', sourcePath, '--outdir', join(directory, 'main')], { capture: true });
  await run(['deploy', '--dry-run', '--config', resolve(projectRoot, 'wrangler.realtime.jsonc'), '--outdir', join(directory, 'realtime')], { capture: true, companion: true });
  const cf = new Cloudflare(async (args) => (await run(args, { capture: true })).stdout ?? '');
  await cf.authenticate({ 'no-input': true });
  const accountId = config.account_id ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? await cf.account({ 'no-input': true });
  const subdomain = (await resultOf(cf, `/accounts/${accountId}/workers/subdomain`)).subdomain;
  if (!subdomain) throw new Error('Enable your Cloudflare workers.dev subdomain before deploying');
  const name = process.env.WRANGLER_CI_OVERRIDE_NAME || config.name;
  const primary = { ...config, name, account_id: accountId, vars: { ...config.vars, DEPLOYMENT_ID: deploymentId } };
  // Absolute local paths because the deployment config lives in the ignored artifact directory.
  primary.main = join(directory, 'main', 'index.js');
  primary.no_bundle = true;
  if (primary.assets) primary.assets = { ...primary.assets, directory: resolve(projectRoot, primary.assets.directory) };
  primary.d1_databases = config.d1_databases.map(db => ({ ...db, migrations_dir: resolve(projectRoot, db.migrations_dir ?? 'migrations') }));
  const path = join(directory, 'primary.json');
  await writeFile(path, JSON.stringify(primary), { mode: 0o600 });
  const origin = config.vars?.PUBLIC_API_URL || config.vars?.CLI_CONSOLE_ORIGIN || `https://${name}.${subdomain}.workers.dev`;
  const settings = async worker => {
    try { return await resultOf(cf, `/accounts/${accountId}/workers/scripts/${worker}/settings`); }
    catch (error) {
      if (error instanceof CliError && /\[code: (?:10007|10090)\]/u.test(error.message)) return null;
      throw error;
    }
  };
  const packaged = JSON.parse(await readFile(join(projectRoot, 'cli/package.json'), 'utf8'));
  const existing = await settings(name);
  if (action === 'deploy' && existing) {
    if (!existing.bindings?.some(binding => binding.name === 'DEPLOYMENT_ID' && binding.type === 'plain_text' && binding.text)) throw new Error('Cannot verify the version of an existing gateway without DEPLOYMENT_ID. Establish a stable plain-text DEPLOYMENT_ID on that reviewed supported deployment using its existing deployment method, then retry. Never change an established identity.');
    const response = await fetch(new URL('/v1/cli/capabilities', origin), { signal: AbortSignal.timeout(10_000), redirect: 'error' });
    if (!response.ok) throw new Error('Cannot verify existing gateway release before mutation');
    const capabilities = await response.json();
    if (capabilities.deployment?.id !== deploymentId) throw new Error('Existing gateway identity differs; no deployment started');
    if (![packaged.version, ...packaged.upgradeFrom].includes(capabilities.serverVersion)) throw new Error('This gateway release cannot upgrade the deployed database; use a supported migration release');
  }
  // Resource auto-provisioning is needed only before an installation has a D1.
  // A failed first bootstrap is retried with the same deployment identity.
  await bootstrap(path);
  return await seamlessRelease({ config: primary, configPath: path, realtimeConfig: readJsonc(join(projectRoot, 'wrangler.realtime.jsonc')),
    realtimeBundle: join(directory, 'realtime', 'worker.js'), mainBundle: join(directory, 'main', 'index.js'),
    version: JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')).version,
    gatewayOrigin: origin, subdomain, prepare: () => prepare(path, { initial: !existing }), action, rollbackId,
    deployMain: async buildId => { primary.vars.GATEWAY_BUILD_ID = buildId; await writeFile(path, JSON.stringify(primary), { mode: 0o600 }); await run(['deploy', '--config', path]); },
  }, { run, settings, log: console.log, health: async base => {
    const response = await fetch(new URL('/v1/healthz', base), { signal: AbortSignal.timeout(10_000), redirect: 'error' });
    if (!response.ok) throw new Error(`Health check returned ${response.status}`);
    return response.json();
  } });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
