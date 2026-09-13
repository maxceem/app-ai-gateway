import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('../scripts/publish-swift-package.sh', import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'swift-publish-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const remote = join(root, 'mirror.git');
  mkdirSync(source);
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
  const git = (...args) => execFileSync('git', args, { cwd: source, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  git('init', '--bare', remote);
  mkdirSync(join(source, 'app-ai-gateway-swift'));
  function commit(version, content = 'package') {
    writeFileSync(join(source, 'app-ai-gateway-swift/VERSION'), version + '\n');
    writeFileSync(join(source, 'app-ai-gateway-swift/Package.swift'), content);
    writeFileSync(join(source, 'private-to-monorepo.txt'), 'not distributed');
    git('add', '.');
    git('commit', '-m', `Package ${version}`);
    return git('rev-parse', 'HEAD');
  }
  const publish = () => spawnSync('bash', [script, remote], { cwd: source, env, encoding: 'utf8' });
  const ref = (name) => git('--git-dir', remote, 'rev-parse', name);
  return { git, commit, publish, ref, remote };
}

function succeeds(result) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

test('initial publication, retry, main sync, and version bump preserve releases', (t) => {
  const f = fixture(t);
  f.commit('1.0.0');
  succeeds(f.publish());
  const first = f.ref('refs/tags/1.0.0');
  assert.equal(f.ref('main'), first);
  assert.equal(f.git('--git-dir', f.remote, 'ls-tree', '--name-only', 'main'), 'Package.swift\nVERSION');
  succeeds(f.publish());
  assert.equal(f.ref('refs/tags/1.0.0'), first);
  f.commit('1.0.0', 'next change');
  succeeds(f.publish());
  assert.notEqual(f.ref('main'), first);
  assert.equal(f.ref('refs/tags/1.0.0'), first);
  f.commit('1.1.0', 'next release');
  succeeds(f.publish());
  assert.equal(f.ref('main'), f.ref('refs/tags/1.1.0'));
  assert.equal(f.ref('refs/tags/1.0.0'), first);
});

test('stale runs cannot rewind main or create a partial release', (t) => {
  const f = fixture(t);
  f.commit('1.0.0');
  succeeds(f.publish());
  const older = f.commit('1.1.0', 'older');
  f.commit('1.2.0', 'newer');
  succeeds(f.publish());
  const newest = f.ref('main');
  f.git('checkout', older);
  assert.notEqual(f.publish().status, 0);
  assert.equal(f.ref('main'), newest);
  assert.equal(f.git('ls-remote', f.remote, 'refs/tags/1.1.0'), '');
});

test('conflicting release tags are rejected without changing the mirror', (t) => {
  const f = fixture(t);
  f.commit('1.0.0');
  succeeds(f.publish());
  const first = f.ref('main');
  f.git('checkout', '--orphan', 'unrelated');
  f.commit('1.0.0', 'different history');
  const result = f.publish();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing to overwrite/);
  assert.equal(f.ref('main'), first);
  assert.equal(f.ref('refs/tags/1.0.0'), first);
});

test('invalid versions fail before publishing', (t) => {
  const f = fixture(t);
  f.commit('01.0.0');
  const result = f.publish();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /stable semantic version/);
  assert.equal(f.git('ls-remote', f.remote), '');
});
