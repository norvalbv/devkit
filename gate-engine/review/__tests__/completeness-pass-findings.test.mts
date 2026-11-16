import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, summarise } from '../../../cli/lib/ship/digest/gate-digest.mts';
import { execJudgeAsync } from '../../judge/run-judge.mts';
import { runCompleteness } from '../completeness.mts';
import { reportAdvisories } from '../evidence/base-context.mts';
import {
  cleanupReviewFixtures,
  consumerRepo,
  messageFile,
  mkExec,
} from './run-review-fixtures.mts';

const SHIP = 'ship-completeness-findings';
const REF = `transcripts/${SHIP}/review-completeness.txt`;
const BODY_GAP =
  'LOW: The PR body calls an explicit-destination pin a "plain fetch" | commit message';
const CODE_GAP = 'LOW: `dirs` is unreachable in its false branch | src/main/a.ts:3';
const PASSED = [
  '- **IMPORTANT**: the rollback path has no test | src/main/a.ts',
  '  a context line the brief allows, which only the transcript keeps',
  BODY_GAP,
  CODE_GAP,
  'ISSUES: 0 critical, 1 important, 2 low',
  'VERDICT: PASS — the change does what its message claims',
].join('\n');

let sink = '';
beforeEach(() => {
  sink = join(mkdtempSync(join(tmpdir(), 'completeness-findings-')), 'gate-events.jsonl');
  vi.stubEnv('DEVKIT_GATE_EVENTS', sink);
  vi.stubEnv('DEVKIT_SHIP_ID', SHIP);
  vi.stubEnv('DEVKIT_SHIP_BRANCH', 'feat/findings');
  vi.stubEnv('GUARD_AI_STRICT', '');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanupReviewFixtures();
  rmSync(dirname(sink), { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const printed = () => vi.mocked(console.error).mock.calls.map((c) => String(c[0]));
const events = () =>
  readFileSync(sink, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const advisoryRows = () => events().filter((e) => e.type === 'advisory_result');

function judge(output: string) {
  return mkExec(async (opts) => {
    opts.onTranscript?.(REF);
    return output;
  });
}

describe('a completeness PASS with findings', () => {
  it('prints every finding whole, located or not, under a PASS line naming its transcript', async () => {
    const repo = consumerRepo({ backend: true });
    const msg = messageFile(repo, 'fix(ship): pin the --base');
    expect(await runCompleteness(msg, repo, { exec: judge(PASSED) })).toBe(0);

    const lines = printed();
    expect(lines.find((l) => l.includes('completeness — PASS'))).toMatch(
      new RegExp(` · transcript ${REF}$`),
    );
    expect(lines).toEqual(
      expect.arrayContaining([
        'guard-review: completeness — advisory (non-blocking): IMPORTANT: the rollback path has no test | src/main/a.ts',
        `guard-review: completeness — advisory (non-blocking): ${BODY_GAP}`,
        `guard-review: completeness — advisory (non-blocking): ${CODE_GAP}`,
        `guard-review: completeness — full reasoning: guard-review transcript ${REF}`,
      ]),
    );
    expect(lines.some((l) => l.includes('a context line'))).toBe(false);
    expect(advisoryRows()).toHaveLength(3);
    expect(advisoryRows()).toEqual(
      Array(3).fill(expect.objectContaining({ gate: 'review:completeness', status: 'finding' })),
    );
    expect(render(summarise(events(), SHIP))).toContain(
      '⚠ review:completeness — advisory, did NOT block this run',
    );
  });

  it('replays the stored findings when a re-ship is served from the sticky PASS', async () => {
    const repo = consumerRepo({ backend: true });
    const msg = messageFile(repo, 'fix(ship): pin the --base');
    await runCompleteness(msg, repo, { exec: judge(PASSED) });
    vi.mocked(console.error).mockClear();

    const exec = judge('VERDICT: FAIL — must not be asked again');
    expect(await runCompleteness(msg, repo, { exec })).toBe(0);
    expect(exec).not.toHaveBeenCalled();
    expect(printed()).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/completeness — cached PASS/),
        `guard-review: completeness — advisory (non-blocking): ${BODY_GAP}`,
      ]),
    );
    expect(advisoryRows()).toHaveLength(6); // three live, three replayed
  });

  it('stays at one line with the ref, and emits nothing advisory, when it found nothing', async () => {
    const repo = consumerRepo({ backend: true });
    const clean = 'ISSUES: 0 critical, 0 important, 0 low\nVERDICT: PASS — complete';
    expect(await runCompleteness(messageFile(repo, 'feat: x'), repo, { exec: judge(clean) })).toBe(
      0,
    );
    expect(printed().filter((l) => l.includes('completeness'))).toEqual([
      expect.stringMatching(new RegExp(`completeness — PASS — message .* · transcript ${REF}$`)),
    ]);
    expect(advisoryRows()).toEqual([]);
  });

  it('still prints its findings off a run, but names no transcript it never stored', async () => {
    // A plain commit with telemetry off: the store writes nothing, so onTranscript never fires.
    const repo = consumerRepo({ backend: true });
    const exec = mkExec(async () => PASSED);
    expect(await runCompleteness(messageFile(repo, 'feat: x'), repo, { exec })).toBe(0);
    const lines = printed();
    expect(lines.find((l) => l.includes('completeness — PASS'))).toMatch(/ — message [^·]+$/);
    expect(lines).toContain(`guard-review: completeness — advisory (non-blocking): ${BODY_GAP}`);
    expect(lines.some((l) => l.includes('transcript'))).toBe(false);
  });
});

describe('a long or numerous finding', () => {
  const long = `a.ts:1 — ${'the withheld sentence names the gate change. '.repeat(14)}`.trim();

  it('prints a 600-char finding complete; the event and digest row mark their own cut', () => {
    expect(long.length).toBeGreaterThan(600);
    reportAdvisories('correctness-reviewer', [long], REF);
    expect(printed()[0]).toBe(
      `guard-review: correctness-reviewer — advisory (non-blocking): ${long}`,
    );
    const [row] = advisoryRows();
    expect(row.detail.length).toBeLessThanOrEqual(500);
    expect(row.detail.endsWith('…')).toBe(true);
    const digest = render(summarise(events(), SHIP));
    const line = digest.split('\n').find((l) => l.includes('correctness-reviewer')) ?? '';
    expect(line.endsWith('…')).toBe(true);
  });

  it('caps the printed lines and says how many it held back', () => {
    reportAdvisories(
      'completeness',
      Array.from({ length: 5 }, (_, i) => `LOW: gap ${i}`),
    );
    expect(printed()).toHaveLength(5); // exactly the cap: nothing held back, so no count line
    vi.mocked(console.error).mockClear();
    reportAdvisories(
      'completeness',
      Array.from({ length: 7 }, (_, i) => `LOW: gap ${i}`),
    );
    expect(printed()).toHaveLength(6);
    expect(printed()[5]).toBe(
      'guard-review: completeness — 7 findings, 5 shown; the rest are in the transcript',
    );
  });
});

describe('execJudgeAsync onTranscript', () => {
  it('hands back the ref of the transcript each spawn stored, across a same-run retry', async () => {
    const bin = dirname(sink);
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\ncat >/dev/null\necho "$JUDGE_SAYS"\n', {
      mode: 0o755,
    });
    // A retried commit on the same staged tree shares the run id; its ref must not name the first.
    const refs: string[] = [];
    for (const says of ['VERDICT: PASS — first', 'VERDICT: PASS — retry'])
      await execJudgeAsync({
        label: 'review:completeness',
        args: ['-p', 'judge'],
        input: 'diff',
        timeout: 10000,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, JUDGE_SAYS: says },
        onTranscript: (ref) => refs.push(ref),
      });
    expect(refs).toEqual([REF, REF.replace(/\.txt$/, '.2.txt')]);
    expect(readFileSync(join(bin, refs[0]), 'utf8')).toContain('PASS — first');
    expect(readFileSync(join(bin, refs[1]), 'utf8')).toContain('PASS — retry');
  });
});
