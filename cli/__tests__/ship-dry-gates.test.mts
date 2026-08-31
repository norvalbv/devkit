import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testSpawnSync as spawnSync } from './_helpers.mts';
import {
  localBranchExists,
  remoteBranchExists,
  scriptPath,
  seedBaseRepo,
  seedShipRepo,
} from './_ship-branch-fixture.mts';

describe('ship-branch.sh — --dry-gates', () => {
  it('supports the same committed --from-branch source snapshot without keeping a branch', () => {
    const { dir, env, git, bare } = seedBaseRepo({
      hookBody: 'test "$(git diff --cached --name-only)" = note.txt',
    });

    const r = spawnSync(
      '/bin/bash',
      [
        scriptPath,
        'feat/dry-gates-branch',
        'ship it',
        '--dry-gates',
        '--base',
        'studio',
        '--from-branch',
      ],
      { cwd: dir, input: '', encoding: 'utf8', env },
    );

    expect(r.status, r.stderr).toBe(0);
    expect(localBranchExists(git, 'feat/dry-gates-branch')).toBe(false);
    expect(remoteBranchExists(bare, 'feat/dry-gates-branch')).toBe(false);
  });

  it('rehearses the exact fetched base and explicit path brief without leaving a commit or branch', () => {
    const { dir, env, git, bare, studioTip } = seedBaseRepo({
      hookBody: `
[ "\${DEVKIT_RUN_MODE:-}" = dry-gates ] || exit 0
test "$DEVKIT_RUN_MODE" = dry-gates || exit 91
test "$DEVKIT_REVIEW_GUARDS" = comments || exit 92
test "$DEVKIT_SHIP_BASE_SHA" = "$EXPECTED_BASE" || exit 93
test "$(git diff --cached --name-only)" = note.txt || exit 94
test "$(cat note.txt)" = finalized || exit 95
test -f coverage/coverage-summary.json || exit 96
test -z "$(git symbolic-ref -q --short HEAD)" || exit 97
printf 'DRY_GATES_HOOK_OK\n'
`,
    });
    const headBefore = git(['rev-parse', 'HEAD']).trim();
    mkdirSync(join(dir, 'coverage'), { recursive: true });
    writeFileSync(join(dir, 'coverage', 'coverage-summary.json'), '{}\n');
    writeFileSync(join(dir, 'unrelated.txt'), 'parallel work\n');

    const r = spawnSync(
      '/bin/bash',
      [
        scriptPath,
        'feat/dry-gates',
        'ship it',
        '--dry-gates',
        '--base',
        'studio',
        '--',
        'note.txt',
      ],
      {
        cwd: dir,
        input: '',
        encoding: 'utf8',
        env: { ...env, EXPECTED_BASE: studioTip },
      },
    );

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/dry gates.*decision.*domain.*completeness/is);
    expect(r.stderr).not.toContain('DRY: committed locally');
    expect(git(['rev-parse', 'HEAD']).trim()).toBe(headBefore);
    expect(localBranchExists(git, 'feat/dry-gates')).toBe(false);
    expect(remoteBranchExists(bare, 'feat/dry-gates')).toBe(false);
    const gateLog = /full output: (.+)/.exec(r.stderr)?.[1];
    expect(gateLog).toBeTruthy();
    expect(realpathSync(dirname(gateLog))).toBe(realpathSync(join(dir, '.devkit')));
    expect(basename(gateLog)).toMatch(/^last-ship-gates-.+\.log$/);
    expect(readFileSync(gateLog, 'utf8')).toContain('DRY_GATES_HOOK_OK');
  });

  it('returns the hook failure and still removes its ephemeral branch', () => {
    const { dir, env, git } = seedShipRepo({ hookBody: 'echo DRY_GATES_BLOCKED >&2\nexit 1' });
    writeFileSync(join(dir, 'note.txt'), 'blocked\n');

    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/dry-gates-blocked', 'ship it', '--dry-gates', '--', 'note.txt'],
      { cwd: dir, input: '', encoding: 'utf8', env },
    );

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('DRY_GATES_BLOCKED');
    expect(localBranchExists(git, 'feat/dry-gates-blocked')).toBe(false);
  });

  it('removes a locked detached worktree without ever creating a branch', () => {
    const { dir, env, git } = seedShipRepo({
      hookBody: `
test -z "$(git symbolic-ref -q --short HEAD)" || exit 97
git worktree lock --reason test .
echo DRY_GATES_LOCKED_OK`,
    });
    writeFileSync(join(dir, 'note.txt'), 'blocked\n');

    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/dry-gates-locked', 'ship it', '--dry-gates', '--', 'note.txt'],
      { cwd: dir, input: '', encoding: 'utf8', env },
    );

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('DRY_GATES_LOCKED_OK');
    expect(localBranchExists(git, 'feat/dry-gates-locked')).toBe(false);
    const linked = git(['worktree', 'list', '--porcelain'])
      .split('\n\n')
      .map((block) => /^worktree (.+)$/m.exec(block)?.[1])
      .find((path) => path && realpathSync(path) !== realpathSync(dir));
    expect(linked).toBeUndefined();
  });

  it('allocates distinct proof logs for repeated same-branch rehearsals', () => {
    const { dir, env } = seedShipRepo();
    writeFileSync(join(dir, 'note.txt'), 'concurrent\n');

    const run = () =>
      spawnSync(
        '/bin/bash',
        [scriptPath, 'feat/dry-gates-shared', 'ship it', '--dry-gates', '--', 'note.txt'],
        { cwd: dir, input: '', encoding: 'utf8', env },
      );

    const results = [run(), run()];
    for (const result of results) expect(result.status, result.stderr).toBe(0);
    const logs = results.map((result) => /full output: (.+)/.exec(result.stderr)?.[1]);
    expect(logs[0]).toBeTruthy();
    expect(logs[1]).toBeTruthy();
    expect(logs[0]).not.toBe(logs[1]);
  });
});
