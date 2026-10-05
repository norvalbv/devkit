// Spawned through the real CLI; an explicit DEVKIT_GATE_EVENTS opts the run into telemetry.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

const CLI = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'review',
  'cli.mts',
);

let dir: string;
let sink: string;

function feedback(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync('node', [CLI, 'record-feedback', 'prior-art', ...args], {
    encoding: 'utf8',
    env: { ...process.env, DEVKIT_GATE_EVENTS: sink, DEVKIT_SHIP_ID: 'ship-fb', ...env },
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** A gate-event line or receipt: one flat JSON object of scalars, as emitGateEvent writes it. */
type Line = Record<string, string | number | boolean | null>;

function parseLine(text: string): Line {
  // SAFETY: every line under test was written by emitGateEvent or a receipt, both flat scalar objects.
  return JSON.parse(text) as Line;
}

/** The feedback lines only; the seeded judge_exec run is fixture, not output. */
function events(): Line[] {
  try {
    return readFileSync(sink, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(parseLine)
      .filter((ev) => ev.type === 'agent_feedback');
  } catch {
    return [];
  }
}

const run = randomUUID();
const valid = ['--run', run, '--claimed-verdict', 'DISSOLVE_FRAME', '--source', 'root'];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'record-feedback-'));
  sink = path.join(dir, 'telemetry', 'gate-events.jsonl');
  mkdirSync(path.dirname(sink), { recursive: true });
  // The run every correction below cites, as record-agent would have written it.
  writeFileSync(
    sink,
    `${JSON.stringify({ type: 'judge_exec', judge: 'prior-art', invocation_id: run })}\n`,
  );
});

