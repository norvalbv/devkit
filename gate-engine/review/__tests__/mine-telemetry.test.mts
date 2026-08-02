import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { collectRepoArgs, sqlite3Available, sqliteJson } from '../eval/reviewers/mine-common.mts';
import {
  buildFailFixCandidate,
  buildHistogram,
  buildWaivedCandidate,
  diffArchiveRelPath,
  findNextLensOutcome,
  findNextOutcome,
  groupShipsByRepoBranch,
  hasDiffEvidence,
  histogramKey,
  INLINE_DIFF_CAP_BYTES,
  isSameDiff,
  mergeCandidates,
  pickFailReason,
  resolveDiffPayload,
  selectFailLensRows,
  sortByTsStart,
  telemetryUrl,
} from '../eval/reviewers/mine-telemetry-lib.mts';

describe('mine-telemetry-lib: sortByTsStart', () => {
  it('sorts ascending by ts_start', () => {
    const ships = [
      { ship_id: 'b', ts_start: '2026-08-01T22:11:51.523Z' },
      { ship_id: 'a', ts_start: '2026-08-01T22:02:46.951Z' },
      { ship_id: 'c', ts_start: '2026-08-01T22:27:21.171Z' },
    ];
    expect(sortByTsStart(ships).map((s) => s.ship_id)).toEqual(['a', 'b', 'c']);
  });

  it('tiebreaks equal timestamps by ship_id for determinism', () => {
    const ships = [
      { ship_id: 'zeta', ts_start: '2026-08-01T22:00:00.000Z' },
      { ship_id: 'alpha', ts_start: '2026-08-01T22:00:00.000Z' },
    ];
    expect(sortByTsStart(ships).map((s) => s.ship_id)).toEqual(['alpha', 'zeta']);
  });

  it('does not mutate the input array', () => {
    const ships = [
      { ship_id: 'b', ts_start: '2026-08-01T22:11:51.523Z' },
      { ship_id: 'a', ts_start: '2026-08-01T22:02:46.951Z' },
    ];
    const copy = [...ships];
    sortByTsStart(ships);
    expect(ships).toEqual(copy);
  });

  it('orders a same-second millis vs no-millis tie chronologically (not lexicographically)', () => {
    // Plain string compare would put the no-millis form ("...Z") AFTER the millis form
    // ("...523Z") at this exact second, because '.' < 'Z' — inverting true chronology, since
    // the no-millis form is chronologically the earlier moment (implicit .000) of that second.
    const ships = [
      { ship_id: 'later', ts_start: '2026-08-01T22:11:51.523Z' },
      { ship_id: 'earlier', ts_start: '2026-08-01T22:11:51Z' },
    ];
    expect(sortByTsStart(ships).map((s) => s.ship_id)).toEqual(['earlier', 'later']);
  });

  it('falls back to string ordering when a timestamp fails to parse, without throwing', () => {
    const ships = [
      { ship_id: 'b', ts_start: 'not-a-date' },
      { ship_id: 'a', ts_start: '2026-08-01T22:00:00Z' },
    ];
    expect(() => sortByTsStart(ships)).not.toThrow();
    expect(
      sortByTsStart(ships)
        .map((s) => s.ship_id)
        .sort(),
    ).toEqual(['a', 'b']);
  });
});

