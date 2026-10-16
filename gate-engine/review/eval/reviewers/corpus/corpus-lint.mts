// @ts-nocheck — BENCH-ONLY (excluded from tsc, see tsconfig.json exclude); loose types deliberate.

/** Structural corpus lint for the pre-commit benchmark stage (sc-2496): lintRows over every suite plus
 * the holdout floor, 0 model calls, no materialization. `bench.mts validate` stays the deep manual check. */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BenchAbort, parseCasesText } from '../../../../decisions/eval/bench.mts';
import { repositorySource } from '../../../../eval/source.mts';
import { REVIEWERS } from '../../../reviewers.mts';
import { assertHoldoutGroups, casesFile, holdoutFloorShortfalls, lintRows } from '../corpus.mts';
import { admissionProblems } from './admission.mts';

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
// Rows are new relative to the PR base during a ship, else to HEAD.
const BASE_REF = process.env.DEVKIT_SHIP_PR_BASE_SHA || 'HEAD';

let problems = 0;
let warnings = 0;
let rows = 0;
for (const reviewer of REVIEWERS) {
  const file = casesFile(reviewer);
  if (!existsSync(file)) continue;
  try {
    const parsed = lintRows(parseCasesText(readFileSync(file, 'utf8')), reviewer.name);
    assertHoldoutGroups(parsed, reviewer.name);
    rows += parsed.length;
    const short = holdoutFloorShortfalls(parsed);
    if (short.length) {
      const msg = `${reviewer.name}: holdout floor not met — ${short.join('; ')}`;
      if (process.env.DEVKIT_HOLDOUT_FLOOR_STRICT === '1') {
        console.error(`corpus-lint: PROBLEM ${msg}`);
        problems += 1;
      } else {
        console.error(`corpus-lint: WARNING ${msg}`);
        warnings += 1;
      }
    }
    // Inside the try: an unreadable base is one counted PROBLEM per corpus, never an uncaught throw.
    const baseText = repositorySource(ROOT, 'tree', BASE_REF).read(realpathSync(file));
    const baseIds = new Set(parseCasesText(baseText ?? '').map((r) => r.id));
    for (const msg of admissionProblems(parsed, baseIds, reviewer.name)) {
      console.error(`corpus-lint: PROBLEM ${msg}`);
      problems += 1;
    }
  } catch (e) {
    problems += 1;
    console.error(
      `corpus-lint: PROBLEM ${e instanceof BenchAbort ? e.message : String(e?.message ?? e)}`,
    );
  }
}
console.error(
  `corpus-lint: ${rows} row(s) across the reviewer corpora, ${problems} problem(s)${warnings ? `, ${warnings} warning(s)` : ''}`,
);
process.exit(problems > 0 ? 1 : 0);
