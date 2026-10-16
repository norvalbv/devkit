import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { testSpawnSync as spawnSync } from './_helpers.mts';
import {
  localBranchExists,
  publishEnvFor,
  scriptPath,
  seedShipRepoLocalRemote,
} from './_ship-branch-fixture.mts';

const reshipPath = fileURLToPath(new URL('../lib/ship/reship.sh', import.meta.url));
const REWRITE_FN_RE = /^rewrite_remote\(\) \{[\s\S]*?^\}/m;
// A detached auto-gc/maintenance inherits the supervisor's ownership token and is reaped as a leaked
// tree, turning a finished fetch into 124 (sc-3761). Every supervised remote git call carries this.
const NO_AUTO_GC = '-c gc.auto=0 -c maintenance.auto=false';

// The published package carries only the compiled `.mjs` next to the ship scripts; the `.mts`
// exists in a source checkout alone. ship-branch.sh runs from both trees.
const FN_RE = /^bounded_remote_git\(\) \{[\s\S]*?^\}/m;

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

function runBoundedRemoteGit(scriptDir: string, env: NodeJS.ProcessEnv = process.env) {
  const fn = FN_RE.exec(readFileSync(scriptPath, 'utf8'))?.[0];
  if (!fn) throw new Error('bounded_remote_git not found in ship-branch.sh');
  return spawnSync(
    '/bin/bash',
    ['-c', `set -eu; SCRIPT_DIR=${JSON.stringify(scriptDir)}; ${fn}; bounded_remote_git ls-remote`],
    { encoding: 'utf8', env },
  );
}

describe('ship-branch.sh — bounded_remote_git resolves the packaged supervisor', () => {
  for (const ext of ['mts', 'mjs'] as const) {
    it(`runs the .${ext} supervisor when that is the one on disk`, () => {
      const r = runBoundedRemoteGit(shipTree(ext));
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toBe(`SUPERVISOR 60 -- git ${NO_AUTO_GC} ls-remote\n`);
    });
  }
});

// Attempt N exits STUB_STATUSES[N] after printing STUB_OUTPUTS[N]; COUNT_FILE gets one line per run.
const SEQUENCED_SUPERVISOR = `import { appendFileSync, readFileSync } from 'node:fs';
appendFileSync(process.env.COUNT_FILE, 'run\\n');
const n = readFileSync(process.env.COUNT_FILE, 'utf8').split('\\n').length - 2;
const out = process.env.STUB_OUTPUTS.split(',')[n] ?? '';
if (out) console.log(out);
process.exit(Number(process.env.STUB_STATUSES.split(',')[n]));
`;

function runSequenced(statuses: string, outputs: string) {
  const scriptDir = shipTree('mts');
  writeFileSync(join(scriptDir, 'review/process/gate-supervisor.mts'), SEQUENCED_SUPERVISOR);
  const countFile = join(scriptDir, 'count');
  const r = runBoundedRemoteGit(scriptDir, {
    ...process.env,
    COUNT_FILE: countFile,
    STUB_STATUSES: statuses,
    STUB_OUTPUTS: outputs,
  });
  return { ...r, runs: readFileSync(countFile, 'utf8').split('\n').length - 1 };
}

describe('ship-branch.sh — bounded_remote_git retries only a silent timeout', () => {
  it('re-runs a 124 that printed nothing and reports the second answer once', () => {
    const r = runSequenced('124,0', ',abc refs/heads/main');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('abc refs/heads/main\n');
    expect(r.runs).toBe(2);
  });

  it('still returns 124 when the retry stalls too', () => {
    const r = runSequenced('124,124', ',');
    expect(r.status).toBe(124);
    expect(r.stdout).toBe('');
    expect(r.runs).toBe(2);
  });

  // Output means git answered (a reaped straggler); a re-run would append a second advertisement.
  it('never re-runs a 124 that already printed output', () => {
    const r = runSequenced('124,0', 'abc refs/heads/main,abc refs/heads/main');
    expect(r.status).toBe(124);
    expect(r.stdout).toBe('abc refs/heads/main\n');
    expect(r.runs).toBe(1);
  });

  it.each(['2', '128'])('fails exit %s at once — only a timeout earns a retry', (status) => {
    const r = runSequenced(`${status},0`, ',');
    expect(r.status).toBe(Number(status));
    expect(r.runs).toBe(1);
  });
});

describe('ship-branch.sh — a remote-branch check that stalls past its retry', () => {
  it('refuses naming the bound and the knob that raises it, before creating the branch', () => {
    const { dir, env, git } = seedShipRepoLocalRemote();
    const bin = mkdtempSync(join(tmpdir(), 'ship-stall-'));
    dirs.push(bin);
    const realGit = spawnSync('/bin/sh', ['-c', 'command -v git'], {
      encoding: 'utf8',
    }).stdout.trim();
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/bash\ncase " $* " in *" ls-remote "*" refs/heads/feat/stall "*) sleep 30 ;; esac\nexec '${realGit}' "$@"\n`,
    );
    chmodSync(join(bin, 'git'), 0o755);
    const { publishEnv } = publishEnvFor(dir, env);
    writeFileSync(join(dir, 'note.txt'), 'hi\n');
    const started = Date.now();
    const r = spawnSync('/bin/bash', [scriptPath, 'feat/stall', 'ship it', '--', 'note.txt'], {
      cwd: dir,
      input: 'pr body\n',
      encoding: 'utf8',
      env: {
        ...publishEnv,
        DEVKIT_REMOTE_TIMEOUT_SECONDS: '0.1',
        PATH: `${bin}:${publishEnv.PATH}`,
      },
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      'could not verify remote branch (ls-remote exit 124: no clean finish within the 0.1s bound) — machine load or network; re-run ship, or raise DEVKIT_REMOTE_TIMEOUT_SECONDS',
    );
    expect(localBranchExists(git, 'feat/stall')).toBe(false);
  });
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