describe('mine-telemetry-lib: groupShipsByRepoBranch', () => {
  const ships = [
    {
      ship_id: 's1',
      repo: 'devkit',
      branch: 'bench/waive-command',
      ts_start: '2026-08-01T22:02:46Z',
    },
    {
      ship_id: 's2',
      repo: 'devkit',
      branch: 'bench/waive-command',
      ts_start: '2026-08-01T22:05:26Z',
    },
    { ship_id: 's3', repo: 'devkit', branch: 'main', ts_start: '2026-08-01T22:06:00Z' },
    { ship_id: 's4', repo: 'devkit', branch: null, ts_start: '2026-08-01T22:07:00Z' },
    { ship_id: 's5', repo: 'devkit', branch: '', ts_start: '2026-08-01T22:08:00Z' },
  ];

  it('groups by repo+branch and sorts each chain by ts_start', () => {
    const { groups } = groupShipsByRepoBranch(ships);
    const chain = groups.get('devkit::bench/waive-command');
    expect(chain.map((s) => s.ship_id)).toEqual(['s1', 's2']);
    expect(groups.get('devkit::main').map((s) => s.ship_id)).toEqual(['s3']);
  });

  it('excludes null/blank branch ships and counts them', () => {
    const { groups, skippedNullBranch } = groupShipsByRepoBranch(ships);
    expect(skippedNullBranch).toBe(2);
    for (const chain of groups.values()) {
      expect(chain.some((s) => s.ship_id === 's4' || s.ship_id === 's5')).toBe(false);
    }
  });

  it('builds an indexByShipId lookup consistent with each chain', () => {
    const { groups, indexByShipId } = groupShipsByRepoBranch(ships);
    const loc = indexByShipId.get('s2');
    expect(loc).toEqual({ key: 'devkit::bench/waive-command', idx: 1 });
    expect(groups.get(loc.key)[loc.idx].ship_id).toBe('s2');
  });

  it('returns empty groups/zero skips for an empty input', () => {
    const { groups, indexByShipId, skippedNullBranch } = groupShipsByRepoBranch([]);
    expect(groups.size).toBe(0);
    expect(indexByShipId.size).toBe(0);
    expect(skippedNullBranch).toBe(0);
  });
});

describe('mine-telemetry-lib: findNextOutcome', () => {
  // Mirrors the live 5-ship devkit/bench-waive-command sequence from the scout report.
  const chain = [
    { ship_id: 's0', exit_code: 1 }, // blocked=deterministic, never reached review
    { ship_id: 's1', exit_code: 1 }, // FAIL (the anchor)
    { ship_id: 's2', exit_code: 1 }, // FAIL again — still broken
    { ship_id: 's3', exit_code: 1 }, // FAIL again
    { ship_id: 's4', exit_code: 0 }, // PASS — the fix
  ];

  it('scans past consecutive fails to find the eventual pass (does not stop at the very next ship)', () => {
    const statusOf = (shipId) => ({ s2: 'fail', s3: 'fail', s4: 'pass' })[shipId];
    expect(findNextOutcome(chain, 's1', 'correctness-reviewer', statusOf)).toEqual({
      kind: 'fixed',
      nextShipId: 's4',
    });
  });

  it('stops immediately when the very next ship already passes', () => {
    const statusOf = (shipId) => ({ s2: 'pass' })[shipId];
    expect(findNextOutcome(chain, 's1', 'correctness-reviewer', statusOf)).toEqual({
      kind: 'fixed',
      nextShipId: 's2',
    });
  });

  it('treats an absent reviewer on a clean ship as fixed-by-absence', () => {
    const statusOf = () => undefined; // reviewer never appears again
    expect(findNextOutcome(chain, 's3', 'correctness-reviewer', statusOf)).toEqual({
      kind: 'fixed',
      nextShipId: 's4',
    });
  });

  it('keeps scanning when the reviewer is absent and the ship did not ship clean', () => {
    const blockedChain = [
      { ship_id: 's1', exit_code: 1 },
      { ship_id: 's2', exit_code: 1 }, // absent + blocked → no signal
      { ship_id: 's3', exit_code: 0 }, // absent + clean → fixed-by-absence
    ];
    const statusOf = () => undefined;
    expect(findNextOutcome(blockedChain, 's1', 'r', statusOf)).toEqual({
      kind: 'fixed',
      nextShipId: 's3',
    });
  });

  it('returns no-fix-found when the chain ends without a pass', () => {
    const statusOf = () => 'fail';
    expect(findNextOutcome(chain, 's1', 'correctness-reviewer', statusOf)).toEqual({
      kind: 'no-fix-found',
      nextShipId: null,
    });
  });

  it('returns no-fix-found when the fail ship is the last in its chain (branch abandonment)', () => {
    const statusOf = () => undefined;
    expect(findNextOutcome(chain, 's4', 'correctness-reviewer', statusOf)).toEqual({
      kind: 'no-fix-found',
      nextShipId: null,
    });
  });

  it('returns no-fix-found when the anchor ship is not found in the chain', () => {
    expect(findNextOutcome(chain, 'does-not-exist', 'r', () => 'pass')).toEqual({
      kind: 'no-fix-found',
      nextShipId: null,
    });
  });
});

