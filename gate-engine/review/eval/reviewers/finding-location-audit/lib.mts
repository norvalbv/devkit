// @ts-nocheck — BENCH-ONLY (excluded from tsc, see tsconfig.json exclude); loose types deliberate.

/** E0 (2026-08-22 ship-attempts synthesis) extended to PASS@k → FAIL@k+1: did a lens fail on code it
 * already passed unchanged? Method, limits: docs/benchmarks/experiments/2026-10-01-lens-stability. */

import { z } from 'zod';
import { issueLocations } from '../../../evidence/findings.mts';
import { identityByPath } from '../../../lens/chunk.mts';
import { groupShipsByRepoBranch, isSameDiff } from '../mine-telemetry-lib.mts';

export const DEFAULT_REVIEWER = 'correctness-reviewer';
/** Attempts further apart than this are a reused branch name or an abandoned chain, not a retry. */
export const DEFAULT_MAX_GAP_MS = 24 * 60 * 60 * 1000;

const NON_BLOCKING = new Set(['waived', 'dropped_out_of_charter']);
const NON_VERDICT_JUDGE = new Set(['inconclusive', 'error']);

const IssueList = z.array(z.string());

function parseIssues(raw) {
  let parsed;
  try {
    parsed = IssueList.safeParse(JSON.parse(raw));
  } catch {
    return [];
  }
  return parsed.success ? parsed.data.filter((s) => s.trim()) : [];
}

/** 'pass' | 'fail' for a lens row the gate actually judged and held; null for anything else. */
function verdictOf(row) {
  if (!row || NON_VERDICT_JUDGE.has(row.judge_status)) return null;
  if (row.status === 'pass') return 'pass';
  if (row.status === 'fail' && !NON_BLOCKING.has(row.disposition)) return 'fail';
  return null;
}

function bump(obj, key, by = 1) {
  obj[key] = (obj[key] ?? 0) + by;
}

/** Consecutive judged rows of one lens per (repo, branch). Rowless and replayed lens rows are skipped (no
 * judge ran); a non-verdict row (pending, inconclusive, waived, dropped) breaks the chain. */
export function buildLensPairs({
  ships,
  lensRows,
  scopeRows,
  reviewer = DEFAULT_REVIEWER,
  maxGapMs = DEFAULT_MAX_GAP_MS,
}) {
  const lensByShip = new Map();
  for (const row of lensRows ?? []) {
    if (row?.reviewer !== reviewer) continue;
    if (!lensByShip.has(row.ship_id)) lensByShip.set(row.ship_id, new Map());
    lensByShip.get(row.ship_id).set(row.lens, row);
  }
  const scopeByShip = new Map();
  for (const row of scopeRows ?? [])
    if (row?.reviewer === reviewer) scopeByShip.set(row.ship_id, row);

  const pairs = [];
  const excluded = {};
  let skippedShips = 0;
  const { groups } = groupShipsByRepoBranch(ships);
  for (const chain of groups.values()) {
    const lenses = new Set();
    for (const s of chain)
      for (const lens of lensByShip.get(s.ship_id)?.keys() ?? []) lenses.add(lens);
    for (const lens of [...lenses].sort()) {
      let prev = null;
      let gap = 0;
      for (const s of chain) {
        const row = lensByShip.get(s.ship_id)?.get(lens);
        if (!row) {
          if (prev) gap += 1;
          continue;
        }
        const scope = scopeByShip.get(s.ship_id) ?? null;
        // No judge model = this lens was replayed from cache (alone or beside fresh lenses).
        if (Number(scope?.cached) === 1 || row.judge_model == null) {
          bump(excluded, 'replayed');
          if (prev) gap += 1;
          continue;
        }
        const verdict = verdictOf(row);
        if (!verdict) {
          bump(excluded, 'non-verdict');
          prev = null;
          gap = 0;
          continue;
        }
        const cur = { ship: s, row, verdict, scope };
        if (prev) {
          const elapsed = Date.parse(s.ts_start) - Date.parse(prev.ship.ts_start);
          if (!(elapsed <= maxGapMs)) bump(excluded, 'stale-pair');
          else {
            skippedShips += gap;
            pairs.push({
              lens,
              kind: `${prev.verdict}-${verdict}`,
              k: prev.ship.ship_id,
              k1: s.ship_id,
              kScope: prev.scope,
              k1Scope: cur.scope,
              kIssues: parseIssues(prev.row.issues_json),
              k1Issues: parseIssues(row.issues_json),
            });
          }
        }
        prev = cur;
        gap = 0;
      }
    }
  }
  return { pairs, excluded, skippedShips };
}

const stripLead = (p) => String(p).replace(/^(?:\.\/)+/, '');

/** The diff key a cited path names: exact, or a `/<key>` suffix (longest wins), or a unique key
 * ending with a shortened citation — reviewers cite relative, `b/` and absolute worktree paths. */
export function matchDiffPath(cited, keys) {
  const c = stripLead(cited);
  let best = null;
  for (const key of keys) {
    if (c === key || c.endsWith(`/${key}`)) {
      if (!best || key.length > best.length) best = key;
    }
  }
  if (best) return best;
  const shortened = [...keys].filter((key) => key.endsWith(`/${c}`));
  return shortened.length === 1 ? shortened[0] : null;
}

function readSide(readDiff, scopeRow, side) {
  const sha = scopeRow?.diff_sha256;
  if (!sha) return { reason: `no-${side}-diff` };
  let r;
  try {
    r = readDiff(sha);
  } catch {
    return { reason: `${side}-diff-unreadable` };
  }
  if (!r) return { reason: `no-${side}-diff` };
  if (r.error !== undefined || r.text == null) return { reason: `${side}-diff-unreadable` };
  return { text: String(r.text) };
}

