import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { buildLensPairs, classifyPair, matchDiffPath, summarizeAudit } from '../lib.mts';
import { sqlite3Available } from '../../mine-common.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const LENS = 'error-and-edge-classification';
const R = 'correctness-reviewer';

function seg(path: string, body: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,1 +1,1 @@',
    `-old ${path}`,
    `+${body}`,
    '',
  ].join('\n');
}

interface ShipOverride {
  repo?: string;
  ts_start?: string;
}

function ship(id: string, minute: number, extra: ShipOverride = {}) {
  return {
    ship_id: id,
    repo: 'devkit',
    branch: 'feat/x',
    ts_start: `2026-09-04T12:${String(minute).padStart(2, '0')}:00.000Z`,
    exit_code: 1,
    ...extra,
  };
}

function lensRow(shipId: string, status: string, issues: string[] = [], extra = {}) {
  return {
    ship_id: shipId,
    reviewer: R,
    lens: LENS,
    status,
    disposition: status === 'fail' ? 'blocking' : null,
    judge_status: status,
    judge_model: 'gpt-5.6-sol',
    issues_json: JSON.stringify(issues),
    ...extra,
  };
}

function scope(shipId: string, sha: string, extra = {}) {
  return {
    ship_id: shipId,
    reviewer: R,
    diff_sha256: sha,
    cached: 0,
    chunk_count: null,
    omitted_files: 0,
    truncated_files: 0,
    ...extra,
  };
}

const CLI = 'gate-engine/decisions/cli.mts';
const HOOK = 'agents-hooks/decision-scope-brief.mjs';
const DIFF_K = seg(CLI, 'classify ERR_MODULE_NOT_FOUND') + seg(HOOK, 'alreadyBriefed racy');
const DIFF_K1 = seg(CLI, 'classify ERR_MODULE_NOT_FOUND') + seg(HOOK, 'alreadyBriefed atomic');

const SHA_K = sha256(DIFF_K);
const SHA_K1 = sha256(DIFF_K1);
const SHA_BAD = sha256('not the archived bytes');

function pairsFor(ships, lenses, scopes, opts = {}) {
  return buildLensPairs({ ships, lensRows: lenses, scopeRows: scopes, ...opts });
}

function diffs(map: Record<string, string>) {
  return (sha: string) => (sha in map ? { text: map[sha] } : null);
}

describe('finding-location-audit: matchDiffPath', () => {
  const keys = [CLI, HOOK];
  it('matches repo-relative, ./ and b/ prefixed paths', () => {
    expect(matchDiffPath(CLI, keys)).toBe(CLI);
    expect(matchDiffPath(`./${CLI}`, keys)).toBe(CLI);
    expect(matchDiffPath(`b/${CLI}`, keys)).toBe(CLI);
  });
  it('matches an absolute worktree path by path suffix (E1)', () => {
    expect(matchDiffPath(`/Users/x/.frink/worktrees/devkit/clumsy-reef/${CLI}`, keys)).toBe(CLI);
  });
  it('does not match a bare basename that only shares a suffix with a longer segment', () => {
    expect(matchDiffPath('li.mts', keys)).toBeNull();
    expect(matchDiffPath('other/cli.mts', keys)).toBeNull();
  });
  it('prefers the longest diff key when two keys share a suffix', () => {
    expect(matchDiffPath('/abs/pkg/a/cli.mts', ['a/cli.mts', 'pkg/a/cli.mts'])).toBe(
      'pkg/a/cli.mts',
    );
  });
});