describe('mine-telemetry-lib: findNextLensOutcome', () => {
  // Reproduces the reported blocker: a reviewer FAILs the same ship on TWO distinct lenses, and
  // only one of them actually gets fixed by the next ship. A reviewer-level scan (findNextOutcome)
  // would wrongly report both lenses fixed once the reviewer's overall status flips to pass.
  const chain = [
    { ship_id: 's1', exit_code: 1 }, // FAIL on both lens-a and lens-b (the anchor)
    { ship_id: 's2', exit_code: 0 }, // lens-a passes; lens-b has no lens-level row at all here,
    // but the reviewer overall also passes (unrelated files touched this time).
  ];

  it('reports fixed for the lens that has its own pass row', () => {
    const lensStatusOf = (shipId, reviewer, lens) =>
      ({ 's2::r::lens-a': 'pass' })[`${shipId}::${reviewer}::${lens}`];
    const statusOf = () => 'pass';
    expect(findNextLensOutcome(chain, 's1', 'r', 'lens-a', statusOf, lensStatusOf)).toEqual({
      kind: 'fixed',
      nextShipId: 's2',
    });
  });

  it('does not blindly copy the reviewer-level pass onto a lens still reported failing', () => {
    const failingChain = [
      { ship_id: 's1', exit_code: 1 },
      { ship_id: 's2', exit_code: 0 }, // reviewer overall passes...
    ];
    const lensStatusOf = (shipId, reviewer, lens) =>
      ({ 's2::r::lens-b': 'fail' })[`${shipId}::${reviewer}::${lens}`]; // ...but lens-b itself still fails
    const statusOf = () => 'pass';
    expect(findNextLensOutcome(failingChain, 's1', 'r', 'lens-b', statusOf, lensStatusOf)).toEqual({
      kind: 'no-fix-found',
      nextShipId: null,
    });
  });

  it('falls back to reviewer-level pass when the candidate ship has no lens-level row for this lens', () => {
    const lensStatusOf = () => undefined; // no lens breakdown recorded on the candidate ship
    const statusOf = () => 'pass';
    expect(findNextLensOutcome(chain, 's1', 'r', 'lens-b', statusOf, lensStatusOf)).toEqual({
      kind: 'fixed',
      nextShipId: 's2',
    });
  });

  it('keeps scanning (does not assume fixed) when lens data is absent and the reviewer still fails overall', () => {
    const longerChain = [
      { ship_id: 's1', exit_code: 1 },
      { ship_id: 's2', exit_code: 1 }, // reviewer still fails overall (maybe on the OTHER lens);
      // no lens-level row for lens-b here — must not assume lens-b resolved.
      { ship_id: 's3', exit_code: 0 },
    ];
    const lensStatusOf = (shipId) => ({ s3: 'pass' })[shipId] && 'pass';
    const statusOf = (shipId) => ({ s2: 'fail', s3: 'pass' })[shipId];
    expect(findNextLensOutcome(longerChain, 's1', 'r', 'lens-b', statusOf, lensStatusOf)).toEqual({
      kind: 'fixed',
      nextShipId: 's3',
    });
  });

  it('returns no-fix-found when the anchor ship is not found in the chain', () => {
    expect(
      findNextLensOutcome(
        chain,
        'missing',
        'r',
        'lens-a',
        () => 'pass',
        () => 'pass',
      ),
    ).toEqual({ kind: 'no-fix-found', nextShipId: null });
  });
});

describe('mine-telemetry-lib: hasDiffEvidence', () => {
  it('is true when either hash is present', () => {
    expect(hasDiffEvidence('abc', null)).toBe(true);
    expect(hasDiffEvidence(null, 'def')).toBe(true);
    expect(hasDiffEvidence('abc', 'def')).toBe(true);
  });

  it('is false when both hashes are null', () => {
    expect(hasDiffEvidence(null, null)).toBe(false);
  });
});

describe('mine-telemetry-lib: isSameDiff', () => {
  it('is true only for two equal non-empty hashes', () => {
    expect(isSameDiff('abc', 'abc')).toBe(true);
  });

  it('is false for different hashes', () => {
    expect(isSameDiff('abc', 'def')).toBe(false);
  });

  it('is false when either side is null/undefined/empty', () => {
    expect(isSameDiff(null, 'abc')).toBe(false);
    expect(isSameDiff('abc', undefined)).toBe(false);
    expect(isSameDiff('', '')).toBe(false);
  });
});

