// @ts-nocheck — BENCH-ONLY (excluded from tsc, see tsconfig.json exclude); loose types deliberate.

/**
 * reviewer-eval corpus + fixture-asset layer (split from bench.mts, which owns the run loop and
 * scoring). Everything here is deterministic: row loading/linting, the fixture gate assets, and
 * the comparability hashes.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BenchAbort, parseCasesText } from '../../../decisions/eval/bench.mts';
import { checklistScript } from '../../reviewers.mts';
import { groupByPair } from './corpus/twins.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
// gate-engine/review/eval/reviewers → repo root is four levels up.
const repoRoot = path.resolve(here, '../../../..');
// Every shared module under skills/_devkit that a reviewer checklist imports. A fixture stages the
// checklist script alone, so each helper it pulls in must be staged beside it or the script dies at
// import with ERR_MODULE_NOT_FOUND before a single row is evaluated. A LIST rather than one constant
// per file: this broke once when checklist-store.mjs was extracted and only review-roots.mjs was
// staged — the next extraction should be an entry here, not another silent breakage.
const SHARED_HELPERS = ['review-roots.mjs', 'checklist-store.mjs'];
const sharedHelperPath = (file) => path.join(repoRoot, 'skills', '_devkit', file);

const sha12 = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12);

// Fixture layout every row lands in: backend rows stage under api/, frontend rows under web/, and
// correctness (domain 'all') rows may live under any of api/, web/, or src/ (its roots = the
// union). selectReviewers then fires exactly the row's target reviewer.
export const FIXTURE_CONFIG = {
  scanRoots: ['api', 'web', 'src'],
  sourceExtensions: ['ts', 'tsx', 'js', 'mjs'],
  review: { backendRoots: ['api'], frontendRoots: ['web'] },
};

export const casesFile = (reviewer) => path.join(here, `cases-${reviewer.skill}.jsonl`);

const ROW_ENUMS = {
  expected: ['FAIL', 'PASS'],
  difficulty: ['clear', 'borderline', 'adversarial'],
  holdout: [true, false],
  // 'known-answer' = adapted from an external ground truth (GHSA fix commit — sc-1408):
  // the only provenance whose golds support ABSOLUTE recall claims (methodology item 17).
  provenance: ['authored', 'mined', 'adapted', 'known-answer'],
  // Optional provenance/labeling fields (mined-corpus tooling) — absent is fine, present-but-wrong
  // is a lint failure like every other enum here.
  outcomeEvidence: [
    'addressed-marker',
    'resolved+line-touched',
    'human-rebuttal',
    'bot-withdrawal',
    'outdated-only',
  ],
  scopeConfirmed: ['confirmed', 'out-of-scope', 'unverifiable'],
};

/** Structural corpus lint — throws BenchAbort on the first malformed row. Cheap and always on:
 * a bad label silently mis-scoring a run is worse than a refused run. */
export function lintRows(rows, reviewerName) {
  const seen = new Set();
  for (const row of rows) {
    const where = `${reviewerName}/${row.id ?? '<no id>'}`;
    if (!row.id || seen.has(row.id)) throw new BenchAbort(2, `duplicate/missing id: ${where}`);
    // Checkpoint row keys are `<sectionKey>:<id>` and the section key may contain ':' — the id
    // must not, or the seam is ambiguous (corpus/audit.mts splits on the last ':').
    if (row.id.includes(':')) throw new BenchAbort(2, `${where}: id must not contain ':'`);
    seen.add(row.id);
    if (!row.note)
      throw new BenchAbort(2, `${where}: every row needs a note (why the label is right)`);
    for (const [field, allowed] of Object.entries(ROW_ENUMS))
      if (row[field] !== undefined && !allowed.includes(row[field]))
        throw new BenchAbort(2, `${where}: ${field}=${row[field]} not in ${allowed.join('|')}`);
    if (row.caseId !== undefined && typeof row.caseId !== 'string')
      throw new BenchAbort(2, `${where}: caseId must be a string`);
    if (row.caseId === '') throw new BenchAbort(2, `${where}: caseId must be a non-empty string`);
    if (row.sourcePr !== undefined && typeof row.sourcePr !== 'number')
      throw new BenchAbort(2, `${where}: sourcePr must be a number`);
    if (!row.expected) throw new BenchAbort(2, `${where}: missing expected`);
    if (row.expected === 'FAIL' && !(Array.isArray(row.expectItems) && row.expectItems.length > 0))
      throw new BenchAbort(2, `${where}: expected FAIL needs expectItems`);
    if (!row.repo?.base || !row.repo?.staged)
      throw new BenchAbort(2, `${where}: missing repo.base/staged`);
    if (row.reviewer !== reviewerName)
      throw new BenchAbort(
        2,
        `${where}: reviewer=${row.reviewer} but lives in ${reviewerName}'s file`,
      );
  }
  return rows;
}

