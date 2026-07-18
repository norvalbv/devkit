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

const here = path.dirname(fileURLToPath(import.meta.url));
// gate-engine/review/eval/reviewers → repo root is four levels up.
const repoRoot = path.resolve(here, '../../../..');
const reviewRootsHelper = path.join(repoRoot, 'skills', '_devkit', 'review-roots.mjs');

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
  provenance: ['authored', 'mined', 'adapted'],
};

/** Structural corpus lint — throws BenchAbort on the first malformed row. Cheap and always on:
 * a bad label silently mis-scoring a run is worse than a refused run. */
export function lintRows(rows, reviewerName) {
  const seen = new Set();
  for (const row of rows) {
    const where = `${reviewerName}/${row.id ?? '<no id>'}`;
    if (!row.id || seen.has(row.id)) throw new BenchAbort(2, `duplicate/missing id: ${where}`);
    seen.add(row.id);
    if (!row.note)
      throw new BenchAbort(2, `${where}: every row needs a note (why the label is right)`);
    for (const [field, allowed] of Object.entries(ROW_ENUMS))
      if (row[field] !== undefined && !allowed.includes(row[field]))
        throw new BenchAbort(2, `${where}: ${field}=${row[field]} not in ${allowed.join('|')}`);
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

export function loadRows(reviewer, { dev = false, only = null } = {}) {
  const file = casesFile(reviewer);
  if (!existsSync(file)) throw new BenchAbort(2, `reviewer-eval: missing ${path.basename(file)}`);
  let rows = lintRows(parseCasesText(readFileSync(file, 'utf8')), reviewer.name);
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
    '.claude/skills/_devkit/review-roots.mjs': readFileSync(reviewRootsHelper, 'utf8'),
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
      readFileSync(reviewRootsHelper, 'utf8'),
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

export const corpusHash = (reviewer) => sha12(readFileSync(casesFile(reviewer), 'utf8'));