describe('mine-telemetry-lib: diffArchiveRelPath', () => {
  it('builds the diffs/<hash>.diff.gz relative path', () => {
    expect(diffArchiveRelPath('deadbeef')).toBe('diffs/deadbeef.diff.gz');
  });

  it('is null for a missing hash', () => {
    expect(diffArchiveRelPath(null)).toBeNull();
    expect(diffArchiveRelPath(undefined)).toBeNull();
  });
});

describe('mine-telemetry-lib: resolveDiffPayload', () => {
  it('inlines text at or under the cap', () => {
    const text = 'x'.repeat(100);
    expect(resolveDiffPayload(text, 'diffs/h.diff.gz')).toEqual({ diffText: text, diffPath: null });
  });

  it('inlines text exactly at the cap boundary', () => {
    const text = 'x'.repeat(INLINE_DIFF_CAP_BYTES);
    expect(resolveDiffPayload(text, 'diffs/h.diff.gz')).toEqual({ diffText: text, diffPath: null });
  });

  it('falls back to a path ref past the cap', () => {
    const text = 'x'.repeat(INLINE_DIFF_CAP_BYTES + 1);
    expect(resolveDiffPayload(text, 'diffs/h.diff.gz')).toEqual({
      diffText: null,
      diffPath: 'diffs/h.diff.gz',
    });
  });

  it('returns both null when there is no archived text', () => {
    expect(resolveDiffPayload(null, 'diffs/h.diff.gz')).toEqual({ diffText: null, diffPath: null });
  });
});

describe('mine-telemetry-lib: telemetryUrl', () => {
  it('includes the lens segment when present', () => {
    expect(telemetryUrl('fail-fix', 'ship1', 'correctness-reviewer', 'concurrency-races')).toBe(
      'telemetry://fail-fix/ship1/correctness-reviewer/concurrency-races',
    );
  });

  it('omits the lens segment when absent', () => {
    expect(telemetryUrl('waived-decoy', 'ship1', 'correctness-reviewer', null)).toBe(
      'telemetry://waived-decoy/ship1/correctness-reviewer',
    );
  });
});

describe('mine-telemetry-lib: pickFailReason', () => {
  it('prefers the lens issues_json text when parseable', () => {
    expect(pickFailReason('["finding one","finding two"]', 'fallback reason')).toBe(
      'finding one\nfinding two',
    );
  });

  it('falls back to the review reason when issues_json is missing', () => {
    expect(pickFailReason(null, 'fallback reason')).toBe('fallback reason');
  });

  it('falls back to the review reason when issues_json is unparseable', () => {
    expect(pickFailReason('not json', 'fallback reason')).toBe('fallback reason');
  });

  it('falls back to the review reason when issues_json parses to an empty array', () => {
    expect(pickFailReason('[]', 'fallback reason')).toBe('fallback reason');
  });

  it('returns null when neither source has usable text', () => {
    expect(pickFailReason(null, null)).toBeNull();
    expect(pickFailReason('[]', '   ')).toBeNull();
  });
});

describe('mine-telemetry-lib: buildFailFixCandidate', () => {
  it('shapes a full fail-fix row', () => {
    const row = buildFailFixCandidate({
      shipId: 's1',
      repo: 'devkit',
      branch: 'bench/waive-command',
      reviewer: 'correctness-reviewer',
      lens: 'concurrency-races',
      tsFail: '2026-08-01T22:11:51.523Z',
      diffSha256: 'aaa',
      bytesAvailable: true,
      diffPayload: { diffText: 'diff --git a b', diffPath: null },
      failReason: 'concurrency race',
      nextShipId: 's4',
      nextDiffSha256: 'bbb',
      nextBytesAvailable: false,
      nextDiffPayload: { diffText: null, diffPath: null },
      tsFix: '2026-08-01T22:27:21.171Z',
    });
    expect(row).toMatchObject({
      kind: 'fail-fix',
      url: 'telemetry://fail-fix/s1/correctness-reviewer/concurrency-races',
      shipId: 's1',
      diffSha256: 'aaa',
      bytesAvailable: true,
      diffText: 'diff --git a b',
      nextShipId: 's4',
      nextDiffSha256: 'bbb',
      nextBytesAvailable: false,
      hasDiffEvidence: true,
    });
  });

  it('defaults missing diff payload/hash fields to null rather than throwing, and flags hasDiffEvidence false', () => {
    const row = buildFailFixCandidate({
      shipId: 's1',
      repo: 'devkit',
      branch: 'main',
      reviewer: 'correctness-reviewer',
      lens: null,
      tsFail: 't1',
      diffSha256: null,
      bytesAvailable: false,
      diffPayload: undefined,
      failReason: null,
      nextShipId: 's2',
      nextDiffSha256: null,
      nextBytesAvailable: false,
      nextDiffPayload: undefined,
      tsFix: 't2',
    });
    expect(row.diffText).toBeNull();
    expect(row.diffPath).toBeNull();
    expect(row.nextDiffText).toBeNull();
    expect(row.lens).toBeNull();
    expect(row.hasDiffEvidence).toBe(false);
  });
});