describe('finding-location-audit: buildLensPairs', () => {
  it('pairs consecutive judged rows of the same lens on one branch', () => {
    const { pairs } = pairsFor(
      [ship('s1', 1), ship('s2', 2)],
      [lensRow('s1', 'pass'), lensRow('s2', 'fail', [`${CLI}:162 — over-broad`])],
      [scope('s1', 'A'), scope('s2', 'B')],
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ kind: 'pass-fail', lens: LENS, k: 's1', k1: 's2' });
  });

  it('skips an intervening ship where the lens never ran (E2)', () => {
    const { pairs, skippedShips } = pairsFor(
      [ship('s1', 1), ship('s2', 2), ship('s3', 3)],
      [lensRow('s1', 'pass'), lensRow('s3', 'fail', [`${CLI}:1 — x`])],
      [scope('s1', 'A'), scope('s3', 'C')],
    );
    expect(pairs.map((p) => [p.k, p.k1])).toEqual([['s1', 's3']]);
    expect(skippedShips).toBe(1);
  });

  it('excludes inconclusive, pending, waived and dropped rows instead of reading them as PASS/FAIL (E3)', () => {
    const { pairs, excluded } = pairsFor(
      [ship('s1', 1), ship('s2', 2), ship('s3', 3), ship('s4', 4), ship('s5', 5)],
      [
        lensRow('s1', 'pass', [], { judge_status: 'inconclusive' }),
        lensRow('s2', 'fail', ['x'], { disposition: 'waived' }),
        lensRow('s3', 'pending'),
        lensRow('s4', 'fail', ['x'], { disposition: 'dropped_out_of_charter' }),
        lensRow('s5', 'fail', ['x']),
      ],
      ['s1', 's2', 's3', 's4', 's5'].map((s) => scope(s, s)),
    );
    expect(pairs).toEqual([]);
    expect(excluded['non-verdict']).toBeGreaterThan(0);
  });

  it('skips a cached PASS at k — no judge ran, so it is not a sample (ec2)', () => {
    const { pairs, excluded } = pairsFor(
      [ship('s1', 1), ship('s2', 2)],
      [lensRow('s1', 'pass'), lensRow('s2', 'fail', [`${CLI}:1 — x`])],
      [scope('s1', 'A', { cached: 1 }), scope('s2', 'B')],
    );
    expect(pairs).toEqual([]);
    expect(excluded.replayed).toBe(1);
  });

  it('a cached PASS between two judged rows is transparent: the judged PASS→FAIL still pairs', () => {
    const { pairs, excluded } = pairsFor(
      [ship('s1', 1), ship('s2', 2), ship('s3', 3)],
      [lensRow('s1', 'pass'), lensRow('s2', 'pass'), lensRow('s3', 'fail', [`${CLI}:1 — x`])],
      [scope('s1', 'A'), scope('s2', 'B', { cached: 1 }), scope('s3', 'C')],
    );
    expect(pairs.map((p) => [p.kind, p.k, p.k1])).toEqual([['pass-fail', 's1', 's3']]);
    expect(excluded.replayed).toBe(1);
  });

  it('a lens replayed from cache beside fresh lenses (no judge model) is not a judged sample', () => {
    const replay = { judge_status: null, judge_model: null };
    const { pairs, excluded } = pairsFor(
      [ship('s1', 1), ship('s2', 2), ship('s3', 3)],
      [
        lensRow('s1', 'pass'),
        lensRow('s2', 'pass', [], replay),
        lensRow('s3', 'fail', [`${CLI}:1 — x`]),
      ],
      [scope('s1', 'A'), scope('s2', 'B'), scope('s3', 'C')],
    );
    expect(pairs.map((p) => [p.kind, p.k, p.k1])).toEqual([['pass-fail', 's1', 's3']]);
    expect(excluded.replayed).toBe(1);
  });

  it('a replayed PASS at k never anchors a pair', () => {
    const { pairs } = pairsFor(
      [ship('s1', 1), ship('s2', 2)],
      [lensRow('s1', 'pass', [], { judge_model: null }), lensRow('s2', 'fail', [`${CLI}:1 — x`])],
      [scope('s1', 'A'), scope('s2', 'B')],
    );
    expect(pairs).toEqual([]);
  });

  it('a cached PASS at k+1 never enters the judged-PASS denominator', () => {
    const { pairs } = pairsFor(
      [ship('s1', 1), ship('s2', 2)],
      [lensRow('s1', 'pass'), lensRow('s2', 'pass')],
      [scope('s1', 'A'), scope('s2', 'B', { cached: 1 })],
    );
    expect(pairs).toEqual([]);
  });

  it('excludes a pair whose attempts are further apart than maxGapMs (E11)', () => {
    const { pairs, excluded } = pairsFor(
      [ship('s1', 1), ship('s2', 2, { ts_start: '2026-09-20T12:00:00.000Z' })],
      [lensRow('s1', 'pass'), lensRow('s2', 'fail', [`${CLI}:1 — x`])],
      [scope('s1', 'A'), scope('s2', 'B')],
    );
    expect(pairs).toEqual([]);
    expect(excluded['stale-pair']).toBe(1);
  });

  it('keeps branches of different repos apart', () => {
    const { pairs } = pairsFor(
      [ship('s1', 1), ship('s2', 2, { repo: 'frink' })],
      [lensRow('s1', 'pass'), lensRow('s2', 'fail', [`${CLI}:1 — x`])],
      [scope('s1', 'A'), scope('s2', 'B')],
    );
    expect(pairs).toEqual([]);
  });

  it('orders equal timestamps by ship_id (E12)', () => {
    const { pairs } = pairsFor(
      [ship('b', 1), ship('a', 1)],
      [lensRow('a', 'pass'), lensRow('b', 'fail', [`${CLI}:1 — x`])],
      [scope('a', 'A'), scope('b', 'B')],
    );
    expect(pairs.map((p) => [p.k, p.k1])).toEqual([['a', 'b']]);
  });

  it('records pass-pass pairs so the per-PASS lower bound has a denominator', () => {
    const { pairs } = pairsFor(
      [ship('s1', 1), ship('s2', 2)],
      [lensRow('s1', 'pass'), lensRow('s2', 'pass')],
      [scope('s1', 'A'), scope('s2', 'B')],
    );
    expect(pairs[0].kind).toBe('pass-pass');
  });

  it('tolerates empty and single-ship inputs (E15)', () => {
    expect(pairsFor([], [], []).pairs).toEqual([]);
    expect(pairsFor([ship('s1', 1)], [lensRow('s1', 'pass')], [scope('s1', 'A')]).pairs).toEqual(
      [],
    );
  });
});