/** Validate finalized partitions separately from proposals whose holdout is assigned on admission. */
export function assertHoldoutGroups(rows, reviewerName) {
  for (const [key, group] of groupByPair(rows)) {
    if (group.some((row) => !!row.holdout !== !!group[0].holdout))
      throw new BenchAbort(
        2,
        `${reviewerName}: pair group ${key} straddles the holdout boundary — ${group.map((row) => `${row.id}=${!!row.holdout}`).join(', ')}`,
      );
  }
  return rows;
}

/** The ≥3-holdout-per-class floor, checked at load (finalize only enforces it on --append; 3 of 5
 * suites drift under it). Warning by default; DEVKIT_HOLDOUT_FLOOR_STRICT=1 refuses (re-baseline epoch). */
export function holdoutFloorShortfalls(rows, floor = 3) {
  const out = [];
  for (const expected of ['FAIL', 'PASS']) {
    const n = rows.filter((r) => r.expected === expected && r.holdout).length;
    if (rows.some((r) => r.expected === expected) && n < floor)
      out.push(`${expected}: ${n} holdout row(s), floor ${floor}`);
  }
  return out;
}

/** Audits must be able to inspect structurally valid rows whose partition the benchmark refuses. */
export function readCorpusRows(reviewer, corpusFile = casesFile(reviewer)) {
  if (!existsSync(corpusFile))
    throw new BenchAbort(2, `reviewer-eval: missing ${path.basename(corpusFile)}`);
  return lintRows(parseCasesText(readFileSync(corpusFile, 'utf8')), reviewer.name);
}

export function loadRows(
  reviewer,
  { dev = false, only = null, corpusFile = casesFile(reviewer) } = {},
) {
  let rows = readCorpusRows(reviewer, corpusFile);
  assertHoldoutGroups(rows, reviewer.name);
  const short = holdoutFloorShortfalls(rows);
  if (short.length) {
    const msg = `${reviewer.name}: holdout floor not met — ${short.join('; ')}`;
    if (process.env.DEVKIT_HOLDOUT_FLOOR_STRICT === '1') throw new BenchAbort(2, msg);
    console.error(`reviewer-eval: WARNING ${msg}`);
  }
  if (dev) rows = rows.filter((r) => !r.holdout);
  if (only) rows = rows.filter((r) => r.id.startsWith(only));
  return rows;
}

/**
 * The gate files a fixture repo needs before the judge runs, keyed by fixture-relative path:
 * guard.config.json (roots that make selectReviewers fire the target), the reviewer's agent brief
 * under the default agentsDir, its checklist script at the EXACT path allowedToolsFor whitelists,
 * and the skill's SKILL.md (the brief's workflow sends the judge there for the detailed rules;
 * consumers always have it synced, so a fixture without it under-equips the judge). All read from
 * the repo source of truth (agents/, skills/) — bench and gate share one copy, so a brief/
 * checklist/SKILL edit is automatically what gets measured.
 */
export function buildAssets(reviewer) {
  const brief = readFileSync(path.join(repoRoot, 'agents', `${reviewer.name}.md`), 'utf8');
  const script = readFileSync(
    path.join(repoRoot, 'skills', reviewer.skill, 'scripts', 'checklist.mjs'),
    'utf8',
  );
  const skillMd = path.join(repoRoot, 'skills', reviewer.skill, 'SKILL.md');
  const assets = {
    'guard.config.json': `${JSON.stringify(FIXTURE_CONFIG, null, 2)}\n`,
    [`.claude/agents/${reviewer.name}.md`]: brief,
    ...Object.fromEntries(
      SHARED_HELPERS.map((file) => [
        `.claude/skills/_devkit/${file}`,
        readFileSync(sharedHelperPath(file), 'utf8'),
      ]),
    ),
    [checklistScript(reviewer)]: script,
  };
  if (existsSync(skillMd))
    assets[`.claude/skills/${reviewer.skill}/SKILL.md`] = readFileSync(skillMd, 'utf8');
  return assets;
}

