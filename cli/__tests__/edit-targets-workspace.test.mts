/** workspaceRoot: the edit hooks act on the linked worktree the payload cwd names, keeping the project's
 * offset inside it, while CLAUDE_PROJECT_DIR stays on the main checkout. */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workspaceRoot } from '../../agents-hooks/edit-targets-lib.mjs';
import { rootRegistry } from './_helpers.mts';
import { mainWithWorktree } from './_worktree-fixture.mts';

const REMINDER = fileURLToPath(
  new URL('../../agents-hooks/claude-rules-reminder.mjs', import.meta.url),
);
const { mkTmp, cleanup } = rootRegistry();
afterEach(() => {
  vi.unstubAllEnvs();
  cleanup();
});

function rootFor(project: string, cwd?: string) {
  vi.stubEnv('CLAUDE_PROJECT_DIR', project);
  return workspaceRoot(cwd === undefined ? {} : { cwd });
}

describe('workspaceRoot', () => {
  it('moves to the linked worktree the payload cwd is in', () => {
    const { main, worktree } = mainWithWorktree(mkTmp);
    expect(rootFor(main, worktree)).toBe(worktree);
  });

  // Catches a containment test in place of the toplevel check: `.claude/worktrees/<name>` sits in main.
  it('moves to a linked worktree nested inside the main checkout', () => {
    const { main } = mainWithWorktree(mkTmp);
    const nested = join(main, '.claude', 'worktrees', 'wt');
    execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '--detach', nested]);
    expect(rootFor(main, nested)).toBe(nested);
  });

  it('keeps the project root without a cwd, in the same checkout, or in a non-git project', () => {
    const { main, worktree } = mainWithWorktree(mkTmp);
    mkdirSync(join(main, 'src'));
    expect(rootFor(main)).toBe(main);
    expect(rootFor(main, join(main, 'src'))).toBe(main);
    const plain = mkTmp('plain-');
    expect(rootFor(plain, worktree)).toBe(plain);
  });

  it('keeps the project root when the cwd is in an unrelated repository', () => {
    const { main } = mainWithWorktree(mkTmp);
    const other = mkTmp('other-');
    execFileSync('git', ['init', '-q'], { cwd: other });
    expect(rootFor(main, other)).toBe(main);
  });

  // Catches a worktree top-level returned for a monorepo package: config and scope widened to the repo.
  it("keeps a monorepo package project's offset inside the worktree", () => {
    const { main, worktree } = mainWithWorktree(mkTmp);
    mkdirSync(join(main, 'packages', 'api'), { recursive: true });
    mkdirSync(join(worktree, 'packages', 'web'), { recursive: true });
    expect(rootFor(join(main, 'packages', 'api'), join(worktree, 'packages', 'web'))).toBe(
      join(worktree, 'packages', 'api'),
    );
  });

  // Catches an offset computed from a logical project path against git's physical top-level.
  it('keeps the offset when CLAUDE_PROJECT_DIR reaches the project through a symlink', () => {
    const { main, worktree } = mainWithWorktree(mkTmp);
    mkdirSync(join(main, 'packages', 'api'), { recursive: true });
    const link = join(mkTmp('link-'), 'api');
    symlinkSync(join(main, 'packages', 'api'), link);
    expect(rootFor(link, worktree)).toBe(join(worktree, 'packages', 'api'));
  });
});

describe('claude-rules-reminder', () => {
  // Catches a reminder counting the main checkout's rules while the session works in a worktree.
  it("counts the rules in the payload cwd's worktree CLAUDE.md, else the project's", () => {
    const { main, worktree } = mainWithWorktree(mkTmp);
    writeFileSync(join(main, 'CLAUDE.md'), '<rule id="1"/>');
    writeFileSync(join(worktree, 'CLAUDE.md'), '<rule id="1"/><rule id="2"/>');
    const remind = (input: string) =>
      spawnSync(process.execPath, [REMINDER], {
        encoding: 'utf8',
        input,
        env: { ...process.env, CLAUDE_PROJECT_DIR: main },
      }).stdout;
    expect(remind(JSON.stringify({ cwd: worktree }))).toContain('defines 2 numbered rules');
    expect(remind('')).toContain('defines 1 numbered rules');
  });
});