describe('finding-location-audit: classifyPair', () => {
  function onePair(kIssues: string[], k1Issues: string[], kStatus = 'pass', scopes?) {
    return pairsFor(
      [ship('s1', 1), ship('s2', 2)],
      [lensRow('s1', kStatus, kIssues), lensRow('s2', 'fail', k1Issues)],
      scopes ?? [scope('s1', 'K'), scope('s2', 'K1')],
    ).pairs[0];
  }

  it('sc-2754 regression: a PASS→FAIL on a file byte-identical across attempts is `unchanged`', () => {
    const pair = onePair([], [`${CLI}:162 — every ERR_MODULE_NOT_FOUND labelled UNAVAILABLE`]);
    const res = classifyPair(pair, diffs({ K: DIFF_K, K1: DIFF_K1 }));
    expect(res.findings).toEqual(['unchanged']);
    expect(res.outcome).toBe('unchanged');
  });

  it('a finding in a file that changed between attempts is `changed`', () => {
    const pair = onePair([], [`${HOOK}:10 — still racy`]);
    expect(classifyPair(pair, diffs({ K: DIFF_K, K1: DIFF_K1 })).findings).toEqual(['changed']);
  });

  it('a file absent from the k diff is `new-at-k1`', () => {
    const extra = 'gate-engine/new.mts';
    const pair = onePair([], [`${extra}:3 — x`]);
    const res = classifyPair(pair, diffs({ K: DIFF_K, K1: DIFF_K1 + seg(extra, 'n') }));
    expect(res.findings).toEqual(['new-at-k1']);
  });

  it('a whitespace-identical file under a different index line is still `unchanged`', () => {
    const k1 = DIFF_K1.replace('index 1111111..2222222', 'index 3333333..4444444');
    const pair = onePair([], [`${CLI}:1 — x`]);
    expect(classifyPair(pair, diffs({ K: DIFF_K, K1: k1 })).findings).toEqual(['unchanged']);
  });

  it('a finding citing one changed and one unchanged file is not `unchanged` (ec3)', () => {
    const pair = onePair([], [`${CLI}:162 reads what ${HOOK}:10 writes`]);
    expect(classifyPair(pair, diffs({ K: DIFF_K, K1: DIFF_K1 })).findings).toEqual(['changed']);
  });

  it('a renamed file is never `unchanged` — its post-image key is new at k+1 (E8)', () => {
    const renamed = [
      'diff --git a/old/cli.mts b/gate-engine/decisions/cli.mts',
      'similarity index 90%',
      'rename from old/cli.mts',
      'rename to gate-engine/decisions/cli.mts',
      '',
    ].join('\n');
    const k = seg('old/cli.mts', 'classify ERR_MODULE_NOT_FOUND') + seg(HOOK, 'h');
    const pair = onePair([], [`${CLI}:1 — x`]);
    const res = classifyPair(pair, diffs({ K: k, K1: renamed + seg(HOOK, 'h2') }));
    expect(res.findings).toEqual(['new-at-k1']);
    expect(res.outcome).not.toBe('unchanged');
  });

  it('a file outside both diffs is `outside-diff` (E9)', () => {
    const pair = onePair([], ['gate-engine/elsewhere.mts:5 — context file']);
    expect(classifyPair(pair, diffs({ K: DIFF_K, K1: DIFF_K1 })).findings).toEqual([
      'outside-diff',
    ]);
  });

  it('a pair whose only finding is outside both diffs is undeterminable, not determinable', () => {
    const pair = onePair([], ['gate-engine/elsewhere.mts:5 — context file']);
    expect(classifyPair(pair, diffs({ K: DIFF_K, K1: DIFF_K1 }))).toMatchObject({
      outcome: 'undeterminable',
      reason: 'outside-diff',
    });
  });

  it('a pair mixing an outside-diff and a changed-file finding is `elsewhere`', () => {
    const pair = onePair([], ['gate-engine/elsewhere.mts:5 — context', `${HOOK}:1 — racy`]);
    expect(classifyPair(pair, diffs({ K: DIFF_K, K1: DIFF_K1 })).outcome).toBe('elsewhere');
  });

  it('a finding with no parsable location is `no-location`', () => {
    const pair = onePair([], ['the classifier is too broad']);
    const res = classifyPair(pair, diffs({ K: DIFF_K, K1: DIFF_K1 }));
    expect(res.findings).toEqual(['no-location']);
    expect(res.outcome).toBe('undeterminable');
  });

  it('a missing k archive is undeterminable, never unchanged (E1/ec1)', () => {
    const pair = onePair([], [`${CLI}:1 — x`]);
    expect(classifyPair(pair, diffs({ K1: DIFF_K1 }))).toMatchObject({
      outcome: 'undeterminable',
      reason: 'no-k-diff',
    });
  });

  it('a corrupt archive (reader error) is undeterminable and does not throw (E6)', () => {
    const pair = onePair([], [`${CLI}:1 — x`]);
    const reader = (sha: string) =>
      sha === 'K' ? { error: 'unexpected end of file' } : { text: DIFF_K1 };
    expect(classifyPair(pair, reader)).toMatchObject({
      outcome: 'undeterminable',
      reason: 'k-diff-unreadable',
    });
  });

  it('a chunked attempt is undeterminable: its archive is keyed by the chunk, not the scope (E10)', () => {
    const pair = onePair([], [`${CLI}:1 — x`], 'pass', [
      scope('s1', 'K', { chunk_count: 2 }),
      scope('s2', 'K1'),
    ]);
    expect(classifyPair(pair, diffs({ K: DIFF_K, K1: DIFF_K1 }))).toMatchObject({
      outcome: 'undeterminable',
      reason: 'chunked',
    });
  });

  it('a lens that flips on an identical diff with an in-diff finding is `same-diff-flip` (E5)', () => {
    const pair = onePair([], [`${CLI}:1 — x`], 'pass', [scope('s1', 'SAME'), scope('s2', 'SAME')]);
    expect(classifyPair(pair, diffs({ SAME: DIFF_K })).outcome).toBe('same-diff-flip');
  });

  it('an identical diff whose finding cites a file outside it is not counted as a flip', () => {
    const pair = onePair([], ['gate-engine/elsewhere.mts:5 — context'], 'pass', [
      scope('s1', 'SAME'),
      scope('s2', 'SAME'),
    ]);
    const res = classifyPair(pair, diffs({ SAME: DIFF_K }));
    expect(res.outcome).not.toBe('same-diff-flip');
    expect(res.findings).toEqual(['outside-diff']);
  });

  it('an identical diff that is not archived is undeterminable, not a flip', () => {
    const pair = onePair([], [`${CLI}:1 — x`], 'pass', [scope('s1', 'SAME'), scope('s2', 'SAME')]);
    expect(classifyPair(pair, diffs({})).outcome).toBe('undeterminable');
  });

  it('a chunked attempt with an identical scope hash is still undeterminable', () => {
    const pair = onePair([], [`${CLI}:1 — x`], 'pass', [
      scope('s1', 'SAME', { chunk_count: 2 }),
      scope('s2', 'SAME', { chunk_count: 2 }),
    ]);
    expect(classifyPair(pair, diffs({ SAME: DIFF_K }))).toMatchObject({
      outcome: 'undeterminable',
      reason: 'chunked',
    });
  });

  it('a FAIL→FAIL finding repeated verbatim is `already-disclosed`', () => {
    const issue = `${CLI}:162 — over-broad`;
    const pair = onePair([issue], [issue], 'fail');
    expect(classifyPair(pair, diffs({ K: DIFF_K, K1: DIFF_K1 })).findings).toEqual([
      'already-disclosed',
    ]);
  });

  it.each([
    ['k omitted files', { omitted_files: 3 }, {}],
    ['k truncated files', { truncated_files: 1 }, {}],
    ['k+1 truncated files', {}, { truncated_files: 2 }],
  ])(
    'capped evidence (%s) on an otherwise unchanged file is undeterminable, never unchanged',
    (_, kCap, k1Cap) => {
      const pair = onePair([], [`${CLI}:1 — x`], 'pass', [
        scope('s1', 'K', kCap),
        scope('s2', 'K1', k1Cap),
      ]);
      expect(classifyPair(pair, diffs({ K: DIFF_K, K1: DIFF_K1 }))).toMatchObject({
        outcome: 'undeterminable',
        reason: 'evidence-capped',
        findings: ['evidence-capped'],
      });
    },
  );

  it('capped evidence never hides a changed-file finding', () => {
    const pair = onePair([], [`${HOOK}:1 — x`], 'pass', [
      scope('s1', 'K', { omitted_files: 1 }),
      scope('s2', 'K1'),
    ]);
    expect(classifyPair(pair, diffs({ K: DIFF_K, K1: DIFF_K1 })).findings).toEqual(['changed']);
  });

  it.each([null, '', 'not json', '{"a":1}', '[]'])(
    'malformed or empty issues_json %j yields no-issues without throwing (E7)',
    (raw) => {
      const pair = pairsFor(
        [ship('s1', 1), ship('s2', 2)],
        [lensRow('s1', 'pass'), { ...lensRow('s2', 'fail'), issues_json: raw }],
        [scope('s1', 'K'), scope('s2', 'K1')],
      ).pairs[0];
      expect(classifyPair(pair, diffs({ K: DIFF_K, K1: DIFF_K1 }))).toMatchObject({
        outcome: 'undeterminable',
        reason: 'no-issues',
      });
    },
  );
});

