/** sc-1794: execute the ASSEMBLED overlay commit-msg hook under a real `sh -e` and pin the planner:
 *  a selected message judge is never omitted, whatever the repo's own hook text says. */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCommitMsgHook } from '../lib/husky/commit-msg-block.mts';
import { BIN_DIRS } from '../lib/husky/gate-policy/block-helpers.mts';
import {
  buildOverlayCommitMsgHook,
  describeOverlayCommitMsg,
  judgesAlsoInRepoHook,
  planOverlayCommitMsg,
  readHook,
  syncOverlayCommitMsg,
} from '../lib/husky/overlay/commit-msg.mts';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

// Hooks run under whatever /bin/sh the OS ships — dash on Debian/Ubuntu, bash on macOS.
const hasDash = existsSync('/bin/dash');

interface RunOpts {
  guards?: string[];
  pkgRel?: string;
  scriptDir?: string;
  chain?: string | null; // body of the repo's own commit-msg; null = none
  compRc?: number | null; // null = guard-review absent from devkit's bin dir
  sentryRc?: number | null;
  devkit?: boolean; // false = no global devkit (its guard-deterministic) on PATH
  shell?: string;
  dirPrefix?: string;
  env?: Record<string, string>;
}

function runOverlayCommitMsg({
  guards = ['review'],
  pkgRel = '',
  scriptDir = '.husky',
  chain = null,
  compRc = 0,
  sentryRc = 0,
  devkit = true,
  shell = 'sh',
  dirPrefix = 'dk-ov-cmsg-',
  env = {},
}: RunOpts = {}) {
  const home = mkdtempSync(join(tmpdir(), dirPrefix));
  homes.push(home);
  execFileSync('git', ['init', '-q'], { cwd: home });
  const commitState = join(home, '.git', 'devkit-commit-attempt');
  writeFileSync(commitState, `commit-run-test\n${'0'.repeat(40)}\n`);
  if (pkgRel) mkdirSync(join(home, pkgRel), { recursive: true });
  // Global (standalone) bins — overlay is package-less, so the hook must use these.
  const bin = join(home, '.bun', 'bin');
  mkdirSync(bin, { recursive: true });
  const stub = (name: string, rc: number | null) => {
    if (rc === null) return;
    const p = join(bin, name);
    const log = `${name} $* cwd=$PWD idx=\${GIT_INDEX_FILE-unset} dkidx=\${DEVKIT_COMMIT_INDEX_FILE-unset}`;
    writeFileSync(p, `#!/bin/sh\necho "${log}" >> "$HOME/calls.log"\nexit ${rc}\n`);
    chmodSync(p, 0o755);
  };
  stub('guard-deterministic', devkit ? 0 : null);
  stub('guard-review', compRc);
  stub('guard-sentry', sentryRc);
  const chainRel = `${scriptDir}/commit-msg`;
  if (chain !== null) {
    mkdirSync(join(home, scriptDir), { recursive: true });
    writeFileSync(join(home, chainRel), chain);
    chmodSync(join(home, chainRel), 0o755);
  }
  const hookDir = join(home, '.devkit', 'hooks');
  mkdirSync(hookDir, { recursive: true });
  const hookPath = join(hookDir, 'commit-msg');
  writeFileSync(hookPath, buildOverlayCommitMsgHook({ guards }, chainRel, pkgRel));
  chmodSync(hookPath, 0o755);
  writeFileSync(join(home, '.git', 'COMMIT_EDITMSG'), 'feat: thing\n');
  const calls = () =>
    existsSync(join(home, 'calls.log')) ? readFileSync(join(home, 'calls.log'), 'utf8') : '';
  try {
    const stdout = execFileSync(shell, ['-e', hookPath, '.git/COMMIT_EDITMSG'], {
      cwd: home,
      env: { ...process.env, HOME: home, PATH: '/usr/bin:/bin', ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000, // native bound: this file runs in the parallel project (leaf-verb scope)
    });
    return { home, status: 0, stdout, calls: calls(), stateExists: existsSync(commitState) };
  } catch (e) {
    // SAFETY: execFileSync only throws its SpawnSyncReturns-shaped error, carrying status + stdout.
    const err = e as { status: number; stdout?: string };
    return {
      home,
      status: err.status,
      stdout: `${err.stdout ?? ''}`,
      calls: calls(),
      stateExists: existsSync(commitState),
    };
  }
}

const CHAIN_LOGS_ARG = '#!/bin/sh\necho "chain $1" >> "$HOME/calls.log"\n[ -f "$1" ] || exit 7\n';

describe('buildOverlayCommitMsgHook — generated shape', () => {
  it('resolves the GLOBAL bin dir, fail-closed, never `bun pm bin` (overlay is package-less)', () => {
    const hook = buildOverlayCommitMsgHook({ guards: ['review', 'sentry'] }, '.husky/commit-msg');
    expect(hook).toContain(BIN_DIRS.global.open);
    expect(hook).not.toContain('bun pm bin');
    expect(hook).not.toContain('command -v guard-review');
    expect(hook).toContain('# devkit:guard-completeness');
    expect(hook).toContain('# devkit:guard-sentry');
  });

  it('a sentry-only selection emits no completeness fragment', () => {
    const hook = buildOverlayCommitMsgHook({ guards: ['sentry'] }, '.husky/commit-msg');
    expect(hook).toContain('# devkit:guard-sentry');
    expect(hook).not.toContain('guard-completeness');
  });
});

describe('overlay commit-msg hook — executed under sh -e', () => {
  it('a confirmed completeness gap (exit 1) blocks and the repo hook never runs', () => {
    const r = runOverlayCommitMsg({ compRc: 1, chain: CHAIN_LOGS_ARG });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('Confirmed completeness gap');
    expect(r.calls).toContain('guard-review completeness --gate .git/COMMIT_EDITMSG');
    expect(r.calls).not.toContain('chain ');
    expect(r.stateExists).toBe(false);
  });

  it('fails CLOSED when devkit is not installed globally — no judge, no repo hook', () => {
    const r = runOverlayCommitMsg({ devkit: false, chain: CHAIN_LOGS_ARG });
    expect(r.status).toBe(1);
    expect(r.calls).toBe('');
  });

  it('a judge missing from an installed devkit blocks instead of skipping it', () => {
    const r = runOverlayCommitMsg({ compRc: null, chain: CHAIN_LOGS_ARG });
    expect(r.status).toBe(1);
    expect(r.calls).not.toContain('chain ');
  });

  it('a judge outage (exit 2) continues to the repo hook', () => {
    const r = runOverlayCommitMsg({ compRc: 2, chain: CHAIN_LOGS_ARG });
    expect(r.status).toBe(0);
    expect(r.calls).toContain('chain .git/COMMIT_EDITMSG');
  });

  it("the repo's own commit-msg still rejects (commitlint) after the judges pass", () => {
    const r = runOverlayCommitMsg({ chain: '#!/bin/sh\necho "subject too long" >&2\nexit 1\n' });
    expect(r.status).toBe(1);
    expect(r.calls).toContain('guard-review completeness');
  });

  it('clears the pre-commit handoff before exec-ing the repo hook (single package)', () => {
    // exec replaces the shell, so the EXIT trap alone would never fire on the chain path.
    const r = runOverlayCommitMsg({ chain: CHAIN_LOGS_ARG });
    expect(r.status).toBe(0);
    expect(r.stateExists).toBe(false);
  });

  it('clears the handoff with no repo hook to chain to', () => {
    const r = runOverlayCommitMsg({ chain: null });
    expect(r.status).toBe(0);
    expect(r.stateExists).toBe(false);
  });

  it('monorepo: judges run from the package dir, the repo hook still gets a readable message path', () => {
    const r = runOverlayCommitMsg({ pkgRel: 'packages/app', chain: CHAIN_LOGS_ARG });
    expect(r.status).toBe(0);
    expect(r.calls).toMatch(
      /guard-review completeness --gate \/.*\.git\/COMMIT_EDITMSG cwd=.*packages\/app/,
    );
    // exit 7 would mean the chained hook could not open the (absolutised) path
    expect(r.calls).toMatch(/chain \/.*\.git\/COMMIT_EDITMSG/);
    expect(r.stateExists).toBe(false);
  });

  it('monorepo: a confirmed gap inside the package subshell still blocks the commit', () => {
    const r = runOverlayCommitMsg({ pkgRel: 'packages/app', compRc: 1, chain: CHAIN_LOGS_ARG });
    expect(r.status).toBe(1);
    expect(r.calls).not.toContain('chain ');
  });

  it('a repo hook deleted after install is skipped, not an error', () => {
    const r = runOverlayCommitMsg({ chain: null, scriptDir: '.husky' });
    expect(r.status).toBe(0);
  });

  it('survives a repo path and a hooks dir containing spaces', () => {
    const r = runOverlayCommitMsg({
      dirPrefix: 'dk ov cmsg ',
      scriptDir: 'my hooks',
      chain: CHAIN_LOGS_ARG,
    });
    expect(r.status).toBe(0);
    expect(r.calls).toContain('chain .git/COMMIT_EDITMSG');
  });

  it("judges run with git's index env scrubbed; the commit index rides DEVKIT_COMMIT_INDEX_FILE", () => {
    const home = mkdtempSync(join(tmpdir(), 'dk-ov-idx-'));
    homes.push(home);
    // A `commit -a`/pathspec commit: git exports an alternate index into every hook it runs.
    const alt = join(home, 'alt-index');
    const chain = '#!/bin/sh\necho "chain idx=${GIT_INDEX_FILE-unset}" >> "$HOME/calls.log"\n';
    const r = runOverlayCommitMsg({ chain, env: { GIT_INDEX_FILE: alt } });
    expect(r.status).toBe(0);
    const judge = r.calls.split('\n').find((l) => l.startsWith('guard-review completeness')) ?? '';
    expect(judge).toContain('idx=unset');
    expect(judge).toMatch(/dkidx=\/.*alt-index/);
    // the repo's own hook still receives git's stock environment
    expect(r.calls).toContain(`chain idx=${alt}`);
  });

  it('a hooks path carrying $(...) is data, never executed', () => {
    const r = runOverlayCommitMsg({ scriptDir: 'h$(touch PWNED)', chain: CHAIN_LOGS_ARG });
    expect(r.status).toBe(0);
    expect(existsSync(join(r.home, 'PWNED'))).toBe(false);
    expect(r.calls).toContain('chain .git/COMMIT_EDITMSG');
  });

  it.runIf(hasDash)('is POSIX: the chain + handoff path works under dash', () => {
    const r = runOverlayCommitMsg({ shell: 'dash', chain: CHAIN_LOGS_ARG });
    expect(r.status).toBe(0);
    expect(r.stateExists).toBe(false);
  });
});

describe('judgesAlsoInRepoHook — advisory double-run detection only', () => {
  it('recognises the calls in a real package-mode (quoted bin path) or standalone hook', () => {
    for (const binDir of ['package', 'global-optional'] as const) {
      const hook = buildCommitMsgHook({ guards: ['review', 'sentry'] }, '', binDir);
      expect(judgesAlsoInRepoHook(hook).sort()).toEqual(['review', 'sentry']);
    }
  });

  it('does not flag a pre-commit review gate or plain commitlint', () => {
    const hook = '#!/bin/sh\nguard-review --gate\nnpx commitlint --edit "$1"\n';
    expect(judgesAlsoInRepoHook(hook)).toEqual([]);
  });
});

describe('planOverlayCommitMsg / syncOverlayCommitMsg', () => {
  const repo = () => {
    const root = mkdtempSync(join(tmpdir(), 'dk-ov-plan-'));
    homes.push(root);
    return root;
  };
  const hookFile = (root: string) => join(root, '.devkit', 'hooks', 'commit-msg');
  const base = (root: string, guards: string[], existing: string[] = []) => ({
    gitRoot: root,
    scriptDir: '.husky',
    scriptsAbs: join(root, '.husky'),
    gitRuns: false,
    existing,
    selection: { guards },
    pkgRel: '',
  });

  it('judges selected, no repo hook → devkit judges', () => {
    const root = repo();
    const plan = planOverlayCommitMsg(base(root, ['review']));
    expect(plan.kind).toBe('judges');
  });

  it('no judges selected, repo hook present → plain pass-through (unchanged behaviour)', () => {
    const root = repo();
    mkdirSync(join(root, '.husky'));
    writeFileSync(join(root, '.husky', 'commit-msg'), '#!/bin/sh\nexit 0\n');
    const plan = planOverlayCommitMsg(base(root, ['size'], ['commit-msg']));
    expect(plan.kind).toBe('passthrough');
    expect(plan.content).not.toContain('guard-review');
  });

  // Hook TEXT cannot prove execution: sentinels, comments, echoed strings and even a real call must
  // never make devkit omit a selected judge (the reviewer-found class — a silent gate bypass).
  it.each([
    [
      'a sentinel comment',
      '# >>> devkit-guards >>>\n# devkit:guard-completeness\n# devkit:guard-sentry',
    ],
    ['a commented-out call', '# guard-review completeness --gate "$1"\n#guard-sentry --gate "$1"'],
    [
      'an echoed string',
      'echo "run guard-review completeness --gate later; guard-sentry --gate too"',
    ],
    ['a real call', 'guard-review completeness --gate "$1" || exit 1\nguard-sentry --gate "$1"'],
  ])('%s in the repo hook never removes a selected judge', (_label, body) => {
    const root = repo();
    mkdirSync(join(root, '.husky'));
    writeFileSync(join(root, '.husky', 'commit-msg'), `#!/bin/sh\n${body}\n`);
    const plan = planOverlayCommitMsg(base(root, ['review', 'sentry'], ['commit-msg']));
    expect(plan.kind).toBe('judges');
    expect(plan.content).toContain('# devkit:guard-completeness');
    expect(plan.content).toContain('# devkit:guard-sentry');
  });

  it('a repo hook that really calls a judge only earns a double-run warning', () => {
    const root = repo();
    mkdirSync(join(root, '.husky'));
    writeFileSync(
      join(root, '.husky', 'commit-msg'),
      '#!/bin/sh\nguard-review completeness --gate "$1"\n',
    );
    const plan = planOverlayCommitMsg(base(root, ['review', 'sentry'], ['commit-msg']));
    expect(plan.kind === 'judges' && plan.alsoInRepo).toEqual(['review']);
    expect(describeOverlayCommitMsg(plan)).toMatch(
      /also appears to call completeness — it will run twice/,
    );
  });

  // Only devkit's exact 0755 is healthy: a mode git may refuse to run for the owner is drift.
  it.each([
    ['0644', 0o644],
    ['0001 (owner cannot read or run)', 0o001],
    ['0100 (owner cannot read)', 0o100],
    ['0700', 0o700],
    ['0777', 0o777],
  ])('mode %s is drift and --fix restores 0755', (_label, mode) => {
    const root = repo();
    syncOverlayCommitMsg(base(root, ['review']), { dryRun: false });
    chmodSync(hookFile(root), mode);
    expect(syncOverlayCommitMsg(base(root, ['review']), { dryRun: true }).drift).toBe(true);
    syncOverlayCommitMsg(base(root, ['review']), { dryRun: false });
    expect(statSync(hookFile(root)).mode & 0o777).toBe(0o755);
    expect(syncOverlayCommitMsg(base(root, ['review']), { dryRun: true }).drift).toBe(false);
  });

  it('replaces the hook atomically — a commit already holding the old file never sees it truncated', () => {
    const root = repo();
    syncOverlayCommitMsg(base(root, ['review']), { dryRun: false });
    const before = readFileSync(hookFile(root), 'utf8');
    // A hard link stands in for git's open handle: an in-place truncate would rewrite it too.
    const held = join(root, 'held-hook');
    linkSync(hookFile(root), held);
    syncOverlayCommitMsg(base(root, ['review', 'sentry']), { dryRun: false });
    expect(readFileSync(held, 'utf8')).toBe(before);
    expect(readFileSync(hookFile(root), 'utf8')).toContain('# devkit:guard-sentry');
    expect(readdirSync(join(root, '.devkit', 'hooks'))).toEqual(['commit-msg']); // no temp left
  });

  it('deselected with no repo hook → a leftover judge hook is removed (no stale hard gate)', () => {
    const root = repo();
    const on = syncOverlayCommitMsg(base(root, ['review']), { dryRun: false });
    expect(on.missing).toBe(true);
    expect(existsSync(hookFile(root))).toBe(true);
    const off = syncOverlayCommitMsg(base(root, ['size']), { dryRun: false });
    expect(off.drift).toBe(true);
    expect(existsSync(hookFile(root))).toBe(false);
    // and a second pass is clean
    expect(syncOverlayCommitMsg(base(root, ['size']), { dryRun: true }).drift).toBe(false);
  });

  it('dry-run reports drift but writes nothing', () => {
    const root = repo();
    const r = syncOverlayCommitMsg(base(root, ['review']), { dryRun: true });
    expect(r).toMatchObject({ missing: true, drift: true });
    expect(existsSync(hookFile(root))).toBe(false);
  });

  it('writes an EXECUTABLE hook (git silently skips a non-executable one)', () => {
    const root = repo();
    syncOverlayCommitMsg(base(root, ['review']), { dryRun: false });
    const mode = execFileSync(
      'stat',
      process.platform === 'darwin' ? ['-f', '%Lp', hookFile(root)] : ['-c', '%a', hookFile(root)],
      {
        encoding: 'utf8',
      },
    ).trim();
    expect(mode).toBe('755');
  });
});

// Concurrent actors can delete or chmod the hook while it is read: a vanished hook reads as missing
// (never an ENOENT crash), a +x lost mid-read is observed, and other read failures still surface.
describe('readHook — hook changing under the read', () => {
  const existingHook = () => {
    const root = mkdtempSync(join(tmpdir(), 'dk-ov-race-'));
    homes.push(root);
    const path = join(root, 'commit-msg');
    writeFileSync(path, '#!/bin/sh\n');
    chmodSync(path, 0o755);
    return path;
  };

  it('a hook deleted before the read reads as missing', () => {
    const path = existingHook();
    rmSync(path);
    expect(readHook(path)).toBeNull();
  });

  it('an executable bit removed while the content is read is observed', () => {
    const path = existingHook();
    const r = readHook(path, (fd) => {
      chmodSync(path, 0o644);
      return readFileSync(fd, 'utf8');
    });
    expect(r).toEqual({ content: '#!/bin/sh\n', mode: 0o644 });
  });

  it('a hook the owner cannot read is reported unreadable (drift), not missing and not a crash', () => {
    const path = existingHook();
    chmodSync(path, 0o100);
    expect(readHook(path)).toEqual({ content: null, mode: 0o100 });
  });

  it('any other read failure is not swallowed as missing', () => {
    const eio = () => {
      throw Object.assign(new Error('EIO: simulated'), { code: 'EIO' });
    };
    expect(() => readHook(existingHook(), eio)).toThrow(/EIO/);
  });
});
