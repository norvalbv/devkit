import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readShipEvents, render, summarise } from '../../../cli/lib/ship/digest/gate-digest.mts';
import { runCompleteness } from '../completeness.mts';
import {
  cleanupReviewFixtures,
  consumerRepo,
  messageFile,
  mkExec,
} from './run-review-fixtures.mts';

const ENV_KEYS = [
  'GUARD_AI_STRICT',
  'GUARD_COMPLETENESS_HARD',
  'DEVKIT_GATE_EVENTS',
  'DEVKIT_SHIP_ID',
  'DEVKIT_SHIP_BRANCH',
] as const;

const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
let sink = '';

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  // An explicit sink wins over the suite-wide DEVKIT_NO_TELEMETRY=1 (run-context.mts: the flag
  // disables only the automatic every-commit capture; a ship's explicit sink still emits).
  sink = join(mkdtempSync(join(tmpdir(), 'completeness-verdict-')), 'gate-events.jsonl');
  process.env.DEVKIT_GATE_EVENTS = sink;
  process.env.DEVKIT_SHIP_ID = 'ship-completeness-verdict';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanupReviewFixtures();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.restoreAllMocks();
});

/** The fields these assertions read off the sink — the wire contract, not the whole row. */
interface WireEvent {
  type?: string;
  status?: string;
  gate?: string;
  family?: string;
  detail?: string;
  cause?: string;
  ship_id?: string;
  secs?: number;
  tally?: { critical: number; important: number };
}

const events = (): WireEvent[] => {
  const lines = readFileSync(sink, 'utf8').trim().split('\n').filter(Boolean);
  // SAFETY: every WireEvent field is optional, so a row of any shape reads as absent fields rather
  // than a throw, and the assertions below name the fields each one requires.
  return lines.map((l) => JSON.parse(l) as WireEvent);
};

/** A two-finding FAIL: the verdict reason names the CRITICAL finding, never the IMPORTANT one. */
const twoFindings = mkExec(async () =>
  [
    'CRITICAL: moving an importer does not enforce aliases | cli/move.mts | breaks imports',
    'IMPORTANT: guidance still says every import is rewritten | skills/using-devkit/SKILL.md:59',
    'LOW: a nicer error message | cli/move.mts',
    'ISSUES: 1 critical, 1 important, 1 low',
    'VERDICT: FAIL — moving an importer does not enforce aliases',
  ].join('\n'),
);

const verdicts = () => events().filter((e) => e.type === 'gate_result');
const nonRuns = () => events().filter((e) => e.type === 'gate_infra_failure');

