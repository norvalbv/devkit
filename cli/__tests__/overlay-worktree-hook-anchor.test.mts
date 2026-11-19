// An unflagged session in a linked worktree reads the overlay home's settings.local.json while
// $CLAUDE_PROJECT_DIR names the worktree, so only a home-anchored command reaches the script.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installHookRegistrations, syncHookScripts } from '../lib/install/install-hooks.mts';
import { testSpawnSync } from './_helpers.mts';

const UNANCHORED = 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/prior-art-gate.mjs"';
let parent: string;
let home: string;
let worktree: string;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

beforeAll(() => {
  parent = mkdtempSync(join(tmpdir(), 'overlay-wt-anchor-'));
  home = join(parent, 'home');
  worktree = join(parent, 'wt');
  mkdirSync(home);
  git(home, 'init', '-q');
  git(
    home,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'i',
  );
  const quiet = { targets: ['claude'] };
  syncHookScripts(home, { ...quiet, desired: ['prior-art-gate.mjs'] });
  installHookRegistrations(home, ['priorArtGate'], { ...quiet, overlay: true });
  git(home, 'worktree', 'add', '-q', worktree);
});
afterAll(() => rmSync(parent, { recursive: true, force: true }));

/** The registered command for one event and matcher in the home's overlay settings. */
function registered(event: string, matcher: string): string[] {
  const { hooks } = JSON.parse(readFileSync(join(home, '.claude/settings.local.json'), 'utf8'));
  return (Object.hasOwn(hooks, event) ? hooks[event] : [])
    .filter((group: { matcher: string }) => group.matcher === matcher)
    .flatMap((group: { hooks: { command: string }[] }) => group.hooks.map((hook) => hook.command));
}

/** Run `command` the way an unflagged worktree session's harness does: a shell in the worktree. */
function runInWorktree(command: string) {
  const input = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'feature-critique', prompt: 'critique the plan' },
    session_id: `wt-${Date.now()}`,
    cwd: worktree,
  };
  return testSpawnSync('sh', ['-c', command], {
    cwd: worktree,
    input: JSON.stringify(input),
    env: { ...process.env, CLAUDE_PROJECT_DIR: worktree, TMPDIR: parent },
    encoding: 'utf8',
  });
}

describe('overlay hooks in a linked worktree', () => {
  it('writes nothing into the worktree', () => {
    expect(existsSync(join(worktree, '.claude'))).toBe(false);
  });

  it('registers one prior-art handler per matcher, anchored at the home', () => {
    const [command, ...rest] = registered('PreToolUse', 'ExitPlanMode|Task|Agent');
    expect(rest).toEqual([]);
    expect(command).toBe(`node "${realpathSync.native(home)}/.claude/hooks/prior-art-gate.mjs"`);
  });

  it('runs the prior-art gate from the worktree, which denies the first critique dispatch', () => {
    const [command] = registered('PreToolUse', 'ExitPlanMode|Task|Agent');
    const run = runInWorktree(command);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('"deny"');
  });

  it('control: the unanchored spelling finds no script from the worktree', () => {
    const run = runInWorktree(UNANCHORED);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('Cannot find module');
    expect(run.stdout).not.toContain('"deny"');
  });
});
