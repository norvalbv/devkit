import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { testSpawnSync as spawnSync } from './_helpers.mts';

const reshipPath = fileURLToPath(new URL('../lib/ship/reship.sh', import.meta.url));
const originBasePath = fileURLToPath(new URL('../lib/ship/origin-base.sh', import.meta.url));
const REWRITE_FN_RE = /^rewrite_remote\(\) \{[\s\S]*?^\}/m;
// A detached auto-gc/maintenance inherits the supervisor's ownership token and is reaped as a leaked
// tree, turning a finished fetch into 124 (sc-3761). Every supervised remote git call carries this.
const NO_AUTO_GC = '-c gc.auto=0 -c maintenance.auto=false';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A ship dir holding only the supervisor extension a given tree ships, plus a stub that echoes argv. */
function shipTree(ext: 'mts' | 'mjs') {
  const dir = mkdtempSync(join(tmpdir(), 'ship-supervisor-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'review/process'), { recursive: true });
  writeFileSync(
    join(dir, `review/process/gate-supervisor.${ext}`),
    "console.log('SUPERVISOR ' + process.argv.slice(2).join(' '));\n",
  );
  return dir;
}

/** bounded_remote_git finds the supervisor beside its own file, so run a copy placed in the tree. */
function runBoundedRemoteGit(scriptDir: string) {
  const lib = join(scriptDir, 'origin-base.sh');
  copyFileSync(originBasePath, lib);
  return spawnSync(
    '/bin/bash',
    ['-c', `set -eu; . ${JSON.stringify(lib)}; bounded_remote_git ls-remote`],
    { encoding: 'utf8' },
  );
}

// The published package carries only the compiled `.mjs` next to the ship scripts; the `.mts`
// exists in a source checkout alone. origin-base.sh is sourced from both trees.
describe('origin-base.sh — bounded_remote_git resolves the packaged supervisor', () => {
  for (const ext of ['mts', 'mjs'] as const) {
    it(`runs the .${ext} supervisor when that is the one on disk`, () => {
      const r = runBoundedRemoteGit(shipTree(ext));
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toBe(`SUPERVISOR 60 -- git ${NO_AUTO_GC} ls-remote\n`);
    });
  }
});

function runRewriteRemote(args: string) {
  const fn = REWRITE_FN_RE.exec(readFileSync(reshipPath, 'utf8'))?.[0];
  if (!fn) throw new Error('rewrite_remote not found in reship.sh');
  const supervisor = join(shipTree('mts'), 'review/process/gate-supervisor.mts');
  return spawnSync(
    '/bin/bash',
    [
      '-c',
      `set -euo pipefail; REWRITE_REMOTE_SUPERVISOR=${JSON.stringify(supervisor)}; ${fn}; ${args}`,
    ],
    { encoding: 'utf8' },
  );
}

describe('reship.sh — rewrite_remote never lets a remote git call start auto-gc (sc-3761)', () => {
  it.each([
    ['a pin fetch', 'rewrite_remote git fetch -q origin', `git ${NO_AUTO_GC} fetch -q origin`],
    // The rewrite push names its worktree with -C; the config must still precede the subcommand.
    [
      'an env-prefixed -C push',
      'X=1 rewrite_remote git -C /wt push --no-verify origin',
      `git ${NO_AUTO_GC} -C /wt push --no-verify origin`,
    ],
  ])('suppresses auto-gc on %s', (_name, call, expected) => {
    const r = runRewriteRemote(call);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(`SUPERVISOR 60 -- ${expected}\n`);
  });

  it('passes a gh call through untouched — git config flags would be an unknown gh flag', () => {
    const r = runRewriteRemote('rewrite_remote gh pr view feat/x --repo acme/app');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('SUPERVISOR 60 -- gh pr view feat/x --repo acme/app\n');
  });
});
