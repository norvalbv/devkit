/**
 * `guard-review record-agent <label>` — the entry point for an agent the assistant dispatched via
 * the Task tool rather than through execJudge (the `prior-art` subagent the brainstorming skill
 * invokes). Spawned as a real subprocess because stdin IS the contract: the agent's response
 * arrives on it, and the exit code must stay 0 whatever happens, since the caller is an assistant
 * mid-conversation and never a gate.
 *
 * Sink env matches judge-exec-telemetry.test.mts: vitest.setup holds DEVKIT_NO_TELEMETRY=1
 * suite-wide, and an explicit DEVKIT_GATE_EVENTS is what opts a run back in.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.mts');

let dir: string;
let sink: string;

interface Run {
  status: number;
  stderr: string;
}

// spawnSync, not execFileSync: the latter returns only stdout and only on success, so the warning
// path (exit 0 WITH a stderr line) would read as empty.
function runCli(args: string[], input: string, env: Record<string, string> = {}): Run {
  const result = spawnSync('node', [CLI, ...args], {
    input,
    encoding: 'utf8',
    env: { ...process.env, DEVKIT_GATE_EVENTS: sink, DEVKIT_SHIP_ID: 'ship-ra', ...env },
  });
  return { status: result.status ?? -1, stderr: result.stderr ?? '' };
}

function events(): Record<string, unknown>[] {
  try {
    return readFileSync(sink, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'record-agent-cli-'));
  sink = path.join(dir, 'telemetry', 'gate-events.jsonl');
});

describe('guard-review record-agent', () => {
  it('records the stdin response as one judge_exec plus a resolvable transcript', () => {
    const response = '{"verdict":"DISSOLVE_FRAME","framing":"DISSOLVES"}';
    const { status } = runCli(
      ['record-agent', 'prior-art', '--model', 'opus', '--duration-ms', '42000'],
      response,
    );
    expect(status).toBe(0);

    const [ev, ...rest] = events();
    expect(rest).toEqual([]);
    expect(ev).toMatchObject({
      type: 'judge_exec',
      judge: 'prior-art',
      model: 'opus',
      outcome: 'ok',
      duration_ms: 42_000,
      output_chars: response.length,
    });
    // Same shape the reviewers emit, so the dashboard needs no special case for this path.
    expect(ev).toHaveProperty('devkit_version');
    expect(readFileSync(path.join(dir, 'telemetry', String(ev?.transcript_ref)), 'utf8')).toContain(
      response,
    );
  });

  it('carries the disposition label so an override is mineable as a disagreement', () => {
    const { status } = runCli(
      ['record-agent', 'prior-art', '--disposition', 'overridden', '--reason', 'frame still held'],
      '{"verdict":"SOLVED_ELSEWHERE"}',
    );
    expect(status).toBe(0);
    expect(events()[0]).toMatchObject({
      disposition: 'overridden',
      disposition_reason: 'frame still held',
    });
  });

  it('drops an unrecognised disposition (keeping the field groupable) but still records the run', () => {
    const { status, stderr } = runCli(
      ['record-agent', 'prior-art', '--disposition', 'sort-of'],
      '{"verdict":"GENUINE_NEW_WORK"}',
    );
    expect(status).toBe(0);
    expect(stderr).toContain('ignoring unknown --disposition');
    const [ev] = events();
    expect(ev).toMatchObject({ judge: 'prior-art' });
    expect(ev).not.toHaveProperty('disposition');
  });

  it('records an empty stdin as outcome empty, not as a success with no transcript', () => {
    const { status } = runCli(['record-agent', 'prior-art'], '');
    expect(status).toBe(0);
    const [ev] = events();
    expect(ev).toMatchObject({ judge: 'prior-art', outcome: 'empty', output_chars: 0 });
    expect(ev).not.toHaveProperty('transcript_ref');
  });

  it('exits 0 with telemetry off — the assistant must never be blocked by a dark sink', () => {
    const { status } = runCli(['record-agent', 'prior-art'], '{"verdict":"GENUINE_NEW_WORK"}', {
      DEVKIT_GATE_EVENTS: '',
      DEVKIT_NO_TELEMETRY: '1',
    });
    expect(status).toBe(0);
    expect(events()).toEqual([]);
  });

  it('mints a distinct correlation id per invocation, so back-to-back runs never merge', () => {
    // Deliberately WITHOUT DEVKIT_SHIP_ID — the fallback path real brainstorming usage takes. Two
    // runs made before anything is staged would otherwise both derive `commit-<git write-tree>`,
    // land the same ship_id, and be synthesised downstream as a single commit row.
    const noShip = { DEVKIT_SHIP_ID: '' };
    runCli(['record-agent', 'prior-art'], '{"verdict":"GENUINE_NEW_WORK"}', noShip);
    runCli(['record-agent', 'prior-art'], '{"verdict":"SOLVED_ELSEWHERE"}', noShip);

    const [first, second] = events();
    expect(first?.ship_id).toBeTruthy();
    expect(first?.ship_id).not.toBe(second?.ship_id);
    // Not 'commit' — a reader must not synthesise a commit row from an invocation that has no
    // staged tree behind it.
    expect(first).toMatchObject({ run_mode: 'agent' });
    expect(first).not.toHaveProperty('commit_tree');
    // Distinct ids mean distinct transcript dirs, so neither run can shadow the other's response.
    expect(first?.transcript_ref).not.toBe(second?.transcript_ref);
  });

  it('still correlates to the ship when one legitimately owns the run', () => {
    runCli(['record-agent', 'prior-art'], '{"verdict":"GENUINE_NEW_WORK"}');
    expect(events()[0]).toMatchObject({ ship_id: 'ship-ra' });
  });

  it('prints usage and exits 2 when the label is missing', () => {
    const { status, stderr } = runCli(['record-agent'], '{}');
    expect(status).toBe(2);
    expect(stderr).toContain('record-agent <label>');
    expect(events()).toEqual([]);
  });
});
