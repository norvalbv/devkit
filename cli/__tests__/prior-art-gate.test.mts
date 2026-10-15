import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decide,
  markerPaths,
  recordRun,
  renderOutput,
} from '../../agents-hooks/prior-art-gate.mjs';

let root: string;
let tmp: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'prior-art-gate-root-'));
  tmp = mkdtempSync(join(tmpdir(), 'prior-art-gate-tmp-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

const pre = (toolName: string, subagent?: string, session = 'sess-1') => ({
  hook_event_name: 'PreToolUse',
  tool_name: toolName,
  tool_input: subagent === undefined ? {} : { subagent_type: subagent },
  session_id: session,
});

const post = (toolName: string, subagent: string, session = 'sess-1') => ({
  hook_event_name: 'PostToolUse',
  tool_name: toolName,
  tool_input: { subagent_type: subagent },
  session_id: session,
});

describe('recordRun (PostToolUse)', () => {
  it('records a completed prior-art dispatch as the .ran marker', () => {
    recordRun(post('Task', 'prior-art'), root, tmp);
    expect(existsSync(markerPaths(root, 'sess-1', tmp).ran)).toBe(true);
  });

  it('accepts the Agent-named subagent tool too', () => {
    recordRun(post('Agent', 'prior-art'), root, tmp);
    expect(existsSync(markerPaths(root, 'sess-1', tmp).ran)).toBe(true);
  });

  it('ignores other subagents and non-subagent tools', () => {
    recordRun(post('Task', 'feature-critique'), root, tmp);
    recordRun(post('Bash', 'prior-art'), root, tmp);
    expect(existsSync(markerPaths(root, 'sess-1', tmp).ran)).toBe(false);
  });
});

describe('decide (PreToolUse)', () => {
  it('denies the first ExitPlanMode with no prior-art run and snoozes the session', () => {
    const reason = decide(pre('ExitPlanMode'), root, tmp);
    expect(reason).toContain('prior-art');
    expect(reason).toContain('retry');
    expect(existsSync(markerPaths(root, 'sess-1', tmp).snoozed)).toBe(true);
    // deny-once: the immediate retry passes
    expect(decide(pre('ExitPlanMode'), root, tmp)).toBeNull();
  });

  it('denies a feature-critique dispatch and the snooze also covers ExitPlanMode', () => {
    expect(decide(pre('Task', 'feature-critique'), root, tmp)).not.toBeNull();
    // one deny per session TOTAL — the back-to-back plan-exit is not taxed again
    expect(decide(pre('ExitPlanMode'), root, tmp)).toBeNull();
  });

  it('never denies once a prior-art run is recorded, and writes no snooze', () => {
    recordRun(post('Task', 'prior-art'), root, tmp);
    expect(decide(pre('ExitPlanMode'), root, tmp)).toBeNull();
    expect(decide(pre('Agent', 'feature-critique'), root, tmp)).toBeNull();
    expect(existsSync(markerPaths(root, 'sess-1', tmp).snoozed)).toBe(false);
  });

  it('passes every non-gated call silently, including the prior-art spawn itself', () => {
    expect(decide(pre('Task', 'prior-art'), root, tmp)).toBeNull();
    expect(decide(pre('Task', 'Explore'), root, tmp)).toBeNull();
    expect(decide(pre('Read'), root, tmp)).toBeNull();
    expect(existsSync(markerPaths(root, 'sess-1', tmp).snoozed)).toBe(false);
  });

  it('isolates sessions and repos', () => {
    recordRun(post('Task', 'prior-art', 'sess-1'), root, tmp);
    expect(decide(pre('ExitPlanMode', undefined, 'sess-2'), root, tmp)).not.toBeNull();
    const otherRoot = mkdtempSync(join(tmpdir(), 'prior-art-gate-other-'));
    try {
      expect(decide(pre('ExitPlanMode'), otherRoot, tmp)).not.toBeNull();
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it('passes an ExitPlanMode whose plan carries the Prior-art: line, and the pass is sticky', () => {
    const ack = {
      hook_event_name: 'PreToolUse',
      tool_name: 'ExitPlanMode',
      tool_input: { plan: '## Plan\n\nPrior-art: skipped — copy tweak\n\n1. Edit the string.' },
      session_id: 'sess-1',
    };
    expect(decide(ack, root, tmp)).toBeNull();
    expect(existsSync(markerPaths(root, 'sess-1', tmp).snoozed)).toBe(true);
    // acknowledged once — a later gated call WITHOUT the line is not taxed
    expect(decide(pre('Task', 'feature-critique'), root, tmp)).toBeNull();
  });

  it('passes a feature-critique dispatch whose prompt carries the Prior-art: line', () => {
    const ack = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Task',
      tool_input: {
        subagent_type: 'feature-critique',
        prompt: 'Critique this plan. Prior-art: GENUINE_NEW_WORK · followed.',
      },
      session_id: 'sess-1',
    };
    expect(decide(ack, root, tmp)).toBeNull();
    expect(existsSync(markerPaths(root, 'sess-1', tmp).snoozed)).toBe(true);
  });

  it.each(['skills', '.claude/skills', '.cursor/skills'])(
    'accepts the completed-run acknowledgment prescribed by %s/prior-art',
    (surface) => {
      const skill = readFileSync(
        join(import.meta.dirname, '../..', surface, 'prior-art/SKILL.md'),
        'utf8',
      );
      const acknowledgment = skill.match(/records one line: `([^`]+)`/)?.[1];
      expect(acknowledgment).toBeTruthy();
      expect(
        decide({ ...pre('ExitPlanMode'), tool_input: { plan: acknowledgment } }, root, tmp),
      ).toBeNull();
    },
  );

  it('still denies when the plan text exists but lacks the token', () => {
    const noAck = {
      hook_event_name: 'PreToolUse',
      tool_name: 'ExitPlanMode',
      tool_input: { plan: '## Plan\n\n1. Rewrite everything.' },
      session_id: 'sess-1',
    };
    expect(decide(noAck, root, tmp)).not.toBeNull();
  });

  it('falls back to a shared "unknown" session bucket when session_id is absent', () => {
    const input = { hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: {} };
    expect(decide(input, root, tmp)).not.toBeNull();
    expect(existsSync(markerPaths(root, undefined, tmp).snoozed)).toBe(true);
  });

  it('keeps a traversal-shaped session id inside the marker directory', () => {
    const evil = '../../escape/attempt';
    const paths = markerPaths(root, evil, tmp);
    expect(dirname(paths.ran)).toBe(paths.dir);
    expect(dirname(paths.snoozed)).toBe(paths.dir);
    const input = {
      hook_event_name: 'PreToolUse',
      tool_name: 'ExitPlanMode',
      tool_input: {},
      session_id: evil,
    };
    expect(decide(input, root, tmp)).not.toBeNull();
    expect(existsSync(paths.snoozed)).toBe(true);
  });

  it('fails open on malformed input', () => {
    expect(decide(null, root, tmp)).toBeNull();
    expect(decide({ tool_name: 42 }, root, tmp)).toBeNull();
    expect(decide(undefined, root, tmp)).toBeNull();
  });
});

type HookCaller = { agent_id?: string; agent_type?: string; session_id?: string };
type ToolInput = {
  file_path?: string;
  old_string?: string;
  new_string?: string;
  content?: string;
  edits?: { old_string: string; new_string: string }[];
  input?: string;
};

const write = (toolName: string, toolInput: ToolInput, extra: HookCaller = {}) => ({
  hook_event_name: 'PreToolUse',
  tool_name: toolName,
  tool_input: toolInput,
  session_id: 'sess-1',
  ...extra,
});

describe('decide — the first file edit', () => {
  it.each([
    ['Edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }],
    ['Write', { file_path: 'src/a.ts', content: 'export {};' }],
    ['MultiEdit', { file_path: 'src/a.ts', edits: [{ old_string: 'a', new_string: 'b' }] }],
  ])('denies the first %s with no prior-art run, then the retry passes', (tool, input) => {
    expect(decide(write(tool, input), root, tmp)).toContain('prior-art');
    expect(decide(write(tool, input), root, tmp)).toBeNull();
    // the one deny is spent for the session — plan exit is not taxed again
    expect(decide(pre('ExitPlanMode'), root, tmp)).toBeNull();
  });

  it('never denies an edit once a prior-art run is recorded', () => {
    recordRun(post('Agent', 'prior-art'), root, tmp);
    expect(decide(write('Edit', { new_string: 'x' }), root, tmp)).toBeNull();
    expect(existsSync(markerPaths(root, 'sess-1', tmp).snoozed)).toBe(false);
  });

  it('passes a plan-file Write carrying the Prior-art: line, and the pass covers plan exit', () => {
    const plan = { file_path: '/plans/p.md', content: '# Plan\n\nPrior-art: skipped — rename\n' };
    expect(decide(write('Write', plan), root, tmp)).toBeNull();
    expect(existsSync(markerPaths(root, 'sess-1', tmp).snoozed)).toBe(true);
    expect(decide(pre('ExitPlanMode'), root, tmp)).toBeNull();
  });

  it('accepts the token anywhere in the input, old_string included (a fail-open false pass)', () => {
    const edit = { file_path: 'p.md', old_string: 'Prior-art: x', new_string: 'y' };
    expect(decide(write('Edit', edit), root, tmp)).toBeNull();
  });

  it('exempts subagent and teammate calls without spending the lead session reminder', () => {
    const sub = { agent_id: 'agent-7', agent_type: 'general-purpose' };
    expect(decide(write('Edit', { new_string: 'x' }, sub), root, tmp)).toBeNull();
    expect(decide({ ...pre('ExitPlanMode'), ...sub }, root, tmp)).toBeNull();
    expect(existsSync(markerPaths(root, 'sess-1', tmp).snoozed)).toBe(false);
    expect(decide(write('Edit', { new_string: 'x' }), root, tmp)).not.toBeNull();
  });

  it('gates a --agent main thread, which carries agent_type but no agent_id', () => {
    const main = write('Edit', { new_string: 'x' }, { agent_type: 'reviewer' });
    expect(decide(main, root, tmp)).not.toBeNull();
  });

  it('stays inert on Codex, whose edits report tool_name apply_patch', () => {
    expect(decide(write('apply_patch', { input: '*** Begin Patch' }), root, tmp)).toBeNull();
    expect(existsSync(markerPaths(root, 'sess-1', tmp).snoozed)).toBe(false);
  });

  it('re-arms in a new session even when the planning session ran prior-art', () => {
    recordRun(post('Task', 'prior-art', 'sess-1'), root, tmp);
    const next = write('Edit', { new_string: 'x' }, { session_id: 'sess-2' });
    expect(decide(next, root, tmp)).not.toBeNull();
  });

  it('routes the disposition to a plan or reply, never a code file, and names routine skips', () => {
    const reason = decide(write('Edit', { new_string: 'x' }), root, tmp);
    expect(reason).toContain('feature-critique');
    expect(reason).toContain('line in your plan file');
    expect(reason).toContain('never in a code file');
    expect(reason).toContain('routine or trivial work');
    expect(reason).toContain('same batch');
  });
});

const HOOK = join(import.meta.dirname, '../../agents-hooks/prior-art-gate.mjs');

/** Run the real hook script as its own process, the way the harness does; resolves its stdout. */
function runHook(projectDir: string, input: ReturnType<typeof write>): Promise<string> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [HOOK, 'edit'], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.on('close', () => done(out));
    child.stdin.end(JSON.stringify(input));
  });
}

describe('main — a parallel batch of gated calls', () => {
  it('denies exactly one call when a batch races for the session snooze', async () => {
    for (const round of [1, 2, 3]) {
      const input = write(
        'Edit',
        { new_string: 'x' },
        { session_id: `batch-${Date.now()}-${round}` },
      );
      const outs = await Promise.all(Array.from({ length: 12 }, () => runHook(root, input)));
      expect(outs.filter((out) => out.includes('"deny"'))).toHaveLength(1);
    }
  });
});

describe('renderOutput', () => {
  it('emits the Claude PreToolUse deny shape', () => {
    expect(renderOutput({}, 'why')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'why',
      },
    });
  });

  it('emits the Cursor deny shape when cursor_version is present', () => {
    expect(renderOutput({ cursor_version: '3.12.10' }, 'why')).toEqual({
      permission: 'deny',
      user_message: 'why',
      agent_message: 'why',
    });
  });
});