function classifyLocation(cited, kMap, k1Map, keys) {
  const p = matchDiffPath(cited, keys);
  if (!p) return 'outside-diff';
  if (!kMap.has(p)) return 'new-at-k1';
  if (!k1Map.has(p)) return 'changed';
  return kMap.get(p) === k1Map.get(p) ? 'unchanged' : 'changed';
}

function classifyIssue(issue, ctx) {
  if (ctx.kind === 'fail-fail' && ctx.kIssues.has(issue.trim())) return 'already-disclosed';
  const locs = issueLocations(issue);
  if (locs.length === 0) return 'no-location';
  const classes = locs.map((l) => classifyLocation(l.file, ctx.kMap, ctx.k1Map, ctx.keys));
  const inDiff = classes.filter((c) => c !== 'outside-diff');
  if (inDiff.length === 0) return 'outside-diff';
  if (inDiff.includes('changed')) return 'changed';
  if (inDiff.includes('new-at-k1')) return 'new-at-k1';
  return ctx.capped ? 'evidence-capped' : 'unchanged';
}

// A finding resolved to a file that changed or appeared; anything else compared no archived bytes.
const LOCATED_ELSEWHERE = new Set(['changed', 'new-at-k1', 'already-disclosed']);
const UNLOCATED_REASONS = ['evidence-capped', 'outside-diff', 'no-location'];

const undeterminable = (base, reason) => ({
  ...base,
  outcome: 'undeterminable',
  reason,
  findings: [],
});

/** `readDiff(sha)` → `{ text }`, `{ error }` or null. A pair is `unchanged` when any finding is, so
 * one pair counts once however many findings it carries. */
export function classifyPair(pair, readDiff) {
  const base = { lens: pair.lens, kind: pair.kind };
  if (pair.kind !== 'pass-fail' && pair.kind !== 'fail-fail')
    return { ...base, outcome: 'not-applicable', findings: [] };
  if (!pair.k1Issues?.length) return undeterminable(base, 'no-issues');
  if (Number(pair.kScope?.chunk_count) > 1 || Number(pair.k1Scope?.chunk_count) > 1)
    return undeterminable(base, 'chunked');
  const k = readSide(readDiff, pair.kScope, 'k');
  if (k.reason) return undeterminable(base, k.reason);
  const k1 = readSide(readDiff, pair.k1Scope, 'k1');
  if (k1.reason) return undeterminable(base, k1.reason);

  const kMap = identityByPath(k.text);
  const k1Map = identityByPath(k1.text);
  const ctx = {
    kind: pair.kind,
    kMap,
    k1Map,
    keys: new Set([...kMap.keys(), ...k1Map.keys()]),
    kIssues: new Set(pair.kIssues.map((s) => s.trim())),
    // A file a judge never saw in full proves nothing either way about a miss.
    capped: [pair.kScope, pair.k1Scope].some(
      (sc) => Number(sc?.omitted_files) > 0 || Number(sc?.truncated_files) > 0,
    ),
  };
  const findings = pair.k1Issues.map((issue) => classifyIssue(issue, ctx));
  if (findings.includes('unchanged')) {
    const sameDiff = isSameDiff(pair.kScope?.diff_sha256, pair.k1Scope?.diff_sha256);
    return { ...base, outcome: sameDiff ? 'same-diff-flip' : 'unchanged', findings };
  }
  if (findings.some((f) => LOCATED_ELSEWHERE.has(f)))
    return { ...base, outcome: 'elsewhere', findings };
  const reason = UNLOCATED_REASONS.find((r) => findings.includes(r));
  return { ...base, outcome: 'undeterminable', reason, findings };
}

const UNCHANGED_OUTCOMES = ['unchanged', 'same-diff-flip'];

function rates(byKind) {
  const pf = byKind['pass-fail'];
  const pp = byKind['pass-pass'];
  const unchanged = UNCHANGED_OUTCOMES.reduce((n, o) => n + (pf?.outcomes[o] ?? 0), 0);
  const determinable = (pf?.pairs ?? 0) - (pf?.outcomes.undeterminable ?? 0);
  const passPairs = (pf?.pairs ?? 0) + (pp?.pairs ?? 0);
  return {
    // Of the PASS→FAIL flips we can locate, the share whose finding sat on code unchanged since the PASS.
    unchangedShareOfDeterminablePassFail: determinable > 0 ? unchanged / determinable : null,
    // Per judged PASS with a next attempt: how often the same lens later failed on unchanged code.
    // A lower bound — undeterminable flips are not counted as misses.
    unchangedPerPassLowerBound: passPairs > 0 ? unchanged / passPairs : null,
  };
}

function addResult(byKind, r) {
  const entry = (byKind[r.kind] ??= { pairs: 0, outcomes: {}, reasons: {}, findings: {} });
  entry.pairs += 1;
  bump(entry.outcomes, r.outcome);
  if (r.reason) bump(entry.reasons, r.reason);
  for (const f of r.findings ?? []) bump(entry.findings, f);
}

/** Counts only — lens names, pair kinds, classes and reasons. No ship ids, paths or finding text. */
export function summarizeAudit(results, meta = {}) {
  const lenses = {};
  const all = {};
  for (const r of results ?? []) {
    addResult((lenses[r.lens] ??= { byKind: {} }).byKind, r);
    addResult(all, r);
  }
  const out = { lenses: {}, totals: { ...all, ...rates(all) } };
  for (const [lens, { byKind }] of Object.entries(lenses).sort(([a], [b]) => a.localeCompare(b)))
    out.lenses[lens] = { ...byKind, rates: rates(byKind) };
  return {
    ...out,
    excluded: { ...(meta.excluded ?? {}) },
    skippedShips: meta.skippedShips ?? 0,
  };
}
