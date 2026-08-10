import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
    expect(decide(pre('Edit'), root, tmp)).toBeNull();
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
