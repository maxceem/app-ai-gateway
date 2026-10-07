import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { seamlessRelease, type ReleaseInput } from '../../scripts/seamless.ts';
import { CliError } from './common.ts';
import { resultOf, type CloudflareClient, type WorkerSettings } from './cloudflare.ts';
import type { ReleaseArtifact } from './release.ts';
import type { InstallationJournal } from './state.ts';

export async function deployRelease(cf: CloudflareClient, journal: InstallationJournal, artifact: ReleaseArtifact,
  file: { path: string; directory: string; config: Record<string, unknown> }, prepare: () => Promise<void>,
  deployMain: (buildId: string) => Promise<void>, action: ReleaseInput['action'] = 'deploy', rollbackId?: string) {
  const subdomain = (await resultOf<{ subdomain?: string }>(cf, `/accounts/${journal.accountId}/workers/subdomain`)).subdomain;
  if (!subdomain) throw new Error('Enable your workers.dev subdomain before deploying');
  const realtimeConfig = JSON.parse(await readFile(join(artifact.directory, 'wrangler.realtime.json'), 'utf8')) as ReleaseInput['realtimeConfig'];
  return seamlessRelease({ config: { ...file.config, name: journal.name }, configPath: file.path,
    realtimeConfig, realtimeBundle: join(file.directory, 'release', 'realtime', 'worker.js'), mainBundle: join(file.directory, 'release', 'worker', 'index.js'),
    version: artifact.manifest.version, gatewayOrigin: String((file.config.vars as Record<string, unknown> | undefined)?.PUBLIC_API_URL || (file.config.vars as Record<string, unknown> | undefined)?.CLI_CONSOLE_ORIGIN || journal.url || `https://${journal.name}.${subdomain}.workers.dev`), subdomain, prepare, deployMain, action, rollbackId,
  }, {
    run: async (args, options) => ({ stdout: await cf.run(args, { cwd: file.directory, companion: options?.companion }) }),
    settings: async name => {
      try { return await resultOf<WorkerSettings>(cf, `/accounts/${journal.accountId}/workers/scripts/${name}/settings`); }
      catch (error) { if (error instanceof CliError && /\[code: (?:10007|10090)\]/u.test(error.message)) return null; throw error; }
    },
    health: async base => {
      const response = await fetch(new URL('/v1/healthz', base), { signal: AbortSignal.timeout(10_000), redirect: 'error' });
      if (!response.ok) throw new Error(`Health check returned ${response.status}`);
      return response.json() as Promise<Record<string, unknown>>;
    },
    log: message => process.stderr.write(message + '\n'),
  });
}
export async function setBuild(file: { path: string; config: Record<string, unknown> }, buildId: string) {
  const vars = file.config.vars as Record<string, unknown>;
  vars.GATEWAY_BUILD_ID = buildId;
  await writeFile(file.path, JSON.stringify(file.config, null, 2), { mode: 0o600 });
}