describe('mine-telemetry-lib: buildWaivedCandidate', () => {
  it('shapes a waived-decoy row with a null rationale by default', () => {
    const row = buildWaivedCandidate({
      shipId: 'E593DD18',
      repo: 'devkit',
      branch: 'main',
      reviewer: 'correctness-reviewer',
      lens: 'writer-reader-contracts',
      tsFail: '2026-08-01T00:00:00Z',
      diffSha256: 'ccc',
      bytesAvailable: false,
      diffPayload: { diffText: null, diffPath: null },
      failReason: 'the judge finding text',
      disposition: 'waived',
    });
    expect(row).toMatchObject({
      kind: 'waived-decoy',
      url: 'telemetry://waived-decoy/E593DD18/correctness-reviewer/writer-reader-contracts',
      disposition: 'waived',
      rationale: null,
    });
  });
});

describe('mine-telemetry-lib: mergeCandidates', () => {
  it('new rows win by url; untouched existing rows are preserved', () => {
    const existing = new Map([
      ['telemetry://a/r', { url: 'telemetry://a/r', tsFail: 'old' }],
      ['telemetry://b/r', { url: 'telemetry://b/r', tsFail: 'keep' }],
    ]);
    const merged = mergeCandidates(existing, [{ url: 'telemetry://a/r', tsFail: 'new' }]);
    expect(merged.get('telemetry://a/r').tsFail).toBe('new');
    expect(merged.get('telemetry://b/r').tsFail).toBe('keep');
    expect(merged.size).toBe(2);
  });

  it('ignores rows without a url', () => {
    const merged = mergeCandidates(new Map(), [{ tsFail: 'no-url' }]);
    expect(merged.size).toBe(0);
  });

  it('tolerates an undefined existing map', () => {
    const merged = mergeCandidates(undefined, [{ url: 'telemetry://a/r' }]);
    expect(merged.size).toBe(1);
  });
});

describe('mine-telemetry-lib: histogramKey / buildHistogram', () => {
  it('groups by kind, reviewer, and bytesAvailable', () => {
    const rows = [
      { kind: 'fail-fix', reviewer: 'correctness-reviewer', bytesAvailable: true },
      { kind: 'fail-fix', reviewer: 'correctness-reviewer', bytesAvailable: true },
      { kind: 'fail-fix', reviewer: 'correctness-reviewer', bytesAvailable: false },
      { kind: 'waived-decoy', reviewer: 'correctness-reviewer', bytesAvailable: false },
    ];
    const hist = buildHistogram(rows, histogramKey);
    expect(hist[0]).toEqual(['fail-fix / correctness-reviewer / bytesAvailable=true', 2]);
    expect(hist).toContainEqual(['fail-fix / correctness-reviewer / bytesAvailable=false', 1]);
    expect(hist).toContainEqual(['waived-decoy / correctness-reviewer / bytesAvailable=false', 1]);
  });

  it('returns an empty histogram for no rows', () => {
    expect(buildHistogram([])).toEqual([]);
  });
});

