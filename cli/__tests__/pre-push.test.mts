import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { testSpawnSync } from './_helpers.mts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PRE_PUSH_HOOK = join(REPO_ROOT, '.husky/pre-push');
const ZERO_OID = '0000000000000000000000000000000000000000';
const cleanupPaths: string[] = [];

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function seedRepository(): {
  fakeBin: string;
  logPath: string;
  root: string;
  tagOid: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'devkit-pre-push-'));
  cleanupPaths.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'pre-push-test@example.com');
  git(root, 'config', 'user.name', 'Pre-push Test');
  git(root, 'config', 'core.hooksPath', '.husky/_');

  mkdirSync(join(root, '.husky/_'), { recursive: true });
  const preCommit = join(root, '.husky/_/pre-commit');
  writeFileSync(preCommit, '#!/bin/sh\nexit 0\n');
  chmodSync(preCommit, 0o755);
  writeFileSync(join(root, 'package.json'), '{"name":"pre-push-fixture","private":true}\n');
  writeFileSync(join(root, 'tracked.mts'), 'export const clean = true;\n');
  for (const relativePath of [
    'cli/lib/husky/pre-push-validation.sh',
    'cli/lib/ship/dependency-preflight.mts',
    'cli/lib/ship/prepare-gate-worktree.sh',
  ]) {
    const destination = join(root, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(REPO_ROOT, relativePath), destination);
  }
  git(root, 'add', 'package.json', 'tracked.mts', 'cli');
  git(root, 'commit', '-qm', 'seed');
  git(root, 'tag', '-a', 'v1.0.0', '-m', 'fixture tag');

  mkdirSync(join(root, 'node_modules'), { recursive: true });
  const fakeBin = join(root, 'fake-bin');
  const logPath = join(root, 'bun.log');
  mkdirSync(fakeBin);
  const fakeBun = join(fakeBin, 'bun');
  writeFileSync(
    fakeBun,
    [
      '#!/bin/sh',
      'printf "%s\\t%s\\n" "$PWD" "$*" >> "$PRE_PUSH_TEST_LOG"',
      // A distinctive, non-1 code: the hook must propagate the gate's OWN status, not a normalised 1.
      'case " $* " in *" run typecheck "*) [ ! -e "$PWD/fail-typecheck" ] || exit 7 ;; esac',
      // Fails the SUITE only, so a test can reach the test phase — dirty-only.mts fails both.
      'case " $* " in *" run test:run "*) [ ! -e "$PWD/fail-tests" ] || exit 7 ;; esac',
      '[ ! -e "$PWD/dirty-only.mts" ]',
      '',
    ].join('\n'),
  );
  chmodSync(fakeBun, 0o755);

  return {
    fakeBin,
    logPath,
    root,
    tagOid: git(root, 'rev-parse', 'refs/tags/v1.0.0'),
  };
}

function runPrePush(
  root: string,
  fakeBin: string,
  logPath: string,
  input: string,
  extraEnv: Record<string, string> = {},
) {
  // Supervised: this runs the REAL validation script and its gate-chain process tree. See
  // docs/decisions/suite-hangs-bound-at-the-spawn-site.md (sc-2393).
  return testSpawnSync('sh', ['-e', PRE_PUSH_HOOK, 'origin', 'fixture://origin'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      PRE_PUSH_TEST_LOG: logPath,
      ...extraEnv,
    },
    input,
  });
}

function readLog(logPath: string): string[] {
  return readFileSync(logPath, 'utf8').trim().split('\n');
}

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