describe('guard-review record-feedback prior-art', () => {
  it('appends conflicting claims side by side, the later one naming what it supersedes', () => {
    const first = feedback([
      ...valid,
      '--claimed-framing',
      'DISSOLVES',
      '--reason',
      'policy says raw lines',
    ]);
    expect(first.status).toBe(0);
    const { feedback_id: firstId, telemetry } = parseLine(first.stdout);
    expect(telemetry).toBe('written');
    const before = readFileSync(sink, 'utf8');

    const second = feedback([
      '--run',
      run,
      '--claimed-verdict',
      'GENUINE_NEW_WORK',
      '--supersedes',
      String(firstId),
      '--source',
      'user',
      '--reason',
      'policy excludes comments after all',
    ]);
    expect(second.status).toBe(0);

    expect(readFileSync(sink, 'utf8').startsWith(before)).toBe(true);
    const [a, b, ...rest] = events();
    expect(rest).toEqual([]);
    expect(a).toMatchObject({
      type: 'agent_feedback',
      judge: 'prior-art',
      invocation_id: run,
      feedback_id: firstId,
      claimed_verdict: 'DISSOLVE_FRAME',
      claimed_framing: 'DISSOLVES',
      feedback_source: 'root',
    });
    expect(a).not.toHaveProperty('supersedes');
    expect(b).toMatchObject({ invocation_id: run, supersedes: firstId, feedback_source: 'user' });
    // A claim, never a label: nothing on the line reads as ground truth.
    for (const ev of [a, b])
      for (const key of Object.keys(ev ?? {})) expect(key).not.toMatch(/gold|label/);
  });

  it.each([
    [
      'an unknown verdict',
      ['--run', run, '--claimed-verdict', 'SORT_OF', '--source', 'root', '--reason', 'r'],
    ],
    ['a missing run', ['--claimed-verdict', 'DISSOLVE_FRAME', '--source', 'root', '--reason', 'r']],
    [
      'a malformed run',
      [
        '--run',
        'agent-1',
        '--claimed-verdict',
        'DISSOLVE_FRAME',
        '--source',
        'root',
        '--reason',
        'r',
      ],
    ],
    ['a missing source', ['--run', run, '--claimed-verdict', 'DISSOLVE_FRAME', '--reason', 'r']],
    ['a blank reason', [...valid, '--reason', '  ']],
    ['an oversized reason', [...valid, '--reason', 'x'.repeat(401)]],
    ['an unknown flag', [...valid, '--reason', 'r', '--gold', 'yes']],
  ])('rejects %s with exit 2 and appends nothing', (_name, args) => {
    const r = feedback(args);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Usage: guard-review record-feedback prior-art');
    expect(events()).toEqual([]);
  });

  it('replaces a fabricated commit run id, yet lets an owning ship keep its own', () => {
    feedback([...valid, '--reason', 'r'], { DEVKIT_SHIP_ID: '' });
    feedback([...valid, '--reason', 'r']);
    const [adHoc, owned] = events();
    expect(String(adHoc?.ship_id)).toMatch(/^feedback-/);
    expect(adHoc).toMatchObject({ run_mode: 'agent' });
    expect(owned).toMatchObject({ ship_id: 'ship-fb', invocation_id: run });
  });

  it('rejects a run or superseded feedback the sink never recorded', () => {
    const otherRun = randomUUID();
    expect(feedback(['--run', otherRun, ...valid.slice(2), '--reason', 'r']).status).toBe(2);
    expect(feedback([...valid, '--supersedes', randomUUID(), '--reason', 'r']).status).toBe(2);
    // A feedback_id from a DIFFERENT run cannot be superseded from this one.
    writeFileSync(
      sink,
      `${JSON.stringify({ type: 'judge_exec', judge: 'prior-art', invocation_id: otherRun })}\n`,
      { flag: 'a' },
    );
    const elsewhere = parseLine(
      feedback(['--run', otherRun, ...valid.slice(2), '--reason', 'r']).stdout,
    ).feedback_id;
    const crossed = feedback([...valid, '--supersedes', String(elsewhere), '--reason', 'r']);
    expect(crossed.status).toBe(2);
    expect(crossed.stderr).toContain(`no feedback ${String(elsewhere)} on run ${run}`);
    expect(events()).toHaveLength(1);
  });

  it('rejects every reference when telemetry is off, since none can be resolved', () => {
    const r = feedback([...valid, '--reason', 'r'], {
      DEVKIT_GATE_EVENTS: '',
      DEVKIT_NO_TELEMETRY: '1',
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('telemetry is off');
  });

  it('exits 0 and says so when the sink cannot be written', () => {
    chmodSync(sink, 0o444);
    const r = feedback([...valid, '--reason', 'r']);
    expect(r.status).toBe(0);
    expect(parseLine(r.stdout)).toMatchObject({ telemetry: 'failed' });
  });
});

describe('record-feedback reference resolution edge cases', () => {
  const RECORD_AGENT = (input: string) =>
    spawnSync('node', [CLI, 'record-agent', 'prior-art'], {
      input,
      encoding: 'utf8',
      env: { ...process.env, DEVKIT_GATE_EVENTS: sink, DEVKIT_SHIP_ID: 'ship-fb' },
    }).stdout;

  it('resolves the invocation_id a real record-agent receipt printed', () => {
    // Wiring: both commands must agree on the event type, judge and key name.
    const { invocation_id: id } = parseLine(RECORD_AGENT('{"verdict":"GENUINE_NEW_WORK"}'));
    const r = feedback([
      '--run',
      String(id),
      ...valid.slice(2),
      '--reason',
      'policy says otherwise',
    ]);
    expect(r.status).toBe(0);
    expect(events()).toEqual([expect.objectContaining({ invocation_id: id })]);
  });

  it('rejects a run recorded under another agent label', () => {
    const other = randomUUID();
    const line = { type: 'judge_exec', judge: 'feature-critique', invocation_id: other };
    writeFileSync(sink, `${JSON.stringify(line)}\n`, { flag: 'a' });
    const r = feedback(['--run', other, ...valid.slice(2), '--reason', 'r']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(`no prior-art run ${other}`);
  });

  it('looks past a truncated line and a mere mention of the id to the real run', () => {
    // A writer killed mid-append leaves a partial line; the id can also sit inside other text.
    const mention = { type: 'agent_feedback', judge: 'prior-art', reason: `see ${run}` };
    const real = { type: 'judge_exec', judge: 'prior-art', invocation_id: run };
    writeFileSync(
      sink,
      `{"type":"judge_exec","judge":"prior-art","invocation_id":"${run}\n` +
        `${JSON.stringify(mention)}\n${JSON.stringify(real)}`, // no trailing newline on the last line
    );
    expect(feedback([...valid, '--reason', 'r']).status).toBe(0);
  });

  it('counts the reason cap in characters, so 400 emoji fit', () => {
    expect(feedback([...valid, '--reason', '🙂'.repeat(400)]).status).toBe(0);
    expect(feedback([...valid, '--reason', '🙂'.repeat(401)]).status).toBe(2);
  });

  it('reports an unreadable sink as unreadable, not as a missing run', () => {
    const r = feedback([...valid, '--reason', 'r'], { DEVKIT_GATE_EVENTS: dir });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('cannot read the telemetry sink');
  });
});