describe('mine-telemetry-lib: selectFailLensRows', () => {
  const lens = (l, status, disposition) => ({ lens: l, status, disposition });

  it('returns the blocking failed lenses when the breakdown has them', () => {
    const { rows, skipped } = selectFailLensRows([
      lens('races', 'fail', 'blocking'),
      lens('contracts', 'pass', null),
    ]);
    expect(rows.map((r) => r.lens)).toEqual(['races']);
    expect(skipped).toBeNull();
  });

  it('treats a null disposition (pre-disposition-era row) as blocking', () => {
    const { rows, skipped } = selectFailLensRows([lens('races', 'fail', null)]);
    expect(rows.map((r) => r.lens)).toEqual(['races']);
    expect(skipped).toBeNull();
  });

  it('falls back to the reviewer-level scan when no lens breakdown was recorded', () => {
    for (const absent of [undefined, null, []]) {
      const { rows, skipped } = selectFailLensRows(absent);
      expect(rows).toEqual([null]);
      expect(skipped).toBeNull();
    }
  });

  // The regression this guards: an empty blocking filter used to fall through to [null], so a
  // fail whose only failing lenses were waived/dropped minted a reviewer-level gold from exactly
  // the lenses the allowlist had just excluded.
  it('skips the fail entirely when every failing lens is waived or dropped', () => {
    for (const disposition of ['waived', 'dropped_out_of_charter']) {
      const { rows, skipped } = selectFailLensRows([
        lens('races', 'fail', disposition),
        lens('contracts', 'pass', null),
      ]);
      expect(rows).toEqual([]);
      expect(skipped).toBe('all-failing-lenses-non-blocking');
    }
  });

  it('skips when a mix of waived and dropped failing lenses leaves nothing blocking', () => {
    const { rows, skipped } = selectFailLensRows([
      lens('races', 'fail', 'waived'),
      lens('contracts', 'fail', 'dropped_out_of_charter'),
    ]);
    expect(rows).toEqual([]);
    expect(skipped).toBe('all-failing-lenses-non-blocking');
  });

  it('still falls back to reviewer-level when a breakdown exists but nothing failed in it', () => {
    const { rows, skipped } = selectFailLensRows([lens('races', 'pass', null)]);
    expect(rows).toEqual([null]);
    expect(skipped).toBeNull();
  });
});

describe('mine-common: collectRepoArgs', () => {
  it('collects every repeated --repo value', () => {
    expect(collectRepoArgs(['--dev', '--repo', 'devkit', '--repo', 'frink'])).toEqual([
      'devkit',
      'frink',
    ]);
  });

  it('returns an empty list when --repo is absent (callers then use their defaults)', () => {
    expect(collectRepoArgs(['--dev', '--max', '20'])).toEqual([]);
  });

  // Both callers treat a non-empty result as an EXPLICIT scope replacing their defaults, so
  // swallowing the next flag here would silently mine a repo that cannot exist.
  it('rejects a flag-shaped value instead of storing it as a repository', () => {
    expect(() => collectRepoArgs(['--repo', '--dev'])).toThrow(/--repo needs a repository name/);
  });

  it('rejects a trailing --repo with no value', () => {
    expect(() => collectRepoArgs(['--dev', '--repo'])).toThrow(/--repo needs a repository name/);
  });
});

describe('mine-common: sqliteJson', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'mine-common-sqlite-'));
  const dbPath = path.join(tmp, 'usage.db');
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const available = sqlite3Available();
  const maybe = available ? it : it.skip;

  if (available) {
    execFileSync('sqlite3', [dbPath, 'CREATE TABLE t(a); INSERT INTO t VALUES(1);']);
  }

  maybe('reads rows as parsed JSON', () => {
    expect(sqliteJson(dbPath, 'SELECT a FROM t;')).toEqual([{ a: 1 }]);
  });

  maybe('returns an empty array for an empty result set', () => {
    expect(sqliteJson(dbPath, 'SELECT a FROM t WHERE a = 99;')).toEqual([]);
  });

  // The read-only boundary is enforced by SQLite itself (-readonly), not by convention: the
  // miners are strictly read-side and the collector owns every write path.
  maybe('refuses a write and leaves the database untouched', () => {
    expect(() => sqliteJson(dbPath, 'INSERT INTO t VALUES(2);')).toThrow();
    expect(sqliteJson(dbPath, 'SELECT a FROM t;')).toEqual([{ a: 1 }]);
  });

  maybe('refuses DDL as well', () => {
    expect(() => sqliteJson(dbPath, 'CREATE TABLE evil(x);')).toThrow();
  });
});
