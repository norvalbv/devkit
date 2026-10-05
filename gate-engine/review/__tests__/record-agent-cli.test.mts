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
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.mts');

let dir: string;
let sink: string;

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

// spawnSync, not execFileSync: the latter returns only stdout and only on success, so the warning
// path (exit 0 WITH a stderr line) would read as empty.
function runCli(args: string[], input: string | Buffer, env: Record<string, string> = {}): Run {
  const result = spawnSync('node', [CLI, ...args], {
    input,
    encoding: 'utf8',
    env: { ...process.env, DEVKIT_GATE_EVENTS: sink, DEVKIT_SHIP_ID: 'ship-ra', ...env },
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
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

describe('record-agent usage flags', () => {
  it('books valid usage flags as top-level judge_exec keys', () => {
    const r = runCli(
      [
        'record-agent',
        'prior-art',
        '--model',
        'opus',
        '--input-tokens',
        '1200',
        '--output-tokens',
        '300',
        '--cache-creation',
        '10',
        '--cache-read',
        '900',
        '--cost-usd',
        '0.42',
        '--session-id',
        'sess-9',
        '--billing',
        'api',
      ],
      'the agent verdict',
      { CLAUDE_CODE_SESSION_ID: 'root-sess-1' },
    );
    expect(r.status).toBe(0);
    const [ev] = events();
    expect(ev).toMatchObject({
      type: 'judge_exec',
      judge: 'prior-art',
      outcome: 'ok',
      input_tokens: 1200,
      output_tokens: 300,
      cache_creation: 10,
      cache_read: 900,
      cost_usd: 0.42,
      session_id: 'sess-9',
      billing: 'api',
      // The dispatched agent's session and the root that dispatched it are distinct keys.
      parent_session_id: 'root-sess-1',
    });
  });

  it('omits parent_session_id when the root agent session id is empty', () => {
    const r = runCli(['record-agent', 'prior-art'], 'verdict', { CLAUDE_CODE_SESSION_ID: '' });
    expect(r.status).toBe(0);
    expect(events()[0]).not.toHaveProperty('parent_session_id');
  });

  it('omits malformed or negative usage values instead of emitting zeros', () => {
    const r = runCli(
      // '1200oops': parseFloat would read 1200 and fabricate usage — whole-string parsing must not.
      [
        'record-agent',
        'prior-art',
        '--input-tokens',
        'abc',
        '--output-tokens',
        '-5',
        '--cost-usd',
        '',
        '--cache-read',
        '1200oops',
        '--cache-creation',
        '1.5',
      ],
      'verdict',
    );
    expect(r.status).toBe(0);
    const [ev] = events();
    expect(ev).not.toHaveProperty('input_tokens');
    expect(ev).not.toHaveProperty('output_tokens');
    expect(ev).not.toHaveProperty('cost_usd');
    expect(ev).not.toHaveProperty('cache_read');
    expect(ev).not.toHaveProperty('cache_creation'); // 1.5: token counters are integers
  });
});

describe('record-agent request capture and receipt', () => {
  const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
  const receipt = (r: Run) => {
    const lines = r.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    // SAFETY: the receipt is one flat JSON object of scalars, printed by recordAgent.
    return JSON.parse(lines[0] ?? '') as Record<string, string | null>;
  };

  it('stores the exact request beside the response and hashes the raw bytes', () => {
    // CRLF must survive byte-for-byte: the hash and the stored request describe the same bytes.
    const request = 'ticket premise\r\nüber\n';
    const requestFile = path.join(dir, 'request.txt');
    writeFileSync(requestFile, request);
    const response = '{"verdict":"DISSOLVE_FRAME"}';
    const r = runCli(['record-agent', 'prior-art', '--request-file', requestFile], response);
    expect(r.status).toBe(0);

    const [ev] = events();
    expect(ev).toMatchObject({ request_sha256: sha(request), output_sha256: sha(response) });
    expect(ev?.input_chars).toBe(request.length);
    const transcript = readFileSync(
      path.join(dir, 'telemetry', String(ev?.transcript_ref)),
      'utf8',
    );
    expect(transcript).toContain(request);
    expect(transcript).toContain(response);
    expect(receipt(r)).toEqual({
      invocation_id: ev?.invocation_id,
      output_sha256: sha(response),
      request_sha256: sha(request),
      transcript_ref: ev?.transcript_ref,
      telemetry: 'written',
    });
  });

  it('hashes a non-UTF-8 request but never stores a lossy copy of it', () => {
    const request = Buffer.from([...Buffer.from('premise '), 0xff, 0x0a]);
    const requestFile = path.join(dir, 'request.bin');
    writeFileSync(requestFile, request);
    const r = runCli(['record-agent', 'prior-art', '--request-file', requestFile], 'verdict');
    expect(r.status).toBe(0);
    const [ev] = events();
    expect(ev).toMatchObject({
      request_sha256: sha(request),
      request_status: 'not_utf8',
      input_chars: 0,
    });
    const transcript = readFileSync(
      path.join(dir, 'telemetry', String(ev?.transcript_ref)),
      'utf8',
    );
    expect(transcript).not.toContain('premise');
  });

  it('flags a non-UTF-8 response whose stored transcript cannot match its hash', () => {
    const response = Buffer.from([...Buffer.from('verdict '), 0xff]);
    const r = runCli(['record-agent', 'prior-art'], response);
    expect(r.status).toBe(0);
    const [ev] = events();
    expect(ev).toMatchObject({ output_sha256: sha(response), output_status: 'not_utf8' });
    expect(ev).not.toHaveProperty('transcript_ref');
  });

  it('keeps a UTF-8 byte-order mark in the stored request', () => {
    const request = '\uFEFFpremise';
    const requestFile = path.join(dir, 'bom.txt');
    writeFileSync(requestFile, request);
    runCli(['record-agent', 'prior-art', '--request-file', requestFile], 'verdict');
    const [ev] = events();
    expect(ev).toMatchObject({ request_sha256: sha(request), input_chars: request.length });
    const transcript = readFileSync(
      path.join(dir, 'telemetry', String(ev?.transcript_ref)),
      'utf8',
    );
    expect(transcript).toContain(request);
  });

  it('gives identical invocations distinct ids even when a ship owns both', () => {
    const a = receipt(runCli(['record-agent', 'prior-art'], 'same'));
    const b = receipt(runCli(['record-agent', 'prior-art'], 'same'));
    expect(a.invocation_id).not.toBe(b.invocation_id);
    expect(a.output_sha256).toBe(b.output_sha256);
    const [first, second] = events();
    expect(first).toMatchObject({ ship_id: 'ship-ra', invocation_id: a.invocation_id });
    expect(second).toMatchObject({ ship_id: 'ship-ra', invocation_id: b.invocation_id });
  });

  it('keeps a stdin-only caller working, with no request hash', () => {
    const r = runCli(['record-agent', 'prior-art', '--model', 'opus'], 'verdict');
    expect(r.status).toBe(0);
    const [ev] = events();
    expect(ev).toMatchObject({ judge: 'prior-art', model: 'opus', input_chars: 0 });
    expect(ev).not.toHaveProperty('request_sha256');
    expect(receipt(r)).toMatchObject({ telemetry: 'written', output_sha256: sha('verdict') });
  });

  it('still records the run when the request file is unreadable', () => {
    const r = runCli(['record-agent', 'prior-art', '--request-file', path.join(dir, 'gone')], 'v');
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('cannot read --request-file');
    expect(events()[0]).toMatchObject({ request_status: 'unreadable', outcome: 'ok' });
    expect(receipt(r)).toMatchObject({ request_status: 'unreadable' });
  });

  it('reports a dark or failing sink in the receipt instead of claiming a write', () => {
    const off = runCli(['record-agent', 'prior-art'], 'v', {
      DEVKIT_GATE_EVENTS: '',
      DEVKIT_NO_TELEMETRY: '1',
    });
    expect(off.status).toBe(0);
    expect(receipt(off)).toMatchObject({ telemetry: 'disabled', transcript_ref: null });

    const notADir = path.join(dir, 'file');
    writeFileSync(notADir, 'x');
    const broken = runCli(['record-agent', 'prior-art'], '', {
      DEVKIT_GATE_EVENTS: path.join(notADir, 'events.jsonl'),
    });
    expect(broken.status).toBe(0);
    expect(receipt(broken)).toMatchObject({ telemetry: 'failed' });
  });
});
