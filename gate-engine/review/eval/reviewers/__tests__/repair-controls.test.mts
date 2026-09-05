/** Executable labels live outside judge-visible trees. Each case must reproduce only in the
 * buggy postimage, with the same invariant passing in its base and repaired postimage. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scoreRow } from '../corpus/row.mts';

const rows = readFileSync(new URL('../cases-correctness.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map(JSON.parse);
const ids = [
  'corr-retry-stuck-unclaimable',
  'corr-read-then-write-clobber-terminal',
  'corr-lock-timeout-runs-unlocked',
  'corr-json-string-result-dropped',
  'corr-only-selector-silent-drop',
  'corr-asymmetric-flip-classifier',
];
function exercise(files, code) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'repair-control-'));
  try {
    for (const [file, content] of Object.entries(files)) {
      if (content === null) continue;
      const dest = path.join(cwd, file);
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, content);
    }
    return JSON.parse(
      execFileSync(process.execPath, ['--input-type=module', '--eval', code], {
        cwd,
        encoding: 'utf8',
        timeout: 30000,
      }),
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
const controls = [
  `const store = await import('./api/store/jobs.ts');
   const { retryJob } = await import('./api/jobs/retry.ts');
   const { getClaimableJobIds } = await import('./api/jobs/poller.ts');
   const job = (id, status, startMode) => ({ id, status, startMode, result: { old: true } });
   store.seedJobs([job('waiting', 'failed', 'wait'), job('normal', 'failed', 'poll'), job('active', 'running', 'wait')]);
   await retryJob('waiting'); await retryJob('normal'); await retryJob('active'); await retryJob('missing');
   console.log(JSON.stringify({ claimable: await getClaimableJobIds(), active: (await store.getJob('active')).status }));`,
  `const store = await import('./api/store/jobs.ts');
   const { persistSignal } = await import('./api/jobs/persist-signal.ts');
   store.seedJobs([{ id: 'r', status: 'running' }]);
   const signal = persistSignal('r', 'queued');
   await store.updateJobStatus('r', 'cancelled'); await signal;
   const interleaved = (await store.getJob('r')).status;
   store.seedJobs([{ id: 'r', status: 'running' }]);
   const happy = await persistSignal('r', 'queued');
   await store.updateJobStatus('r', 'done');
   console.log(JSON.stringify({ interleaved, happy, terminal: await persistSignal('r', 'queued'), missing: await persistSignal('missing', 'queued') }));`,
  `const { mkdirSync, existsSync, rmSync } = await import('node:fs');
   const { withLock } = await import('./src/manifest/with-lock.ts');
   mkdirSync('owned'); let called = false, timedOut = false;
   const realNow = Date.now; let clock = 0; Date.now = () => (clock += 3000);
   try { withLock('owned', () => { called = true; }); } catch (e) { timedOut = /timed out/.test(e.message); }
   finally { Date.now = realNow; }
   const ownerRetained = existsSync('owned'); rmSync('owned', { recursive: true });
   const happy = withLock('free', () => existsSync('free'));
   let callbackError = false; try { withLock('throws', () => { throw new Error('callback'); }); } catch (e) { callbackError = e.message === 'callback'; }
   console.log(JSON.stringify({ called, timedOut, ownerRetained, happy, released: !existsSync('free') && !existsSync('throws'), callbackError }));`,
  `const store = await import('./api/store/jobs.ts');
   const { resolveTransition } = await import('./api/jobs/transition.ts');
   const output = [];
   for (const result of ['{"child":"child-1","startMode":"wait"}', { child: 'child-1' }, 'invalid', null]) {
     store.seedJobs([{ id: 'r', status: 'running', result }]);
     await resolveTransition('r', { status: 'done' }); output.push((await store.getJob('r')).result);
   }
   await resolveTransition('missing', { status: 'done' });
   console.log(JSON.stringify(output));`,
  `const { runSelected } = await import('./src/gate/select.ts');
   console.log(JSON.stringify([runSelected({ only: [] }, ['size']), runSelected({ only: ['typo'] }, ['size']), runSelected({ only: ['dup'] }, ['size']), runSelected({}, ['size'])]));`,
  `const { classifyFlip } = await import('./src/bench/classify-flip.ts');
   console.log(JSON.stringify(classifyFlip([{ lost: 1, gained: 0, prevOk: true, curOk: true }, { lost: 0, gained: 1, prevOk: true, curOk: true }, { lost: 1, gained: 1, prevOk: false, curOk: true }, { lost: 0, gained: 0, prevOk: false, curOk: false }])));`,
];
function check(index, observed, buggy) {
  if (index === 0)
    expect(observed).toEqual({
      claimable: buggy ? ['normal'] : ['waiting', 'normal'],
      active: 'running',
    });
  if (index === 1)
    expect(observed).toEqual({
      interleaved: buggy ? 'queued' : 'cancelled',
      happy: true,
      terminal: false,
      missing: false,
    });
  if (index === 2)
    expect(observed).toEqual({
      called: buggy,
      timedOut: !buggy,
      ownerRetained: true,
      happy: true,
      released: true,
      callbackError: true,
    });
  if (index === 3)
    expect(observed).toEqual([
      buggy ? { lastSignal: 'done' } : { child: 'child-1', startMode: 'wait', lastSignal: 'done' },
      { child: 'child-1', lastSignal: 'done' },
      { lastSignal: 'done' },
      { lastSignal: 'done' },
    ]);
  if (index === 4) {
    expect(observed[0].fails.length > 0).toBe(!buggy);
    expect(observed[1].fails.length > 0).toBe(!buggy);
    expect(observed[2]).toEqual({ ids: ['dup'], fails: [] });
    expect(observed[3]).toEqual({ ids: ['size'], fails: [] });
  }
  if (index === 5) expect(observed).toEqual({ regressions: 1, improvements: buggy ? 0 : 1 });
}
const reportControl = `const { runReport } = await import('./src/report/command.ts');
 const row = { id: 'sample', expected: 'PASS', firstVerdict: 'PASS', okFirst: true, okFinal: true, rowHash: 'same', repo: { base: {}, staged: { 'src/a.ts': 'export const value = 1;' } }, ms: { first: 1000, escalate: 0 } };
 const input = { rows: [row], previous: { sample: row }, deltas: [{ lost: 0, gained: 1, prevOk: true, curOk: true }], files: { 'src/a.ts': '// summary' }, plan: [{ reviewer: { model: 'test' }, rows: [row] }], settings: { model: 'test', cascade: false, concurrency: 1, dev: false, resuming: 0, table: { test: 1 }, escalateSecs: 0, note: 'summary' }, comparisons: [{ name: 'depth', summary: { accuracy: 100, model: 'test', rows: {} }, base: { accuracy: 100, model: 'test', rows: {} } }] };
 const all = runReport(input); const empty = runReport({ ...input, only: [] }); const typo = runReport({ ...input, only: ['typo'] });
 const slow = { ...row, id: 'slow', ms: { first: 9000, escalate: 0 } };
 const mixed = runReport({ ...input, rows: [row, slow], plan: [{ reviewer: { model: 'fast' }, rows: [row] }, { reviewer: { model: 'slow' }, rows: [slow] }], settings: { ...input.settings, table: { fast: 1, slow: 9 } } });
 const legacy = runReport({ ...input, previous: { sample: { okFirst: true } } });
 const invalid = [runReport({ ...input, rows: [{ ...row, caseId: 0 }] }), runReport({ ...input, comparisons: [{ name: 'alignment', summary: { cascade: true }, base: null }] })];
 console.log(JSON.stringify({ names: Object.keys(all.reports), summary: all.reports.size.summary.firstCleanPass, families: all.reports.fanout.families, tally: all.reports.fanout.tally, drift: all.reports.structure.drift, check: all.reports.structure.checks[0].regressed, empty: empty.exitCode, typo: typo.exitCode, timing: mixed.reports.size.timing, legacyDrift: legacy.reports.structure.drift, invalid: invalid.map(result => result.exitCode) }));`;

describe('sc-2500 executable repair controls', () => {
  it('separates expected-lens blocking from diagnosis of the classifier target (sc-2831)', () => {
    const gold = rows.find((r) => r.id === 'corr-asymmetric-flip-classifier');
    const repair = rows.find((r) => r.id === `${gold.id}-repaired`);
    const file = 'src/bench/classify-flip.ts';
    const probe = `const { classifyFlip } = await import('./src/bench/classify-flip.ts');
      console.log(JSON.stringify({
        other: classifyFlip([{ lost: 0, gained: 1, prevOk: true, curOk: false }]),
        target: classifyFlip([
          { lost: 1, gained: 0, prevOk: true, curOk: true },
          { lost: 0, gained: 1, prevOk: true, curOk: true }
        ])
      }));`;
    for (const [files, improvements] of [
      [gold.repo.base, 1],
      [{ ...gold.repo.base, ...gold.repo.staged }, 0],
      [{ ...repair.repo.base, ...repair.repo.staged }, 1],
    ])
      expect(exercise(files, probe)).toEqual({
        other: { regressions: 0, improvements: 1 },
        target: { regressions: 1, improvements },
      });

    const source = gold.repo.staged[file];
    expect(source.split('r.prevOk !== r.curOk')).toHaveLength(2);
    const counterfactual = source.replace(
      'r.prevOk !== r.curOk',
      'r.prevOk === false && r.curOk === true',
    );
    expect(
      exercise({ ...gold.repo.base, ...gold.repo.staged, [file]: counterfactual }, probe),
    ).toEqual({
      other: { regressions: 0, improvements: 0 },
      target: { regressions: 1, improvements: 0 },
    });

    const proxy = scoreRow(
      gold,
      [
        {
          label: `review:${gold.reviewer}`,
          out: 'VERDICT: FAIL',
          ms: 0,
          snapshot: {
            items: [
              {
                name: gold.expectItems[0],
                status: 'fail',
                issues: ['Other classification concern'],
              },
            ],
          },
        },
      ],
      { status: 'fail' },
    );
    expect(proxy).toMatchObject({ okFirst: true, okFinal: true, reasonClass: 'right-item' });
  });

  it('JSON repair preserves the base behavior; the terminal-status race predates both diffs', () => {
    const gold = rows.find((r) => r.id === ids[3]);
    const repair = rows.find((r) => r.id === `${ids[3]}-repaired`);
    expect(repair.repo.staged['api/jobs/transition.ts']).toBe(
      repair.repo.base['api/jobs/transition.ts'].replaceAll('jobId', 'id'),
    );
    const interleave = `const store = await import('./api/store/jobs.ts');
      const { resolveTransition } = await import('./api/jobs/transition.ts');
      store.seedJobs([{ id: 'r', status: 'running', result: {} }]);
      const pending = resolveTransition('r', { status: 'queued' });
      await store.updateJob('r', { status: 'cancelled' }); await pending;
      console.log(JSON.stringify((await store.getJob('r')).status));`;
    for (const files of [
      gold.repo.base,
      { ...gold.repo.base, ...gold.repo.staged },
      { ...repair.repo.base, ...repair.repo.staged },
    ])
      expect(exercise(files, interleave)).toBe('queued');
  });

  it('all large-family contexts exclude unstable and unscored flips and disclose legacy hashes', () => {
    const control = `const { runReport } = await import('./src/report/command.ts');
      const row = (id, extra = {}) => ({ id, expected: 'PASS', okFirst: false, rowHash: 'same', ...extra });
      const input = { only: ['structure'], rows: [], previous: {}, deltas: [], files: {}, plan: [], settings: {}, comparisons: [] };
      const report = (rows, previous) => runReport({ ...input, rows, previous }).reports.structure.contrast;
      const unstable = Array.from({ length: 6 }, (_, i) => row('u' + i, { stable: false }));
      const unscored = Array.from({ length: 6 }, (_, i) => row('n' + i, { expected: 'NULL' }));
      const previous = rows => Object.fromEntries(rows.map(r => [r.id, { ...r, okFirst: true }]));
      const legacy = report([row('legacy')], { legacy: { okFirst: true } });
      const stableLosses = Object.fromEntries(Array.from({ length: 5 }, (_, i) => ['l' + i, { expected: 'PASS', ok: false, stable: true }]));
      const current = { ...stableLosses, gain: { expected: 'PASS', ok: true, stable: false } };
      const base = Object.fromEntries(Object.entries(current).map(([id, r]) => [id, { ...r, ok: !r.ok }]));
      const comparison = runReport({ ...input, comparisons: [{ name: 'depth', summary: { accuracy: 90, rows: current }, base: { accuracy: 100, rows: base } }] }).reports.structure.checks[0];
      console.log(JSON.stringify({ unstable: report(unstable, previous(unstable)).regressed, unscored: report(unscored, previous(unscored)).regressed, legacyWarning: legacy.detail.includes('drift detection unavailable'), stableRegression: comparison.regressed }));`;
    for (const row of rows.filter((r) => r.caseId === 'corr-reporting-command-family'))
      expect(exercise({ ...row.repo.base, ...row.repo.staged }, control)).toEqual({
        unstable: false,
        unscored: false,
        legacyWarning: true,
        stableRegression: true,
      });
  });

  it('retry repair preserves the base behavior; the cancellation race predates both diffs', () => {
    const gold = rows.find((r) => r.id === ids[0]);
    const repair = rows.find((r) => r.id === `${ids[0]}-repaired`);
    expect(repair.repo.staged['api/jobs/retry.ts']).toBe(
      repair.repo.base['api/jobs/retry.ts'].replaceAll('jobId', 'id'),
    );
    const interleave = `const store = await import('./api/store/jobs.ts');
      const { retryJob } = await import('./api/jobs/retry.ts');
      store.seedJobs([{ id: 'r', status: 'failed', startMode: 'poll', result: {} }]);
      const retry = retryJob('r'); await store.updateJob('r', { status: 'cancelled' }); await retry;
      console.log(JSON.stringify((await store.getJob('r')).status));`;
    for (const files of [
      gold.repo.base,
      { ...gold.repo.base, ...gold.repo.staged },
      { ...repair.repo.base, ...repair.repo.staged },
    ])
      expect(exercise(files, interleave)).toBe('queued');
  });

  for (const [index, id] of ids.entries())
    it(id, () => {
      const gold = rows.find((r) => r.id === id),
        repair = rows.find((r) => r.id === `${id}-repaired`);
      expect(repair).toBeDefined();
      expect(repair.variantOf).toBe(id);
      expect(repair.caseId).toBe(gold.caseId);
      expect(repair.holdout).toBe(gold.holdout);
      expect(repair.repo.base).toEqual(gold.repo.base);
      for (const [name, files] of [
        ['base', gold.repo.base],
        ['bug', { ...gold.repo.base, ...gold.repo.staged }],
        ['repair', { ...repair.repo.base, ...repair.repo.staged }],
      ]) {
        check(index, exercise(files, controls[index]), name === 'bug');
        if (index >= 4 && name !== 'base') {
          const observed = exercise(files, reportControl);
          expect(observed).toEqual({
            names: ['size', 'fanout', 'dup', 'structure'],
            summary: { k: 1, n: 1 },
            families: 1,
            tally: { regressions: 0, improvements: name === 'bug' && index === 5 ? 0 : 1 },
            drift: [],
            check: false,
            empty: name === 'bug' && index === 4 ? 0 : 1,
            typo: name === 'bug' && index === 4 ? 0 : 1,
            timing: ['measured first-pass mean fast: 1s', 'measured first-pass mean slow: 9s'],
            legacyDrift: [],
            invalid: [1, 1],
          });
        }
      }
    });
});