describe('devkit repository pre-push hook', () => {
  it('validates an annotated tag in an isolated worktree at the tagged commit', () => {
    const { fakeBin, logPath, root, tagOid } = seedRepository();
    writeFileSync(join(root, 'dirty-only.mts'), 'const unrelatedTypeError: string = 1;\n');

    const result = runPrePush(
      root,
      fakeBin,
      logPath,
      `refs/tags/v1.0.0 ${tagOid} refs/tags/v1.0.0 ${ZERO_OID}\n`,
    );

    expect(result.stderr).toContain(`validating tagged commit ${git(root, 'rev-parse', 'HEAD')}`);
    expect(result.stderr).toContain('tag validation: linked node_modules');
    expect(result.status).toBe(0);
    const invocations = readLog(logPath);
    expect(invocations).toHaveLength(2);
    expect(invocations[0]).toContain('\trun typecheck');
    expect(invocations[1]).toContain('\trun test:run');
    for (const invocation of invocations) {
      expect(invocation.startsWith(`${realpathSync(root)}\t`)).toBe(false);
    }
    expect(git(root, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
  });

  it('keeps branch-push validation in the caller worktree', () => {
    const { fakeBin, logPath, root } = seedRepository();
    const head = git(root, 'rev-parse', 'HEAD');

    const result = runPrePush(
      root,
      fakeBin,
      logPath,
      `refs/heads/main ${head} refs/heads/main ${ZERO_OID}\n`,
    );

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(readLog(logPath)).toEqual([
      `${realpathSync(root)}\trun typecheck`,
      `${realpathSync(root)}\trun test:run`,
    ]);
  });

  it('does not run source validation for a tag deletion', () => {
    const { fakeBin, logPath, root } = seedRepository();

    const result = runPrePush(
      root,
      fakeBin,
      logPath,
      `(delete) ${ZERO_OID} refs/tags/v1.0.0 ${git(root, 'rev-parse', 'HEAD')}\n`,
    );

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(() => readFileSync(logPath, 'utf8')).toThrow();
  });

  // sc-1508: a devkit ship hands the hook the exact commit it is pushing. That one commit's suite is
  // gated by CI on the PR, so the local pre-push suite is skipped for it — content-keyed and fail-closed.
  it('skips the pre-push suite for a devkit ship of the exact pushed commit', () => {
    const { fakeBin, logPath, root } = seedRepository();
    const head = git(root, 'rev-parse', 'HEAD');

    const result = runPrePush(
      root,
      fakeBin,
      logPath,
      `refs/heads/main ${head} refs/heads/main ${ZERO_OID}\n`,
      { DEVKIT_SHIP_PREPUSH_SKIP_SHA: head },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(`${head} is a devkit ship`);
    expect(result.stderr).toContain('skipping the local pre-push suite');
    // The fake bun logs every invocation; a skipped suite never touches it, so the log never exists.
    expect(() => readFileSync(logPath, 'utf8')).toThrow();
  });

  it('runs the full suite when the ship sha does not match the pushed commit (fail-closed)', () => {
    const { fakeBin, logPath, root } = seedRepository();
    const head = git(root, 'rev-parse', 'HEAD');
    const otherSha = 'a'.repeat(40); // valid 40-hex oid, but not the commit being pushed

    const result = runPrePush(
      root,
      fakeBin,
      logPath,
      `refs/heads/main ${head} refs/heads/main ${ZERO_OID}\n`,
      { DEVKIT_SHIP_PREPUSH_SKIP_SHA: otherSha },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('devkit ship');
    expect(readLog(logPath)).toEqual([
      `${realpathSync(root)}\trun typecheck`,
      `${realpathSync(root)}\trun test:run`,
    ]);
  });

  it('ignores a non-oid ship marker and runs the full suite', () => {
    const { fakeBin, logPath, root } = seedRepository();
    const head = git(root, 'rev-parse', 'HEAD');

    const result = runPrePush(
      root,
      fakeBin,
      logPath,
      `refs/heads/main ${head} refs/heads/main ${ZERO_OID}\n`,
      { DEVKIT_SHIP_PREPUSH_SKIP_SHA: 'ship-in-progress' }, // junk → treated as absent
    );

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('devkit ship');
    expect(readLog(logPath)).toEqual([
      `${realpathSync(root)}\trun typecheck`,
      `${realpathSync(root)}\trun test:run`,
    ]);
  });

  it('fail-closed on a mixed push where another branch is not the ship commit', () => {
    const { fakeBin, logPath, root } = seedRepository();
    const head = git(root, 'rev-parse', 'HEAD');
    const otherSha = 'b'.repeat(40); // a second branch at a different tip, pushed alongside the ship commit

    const result = runPrePush(
      root,
      fakeBin,
      logPath,
      `refs/heads/main ${head} refs/heads/main ${ZERO_OID}\n` +
        `refs/heads/other ${otherSha} refs/heads/other ${ZERO_OID}\n`,
      { DEVKIT_SHIP_PREPUSH_SKIP_SHA: head },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('devkit ship');
    expect(readLog(logPath)).toEqual([
      `${realpathSync(root)}\trun typecheck`,
      `${realpathSync(root)}\trun test:run`,
    ]);
  });
});

// sc-2198: a blocked push now names its base so a correct block is not read as flake. The block
// itself must be untouched — these assert the verdict, not the narration.
describe('pre-push failure attribution', () => {
  it('preserves the gate’s own exit code, not a normalised 1', () => {
    const { fakeBin, logPath, root } = seedRepository();
    writeFileSync(join(root, 'fail-typecheck'), '');
    const head = git(root, 'rev-parse', 'HEAD');
    const result = runPrePush(
      root,
      fakeBin,
      logPath,
      `refs/heads/main ${head} refs/heads/main ${ZERO_OID}\n`,
    );
    expect(result.status).toBe(7);
  });

  it('says nothing after a TYPECHECK failure — there are no test results to attribute', () => {
    const { fakeBin, logPath, root } = seedRepository();
    writeFileSync(join(root, 'fail-typecheck'), '');
    const head = git(root, 'rev-parse', 'HEAD');
    const result = runPrePush(
      root,
      fakeBin,
      logPath,
      `refs/heads/main ${head} refs/heads/main ${ZERO_OID}\n`,
    );
    expect(result.stderr).not.toContain('push base');
    // Exactly one command ran: the suite is never reached.
    expect(readLog(logPath)).toEqual([`${realpathSync(root)}\trun typecheck`]);
  });

  it('names the base when the suite fails and the base resolves', () => {
    const { fakeBin, logPath, root } = seedRepository();
    const base = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'later.mts'), 'export const later = true;\n');
    git(root, 'add', 'later.mts');
    git(root, 'commit', '-qm', 'later');
    const head = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'fail-tests'), '');
    const result = runPrePush(
      root,
      fakeBin,
      logPath,
      `refs/heads/main ${head} refs/heads/main ${base}\n`,
    );
    expect(result.status).toBe(7);
    expect(result.stderr).toContain('pre-date your push');
    expect(result.stderr).toContain(base.slice(0, 7));
  });

  it('stays silent on a brand-new branch with no remote knowledge', () => {
    const { fakeBin, logPath, root } = seedRepository();
    const head = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'fail-tests'), '');
    const result = runPrePush(
      root,
      fakeBin,
      logPath,
      `refs/heads/new ${head} refs/heads/new ${ZERO_OID}\n`,
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain('push base');
    expect(result.stderr).not.toContain('pre-date your push');
  });

  it('stays silent when two refs carry the same tree to different remote tips', () => {
    const { fakeBin, logPath, root } = seedRepository();
    const base = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'later.mts'), 'export const later = true;\n');
    git(root, 'add', 'later.mts');
    git(root, 'commit', '-qm', 'later');
    const head = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'fail-tests'), '');
    // Which base gets narrated would otherwise be a function of input order alone.
    const result = runPrePush(
      root,
      fakeBin,
      logPath,
      `refs/heads/main ${head} refs/heads/main ${base}\n` +
        `refs/heads/other ${head} refs/heads/other ${head}\n`,
    );
    expect(result.status).toBe(7);
    expect(result.stderr).not.toContain('pre-date your push');
  });

  // run_checks tests the WORKTREE. Pushing a ref that carries some other commit means the tested
  // tree was never that ref's, so naming its base would blame the wrong change entirely.
  it('stays silent when the pushed ref is not the tree that was tested', () => {
    const { fakeBin, logPath, root } = seedRepository();
    const base = git(root, 'rev-parse', 'HEAD');
    // A second branch whose tip is a DIFFERENT commit from the checked-out HEAD.
    git(root, 'checkout', '-q', '-b', 'feature');
    writeFileSync(join(root, 'feature-only.mts'), 'export const f = true;\n');
    git(root, 'add', 'feature-only.mts');
    git(root, 'commit', '-qm', 'feature');
    const featureTip = git(root, 'rev-parse', 'HEAD');
    git(root, 'checkout', '-q', '-');
    const headNow = git(root, 'rev-parse', 'HEAD');
    expect(featureTip).not.toBe(headNow);

    writeFileSync(join(root, 'fail-tests'), '');
    const result = runPrePush(
      root,
      fakeBin,
      logPath,
      `refs/heads/feature ${featureTip} refs/heads/feature ${base}\n`,
    );
    expect(result.status).toBe(7);
    expect(result.stderr).not.toContain('pre-date your push');
    expect(result.stderr).not.toContain('in your change');
  });

  it('can be turned off without changing the verdict', () => {
    const { fakeBin, logPath, root } = seedRepository();
    const base = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'later.mts'), 'export const later = true;\n');
    git(root, 'add', 'later.mts');
    git(root, 'commit', '-qm', 'later');
    const head = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'fail-tests'), '');
    const result = runPrePush(
      root,
      fakeBin,
      logPath,
      `refs/heads/main ${head} refs/heads/main ${base}\n`,
      { DEVKIT_PREPUSH_ATTRIBUTION: '0' },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain('pre-date your push');
  });

  // Git writes an all-zero oid at the repository's HASH WIDTH: 40 for SHA-1, 64 for SHA-256. A
  // fixed-width literal makes every deletion in a SHA-256 repo read as a real update, and the hook
  // then tries to peel a commit from an oid that cannot exist.
  it('treats a 64-zero (SHA-256) oid as a deletion, not a real update', () => {
    const { fakeBin, logPath, root } = seedRepository();
    const sha256Zero = '0'.repeat(64);
    const result = runPrePush(
      root,
      fakeBin,
      logPath,
      `refs/tags/v1.0.0 ${sha256Zero} refs/tags/v1.0.0 ${sha256Zero}\n`,
    );
    // A tag deletion has no source tree to validate: exit 0 with the suite never invoked.
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(logPath)).toBe(false);
  });

  it('emits no attribution on the tag path', () => {
    const { fakeBin, logPath, root, tagOid } = seedRepository();
    writeFileSync(join(root, 'dirty-only.mts'), '');
    git(root, 'add', 'dirty-only.mts');
    git(root, 'commit', '-qm', 'poison');
    git(root, 'tag', '-a', 'v2.0.0', '-m', 'poisoned');
    const poisoned = git(root, 'rev-parse', 'refs/tags/v2.0.0');
    const result = runPrePush(
      root,
      fakeBin,
      logPath,
      `refs/tags/v2.0.0 ${poisoned} refs/tags/v2.0.0 ${ZERO_OID}\n`,
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain('pre-date your push');
    expect(tagOid).toBeTruthy();
  });
});