/** gateHash: everything whose edit invalidates comparability — the cascade source, the pure gate
 * logic, and the reviewer's own brief + checklist + SKILL.md (the brief IS gate code, and
 * SKILL.md ships into fixtures, so its edits change what the judge reads). */
export function benchGateHash(reviewer) {
  const skillMd = path.join(repoRoot, 'skills', reviewer.skill, 'SKILL.md');
  return sha12(
    [
      readFileSync(path.join(repoRoot, 'gate-engine/review/run-review.mts'), 'utf8'),
      readFileSync(path.join(repoRoot, 'gate-engine/review/reviewers.mts'), 'utf8'),
      readFileSync(path.join(repoRoot, 'gate-engine/review/runtime.mts'), 'utf8'),
      // sc-1442: these supply judge-visible bytes (Targets framing, the advisory message wrapper,
      // the stdin diff plumbing) — editing any changes what every judge reads, so a baseline
      // earned under old bytes is not comparable. targets-block was a hash gap since sc-1441.
      readFileSync(path.join(repoRoot, 'gate-engine/review/evidence/targets-block.mts'), 'utf8'),
      readFileSync(path.join(repoRoot, 'gate-engine/review/evidence/commit-message.mts'), 'utf8'),
      readFileSync(path.join(repoRoot, 'gate-engine/review/evidence/staged-git.mts'), 'utf8'),
      // Every shared helper, for the same reason the checklist itself is hashed: it ships into the
      // fixture and its edits change what the gate does, so a baseline earned under the old one is
      // not comparable.
      ...SHARED_HELPERS.map((file) => readFileSync(sharedHelperPath(file), 'utf8')),
      // This module IS the fixture layer (FIXTURE_CONFIG, buildAssets) — hash its own source so a
      // fixture-behavior edit can never be compared against an incompatible baseline.
      readFileSync(fileURLToPath(import.meta.url), 'utf8'),
      readFileSync(path.join(repoRoot, 'agents', `${reviewer.name}.md`), 'utf8'),
      readFileSync(
        path.join(repoRoot, 'skills', reviewer.skill, 'scripts', 'checklist.mjs'),
        'utf8',
      ),
      existsSync(skillMd) ? readFileSync(skillMd, 'utf8') : '',
    ].join('\n\x00\n'),
  );
}

// Canonical (recursively key-sorted) JSON — deterministic regardless of a row's literal key
// insertion order, so an author reordering fields in a hand-edited .jsonl line is a no-op for
// hashing. Arrays keep their order (order is meaningful there — e.g. expectItems).
function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Per-row content hash — the unit comparisons pair on. Independent of every other row in the
 * corpus, so appending/removing sibling rows never changes a retained row's hash. */
export const rowHash = (row) => sha12(canonicalJSON(row));

/** The behavior-bearing slice of a row: what the reviewer SEES plus how its verdict is SCORED.
 * Documentation-only fields (note, provenance, source, outcomeEvidence, scopeConfirmed, caseId,
 * difficulty, holdout) are deliberately excluded — an honest provenance/metadata correction
 * (sc-1416) must not invalidate row pairing or stale a fresh checkpoint. Comparisons prefer
 * behaviorHash when BOTH sides carry it and fall back to strict rowHash for old baselines, so
 * this is additive: no comparability epoch break. */
const BEHAVIOR_FIELDS = ['reviewer', 'expected', 'expectItems', 'reasonPattern', 'repo'];
export const behaviorRowHash = (row) =>
  sha12(
    canonicalJSON(
      Object.fromEntries(
        BEHAVIOR_FIELDS.filter((k) => row[k] !== undefined).map((k) => [k, row[k]]),
      ),
    ),
  );

/** Both hashes for a written result row — spread in place of a bare `rowHash:` field. */
export const rowHashes = (row) => ({ rowHash: rowHash(row), behaviorHash: behaviorRowHash(row) });

/** ROW-SET hash: sha12 of the sorted list of per-row hashes, not the raw file text — reordering
 * rows in the .jsonl (e.g. an editor re-save) is a no-op, and this is the value baseline sections
 * still carry as `corpusHash` (comparability bookkeeping). Row-level comparability now runs on
 * `rowHash` instead — see compareReviewer in bench.mts, which pairs by row id and excludes shared
 * rows whose rowHash changed rather than hard-skipping the whole section. */
export function corpusHashFromRows(rows) {
  return sha12(rows.map(rowHash).sort().join('\n'));
}

export const corpusHash = (reviewer) =>
  corpusHashFromRows(parseCasesText(readFileSync(casesFile(reviewer), 'utf8')));