describe('finding-location-audit: summarizeAudit', () => {
  it('counts a pair once however many of its findings are unchanged (E4)', () => {
    const pair = pairsFor(
      [ship('s1', 1), ship('s2', 2)],
      [
        lensRow('s1', 'pass'),
        lensRow('s2', 'fail', [`${CLI}:1 — a`, `${CLI}:9 — b`, `${HOOK}:1 — c`]),
      ],
      [scope('s1', 'K'), scope('s2', 'K1')],
    ).pairs[0];
    const summary = summarizeAudit([classifyPair(pair, diffs({ K: DIFF_K, K1: DIFF_K1 }))]);
    const lens = summary.lenses[LENS]['pass-fail'];
    expect(lens.pairs).toBe(1);
    expect(lens.outcomes.unchanged).toBe(1);
    expect(lens.findings.unchanged).toBe(2);
    expect(lens.findings.changed).toBe(1);
  });

  it('reports null rates, never NaN, when nothing is determinable (E4/E15)', () => {
    const summary = summarizeAudit([]);
    expect(summary.totals.unchangedShareOfDeterminablePassFail).toBeNull();
    expect(summary.totals.unchangedPerPassLowerBound).toBeNull();
  });

  it('derives both rates from determinable pass-fail and all PASS@k pairs', () => {
    const results = [
      { lens: LENS, kind: 'pass-fail', outcome: 'unchanged', findings: ['unchanged'] },
      { lens: LENS, kind: 'pass-fail', outcome: 'changed', findings: ['changed'] },
      {
        lens: LENS,
        kind: 'pass-fail',
        outcome: 'undeterminable',
        reason: 'no-k-diff',
        findings: [],
      },
      { lens: LENS, kind: 'pass-pass', outcome: 'not-applicable', findings: [] },
    ];
    const t = summarizeAudit(results).lenses[LENS].rates;
    expect(t.unchangedShareOfDeterminablePassFail).toBe(0.5);
    expect(t.unchangedPerPassLowerBound).toBe(0.25);
  });

  it('summary carries no paths or finding text (E13)', () => {
    const pair = pairsFor(
      [ship('s1', 1), ship('s2', 2)],
      [lensRow('s1', 'pass'), lensRow('s2', 'fail', [`${CLI}:162 — secret finding prose`])],
      [scope('s1', 'K'), scope('s2', 'K1')],
    ).pairs[0];
    const json = JSON.stringify(
      summarizeAudit([classifyPair(pair, diffs({ K: DIFF_K, K1: DIFF_K1 }))]),
    );
    expect(json).not.toContain('/');
    expect(json).not.toContain('secret finding prose');
    expect(json).not.toContain('s1');
  });
});