describe('completeness verdict telemetry', () => {
  it('emits a fail review_result carrying the reason, beside the printed finding', async () => {
    const repo = consumerRepo({ backend: true });
    const exec = mkExec(async () => 'VERDICT: FAIL — no migration for the new column');

    expect(await runCompleteness(messageFile(repo, 'feat: add column'), repo, { exec })).toBe(1);

    expect(verdicts()).toHaveLength(1);
    expect(verdicts()[0]).toMatchObject({
      type: 'gate_result',
      gate: 'completeness',
      // The token the ship script publishes as blocked_gate for this chain — what lets a reader
      // join a per-gate row to a family-level verdict.
      family: 'review',
      status: 'fail',
      detail: 'no migration for the new column',
      ship_id: 'ship-completeness-verdict',
    });
    expect(verdicts()[0].secs).toBeTypeOf('number');
  });

  it('a multi-gap FAIL prints every gap and records the verdict reason, not the first gap line', async () => {
    const repo = consumerRepo({ backend: true });
    const raw = [
      'CRITICAL: reauth drops the provider | src/auth.ts | nimbus reauths into stellar',
      'IMPORTANT: the test locks the providerless shape | src/__tests__/auth.test.ts',
      'ISSUES: 1 critical, 1 important, 0 low',
      'VERDICT: FAIL — reauth drops the provider; 2 gaps',
    ].join('\n');
    const exec = mkExec(async () => raw);

    expect(await runCompleteness(messageFile(repo, 'feat: reauth'), repo, { exec })).toBe(1);
    expect(verdicts()[0]).toMatchObject({
      status: 'fail',
      detail: 'reauth drops the provider; 2 gaps',
    });
    const printed = vi.mocked(console.error).mock.calls.flat().join('\n');
    expect(printed).toContain('IMPORTANT: the test locks the providerless shape');
  });

  it('still emits the fail row when GUARD_COMPLETENESS_HARD=0 softens the exit to 0', async () => {
    // The softened run is precisely the one whose reader has nothing else to go on: it exits 0, so
    // no remediation is printed and no exit code carries the finding.
    process.env.GUARD_COMPLETENESS_HARD = '0';
    const repo = consumerRepo({ backend: true });
    const exec = mkExec(async () => 'VERDICT: FAIL — the rollback path is untested');

    expect(await runCompleteness(messageFile(repo, 'feat: soften'), repo, { exec })).toBe(0);
    expect(verdicts()[0]).toMatchObject({
      status: 'fail',
      detail: 'the rollback path is untested',
    });
  });

  it('tallies every CRITICAL and IMPORTANT finding, since the reason names only one', async () => {
    process.env.GUARD_COMPLETENESS_HARD = '0';
    const repo = consumerRepo({ backend: true });

    expect(
      await runCompleteness(messageFile(repo, 'feat: move'), repo, { exec: twoFindings }),
    ).toBe(0);
    expect(verdicts()[0]).toMatchObject({ status: 'fail', tally: { critical: 1, important: 1 } });
  });

  // Each side is tested alone; this pins the field name the emitter writes to the one the digest reads.
  it('reaches the ship digest as a counted row through the real sink', async () => {
    const repo = consumerRepo({ backend: true });
    expect(
      await runCompleteness(messageFile(repo, 'feat: move'), repo, { exec: twoFindings }),
    ).toBe(1);

    const ship = 'ship-completeness-verdict';
    const rows = summarise(
      [
        ...readShipEvents(sink, ship),
        { ship_id: ship, type: 'ship_result', blocked_gate: 'review' },
      ],
      ship,
    );
    expect(render(rows)).toContain(
      '✗ completeness — BLOCKED this run: moving an importer does not enforce aliases · 2 findings (1 critical, 1 important)',
    );
  });

  it('emits one inconclusive row naming the machine cause on a judge timeout', async () => {
    process.env.GUARD_AI_STRICT = '1';
    const repo = consumerRepo({ backend: true });
    const exec = mkExec(async (opts) => {
      opts.onOutage?.({ kind: 'timeout', permanent: true });
      return null;
    });

    expect(await runCompleteness(messageFile(repo, 'feat: outage'), repo, { exec })).toBe(3);

    // A gate that reached no verdict produced no outcome, so it takes its OWN event type rather
    // than a status on gate_result. ONE row, above the strict/fail-open split.
    expect(verdicts()).toHaveLength(0);
    expect(nonRuns()).toHaveLength(1);
    expect(nonRuns()[0]).toMatchObject({ gate: 'completeness', cause: 'timeout' });
  });

  it("carries the judge's own cause, so an empty response is not reported as an outage", async () => {
    // 'empty' is a HEALTHY judge whose response broke its contract. Collapsing it into 'outage'
    // sends a reader to check auth and quota on a CLI that answered fine.
    const repo = consumerRepo({ backend: true });
    const exec = mkExec(async (opts) => {
      opts.onOutage?.({ kind: 'empty', permanent: false });
      return null;
    });

    expect(await runCompleteness(messageFile(repo, 'feat: empty'), repo, { exec })).toBe(2);
    expect(nonRuns()[0]).toMatchObject({ gate: 'completeness', cause: 'empty' });
  });

  it('distinguishes a transient outage from a timeout by cause, not by exit code', async () => {
    const repo = consumerRepo({ backend: true });
    const exec = mkExec(async (opts) => {
      opts.onOutage?.({ kind: 'transient', permanent: false });
      return null;
    });

    expect(await runCompleteness(messageFile(repo, 'feat: transient'), repo, { exec })).toBe(2);
    expect(nonRuns()[0]).toMatchObject({ gate: 'completeness', cause: 'transient' });
  });

  it('emits the successful outcome too — a fail rate needs a denominator this gate reports', async () => {
    const repo = consumerRepo({ backend: true });
    const exec = mkExec(async () => 'VERDICT: PASS — nothing missing');

    expect(await runCompleteness(messageFile(repo, 'feat: clean'), repo, { exec })).toBe(0);
    expect(verdicts()).toHaveLength(1);
    expect(verdicts()[0]).toMatchObject({ gate: 'completeness', status: 'pass' });
  });

  it('treats a response with no parseable verdict as a non-run, not a verdict', async () => {
    const repo = consumerRepo({ backend: true });
    const exec = mkExec(async () => 'it all seems fine to me, honestly');

    expect(await runCompleteness(messageFile(repo, 'feat: unparseable'), repo, { exec })).toBe(2);
    expect(verdicts()).toHaveLength(0);
    expect(nonRuns()[0]).toMatchObject({ gate: 'completeness', cause: 'response_contract' });
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain(
      'guard-review: completeness inconclusive — no VERDICT line (fail-open, not cached)',
    );
  });

  it('fails a verdict-less judge closed under strict ship, with the transcript and remedy', async () => {
    process.env.GUARD_AI_STRICT = '1';
    const repo = consumerRepo({ backend: true });
    const exec = mkExec(async () => 'it all seems fine to me, honestly');
    const msg = messageFile(repo, 'feat: unparseable strict');

    expect(await runCompleteness(msg, repo, { exec })).toBe(3);
    const stderr = vi.mocked(console.error).mock.calls.flat().join('\n');
    expect(stderr).toContain(
      'guard-review: completeness INCONCLUSIVE (no VERDICT line) — strict ship mode fails closed',
    );
    expect(stderr).toContain('it all seems fine to me, honestly');
    expect(stderr).toContain('Remedy: the judge response did not satisfy its declared contract');
    expect(verdicts()).toHaveLength(0);
    expect(nonRuns()).toHaveLength(1);
    // Never cached: a retry pays for a fresh judgement rather than replaying a non-run.
    expect(await runCompleteness(msg, repo, { exec })).toBe(3);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  // The sink's tear-freedom rests on one sub-4KB atomic append per event, and this gate runs
  // CONCURRENTLY with the fleet — an unbounded line corrupts another judge's row, not just its own.
  it('bounds model-supplied verdict prose so one event stays an atomic append', async () => {
    const repo = consumerRepo({ backend: true });
    const exec = mkExec(async () => `VERDICT: FAIL — ${'x'.repeat(8000)}`);

    expect(await runCompleteness(messageFile(repo, 'feat: verbose'), repo, { exec })).toBe(1);
    const line = readFileSync(sink, 'utf8')
      .trim()
      .split('\n')
      .find((l) => l.includes('"gate":"completeness"'));
    expect(line).toBeDefined();
    expect((line ?? '').length).toBeLessThan(4096);
  });
});