describe('finding-location-audit CLI (sqlite fixture, E14)', () => {
  const CLI_PATH = path.resolve(here, '../cli.mts');
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'e0-audit-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  function run(env: Record<string, string>, args: string[] = []) {
    return spawnSync(process.execPath, [CLI_PATH, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
  }

  it.skipIf(!sqlite3Available())(
    'classifies the sc-2754 shape end to end from db + archive',
    () => {
      const db = path.join(tmp, 'usage.db');
      const telemetry = path.join(tmp, 'telemetry');
      mkdirSync(path.join(telemetry, 'diffs'), { recursive: true });
      writeFileSync(path.join(telemetry, 'diffs', `${SHA_K}.diff.gz`), gzipSync(DIFF_K));
      writeFileSync(path.join(telemetry, 'diffs', `${SHA_K1}.diff.gz`), gzipSync(DIFF_K1));
      // Valid gzip under the wrong name: the bytes do not hash to the scope's diff_sha256.
      writeFileSync(path.join(telemetry, 'diffs', `${SHA_BAD}.diff.gz`), gzipSync(DIFF_K));
      const issue = JSON.stringify([`${CLI}:162 — over-broad`]).replace(/'/g, "''");
      execFileSync('sqlite3', [
        db,
        `CREATE TABLE commit_ships (ship_id TEXT, repo TEXT, branch TEXT, ts_start TEXT, exit_code INTEGER);
       CREATE TABLE commit_review_lenses (ship_id TEXT, reviewer TEXT, lens TEXT, status TEXT, disposition TEXT, judge_status TEXT, judge_model TEXT, issues_json TEXT);
       CREATE TABLE commit_review_scope (ship_id TEXT, reviewer TEXT, diff_sha256 TEXT, cached INTEGER, chunk_count INTEGER, omitted_files INTEGER, truncated_files INTEGER);
       INSERT INTO commit_ships VALUES ('s1','devkit','b','2026-09-04T12:00:00Z',1),('s2','devkit','b','2026-09-04T12:10:00Z',1),('o1','other','b','2026-09-04T12:00:00Z',1),
         ('c1','devkit','c','2026-09-04T12:00:00Z',1),('c2','devkit','c','2026-09-04T12:10:00Z',1);
       INSERT INTO commit_review_lenses VALUES
         ('s1','${R}','${LENS}','pass',NULL,'pass','m','[]'),
         ('s1','${R}','concurrency-races','fail','blocking','fail','m','[]'),
         ('s2','${R}','${LENS}','fail','blocking','fail','m','${issue}'),
         ('o1','${R}','${LENS}','pass',NULL,'pass','m','[]'),
         ('c1','${R}','state-transitions','pass',NULL,'pass','m','[]'),
         ('c2','${R}','state-transitions','fail','blocking','fail','m','${issue}');
       INSERT INTO commit_review_scope VALUES ('s1','${R}','${SHA_K}',0,NULL,0,0),('s2','${R}','${SHA_K1}',0,NULL,0,0),
         ('c1','${R}','${SHA_BAD}',0,NULL,0,0),('c2','${R}','${SHA_K1}',0,NULL,0,0);`,
      ]);
      const out = path.join(tmp, 'out');
      const res = run(
        { USAGE_DB: db, DEVKIT_GATE_EVENTS: path.join(telemetry, 'gate-events.jsonl') },
        ['--out', out],
      );
      expect(res.status, res.stderr).toBe(0);
      const summary = JSON.parse(readFileSync(path.join(out, 'summary.json'), 'utf8'));
      expect(summary.lenses).toEqual({
        'state-transitions': expect.objectContaining({
          'pass-fail': expect.objectContaining({ reasons: { 'k-diff-unreadable': 1 } }),
        }),
        [LENS]: expect.objectContaining({
          'pass-fail': expect.objectContaining({ outcomes: { unchanged: 1 } }),
          rates: expect.objectContaining({ unchangedShareOfDeterminablePassFail: 1 }),
        }),
      });
      expect(JSON.parse(res.stdout)).toEqual(summary);
    },
  );

  it.skipIf(!sqlite3Available())(
    '--until accepts a valid offset instant and records it in UTC',
    () => {
      const db = path.join(tmp, 'usage.db');
      const telemetry = path.join(tmp, 'telemetry');
      const env = { USAGE_DB: db, DEVKIT_GATE_EVENTS: path.join(telemetry, 'gate-events.jsonl') };
      const res = run(env, ['--until', '2026-09-04T13:05:00+01:00']);
      expect(res.status, res.stderr).toBe(0);
      expect(JSON.parse(res.stdout).until).toBe('2026-09-04T12:05:00.000Z');
    },
  );

  it.skipIf(!sqlite3Available())(
    '--until freezes the window: later ships never enter the counts',
    () => {
      const db = path.join(tmp, 'usage.db');
      const telemetry = path.join(tmp, 'telemetry');
      const env = { USAGE_DB: db, DEVKIT_GATE_EVENTS: path.join(telemetry, 'gate-events.jsonl') };
      const res = run(env, ['--until', '2026-09-04T12:05:00Z']);
      expect(res.status, res.stderr).toBe(0);
      const report = JSON.parse(res.stdout);
      expect(report.until).toBe('2026-09-04T12:05:00.000Z');
      expect(report.lenses).toEqual({});
    },
  );

  it.each(['--until', '--max-gap-hours', '--out'])(
    'rejects a trailing %s with no value instead of silently using its default',
    (flag) => {
      const res = run({ USAGE_DB: path.join(tmp, 'absent.db') }, ['--repo', 'devkit', flag]);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain(`${flag} needs a value`);
    },
  );

  it('rejects a flag whose value is another flag', () => {
    const res = run({ USAGE_DB: path.join(tmp, 'absent.db') }, ['--until', '--out', 'x']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--until needs a value');
  });

  it.each(['Infinity', '-1', '0', 'NaN', '1e400'])(
    'rejects a non-finite or non-positive --max-gap-hours %s',
    (value) => {
      const res = run({ USAGE_DB: path.join(tmp, 'absent.db') }, ['--max-gap-hours', value]);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('--max-gap-hours');
    },
  );

  it.each([
    'yesterday',
    '0',
    '2026-10-01',
    '1790846679593',
    '2026-02-31T09:00:00Z',
    '2026-10-01T25:00:00Z',
    '2026-13-01T09:00:00Z',
    '2026-10-01T09:60:00+01:00',
  ])('rejects a non-ISO-8601-instant --until %s', (value) => {
    const res = run({ USAGE_DB: path.join(tmp, 'absent.db') }, ['--until', value]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--until');
  });

  it('exits non-zero with a named remedy when the database is missing', () => {
    const res = run({ USAGE_DB: path.join(tmp, 'absent.db') });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('set USAGE_DB');
  });

  it('rejects a non-positive --max-gap-hours instead of silently excluding every pair', () => {
    const res = run({ USAGE_DB: path.join(tmp, 'absent.db') }, ['--max-gap-hours', '0']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--max-gap-hours');
  });
});
