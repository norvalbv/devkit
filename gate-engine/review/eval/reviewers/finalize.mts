#!/usr/bin/env node
// @ts-nocheck — BENCH-ONLY (excluded from tsc, see tsconfig.json exclude); loose types deliberate.

// Checks proposals or appends verified rows without splitting transitive caseId/variantOf groups.
// Workflow, immutability and private-source rules: docs/benchmarks/corpus-growth.md.

import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BenchAbort, parseCasesText } from '../../../decisions/eval/bench.mts';
import { BENCH_REVIEWERS, validateRow } from './bench.mts';
import { assertHoldoutGroups, casesFile, lintRows, loadRows } from './corpus.mts';
import { groupByPair, nearTwins, unrelatedTwins } from './corpus/twins.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
const RAW_DIR = path.join(here, 'raw');
const PROPOSALS_DIR = path.join(RAW_DIR, 'proposals');
const OVERLAY_FILE = path.join(RAW_DIR, 'audit-overlay.jsonl');

// Forbidden identifiers a real (private-repo) mined snippet could still be carrying — a proposal's
// fixture content must be a rewritten, generic-identifier minimal repro, never verbatim source.
// Checked here (not in bench.mts's shared validateRow) because it is specific to the
// candidates.jsonl→proposal provenance path, not every corpus row. Deliberately a bare substring
// (no \b anchors): word boundaries never fire inside identifiers, so `frinkClient`/`FRINK_API_KEY`
// would slip an anchored pattern — a leak scan should over-match, never under-match.
const LEAK_RE = /frink/i;

// ─── --check ────────────────────────────────────────────────────────────────────────

function readProposal(file) {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw new BenchAbort(2, `finalize: cannot read ${file} — ${e?.message ?? e}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new BenchAbort(2, `finalize: ${file} is not valid JSON — ${e?.message ?? e}`);
  }
}

function leakScan(row) {
  const hits = [];
  for (const [p, content] of Object.entries({ ...row.repo?.base, ...row.repo?.staged })) {
    if (content && LEAK_RE.test(content)) hits.push(p);
  }
  return hits;
}

/** The near-twin admission rule (one message per refused candidate vs existing or batch rows),
 * shared by --check and --append so the append path cannot admit what --check would refuse. */
export function unrelatedTwinProblems(candidates, existing, { threshold = 0.5 } = {}) {
  const ids = new Set(candidates.map((r) => r.id));
  return unrelatedTwins(nearTwins([...existing, ...candidates], { threshold }))
    .filter((t) => ids.has(t.a) || ids.has(t.b))
    .map((t) => {
      const [mine, other] = ids.has(t.a) ? [t.a, t.b] : [t.b, t.a];
      return `${mine}: near-twin of ${ids.has(other) ? 'batch' : 'existing'} row ${other} (Jaccard ${t.similarity}) with no caseId/variantOf link — an unlabelled copy leaks across the holdout boundary; link it as a minimal pair or drop it`;
    });
}

function checkProposal(file) {
  const row = readProposal(file);
  const problems = [];
  const warnings = [];

  if (!row.reviewer || typeof row.reviewer !== 'string') {
    problems.push('missing/invalid "reviewer" field — cannot determine which corpus this targets');
  } else {
    try {
      lintRows([row], row.reviewer);
    } catch (e) {
      problems.push(e instanceof BenchAbort ? e.message : String(e?.message ?? e));
    }
    // validateRow materializes the fixture and reads row.repo.* unguarded — only meaningful (and
    // only safe) once the structural lint above passed; a lint-failed row reports cleanly instead
    // of crashing on a missing repo.base/staged.
    if (problems.length === 0) {
      const { problems: vProblems, warnings: vWarnings } = validateRow(row);
      problems.push(...vProblems);
      warnings.push(...vWarnings);
    }
    // Admission by coverage need (corpus-rows-admitted-by-coverage-cell): refuse an unrelated
    // near-twin of an existing row; print the coverage cell the row would fill.
    if (problems.length === 0) {
      const target = BENCH_REVIEWERS.find((r) => r.name === row.reviewer);
      const existing = target ? loadRows(target) : [];
      problems.push(...unrelatedTwinProblems([row], existing));
      const cell = `${row.reviewer} × ${row.expected === 'FAIL' ? (row.expectItems ?? []).join('+') : 'decoy'} × ${row.difficulty ?? 'unlabelled'}`;
      const same = existing.filter(
        (r) =>
          r.expected === row.expected &&
          (r.difficulty ?? 'unlabelled') === (row.difficulty ?? 'unlabelled') &&
          (row.expected !== 'FAIL' ||
            (r.expectItems ?? []).join('+') === (row.expectItems ?? []).join('+')),
      ).length;
      warnings.push(
        `  coverage cell ${cell}: ${same} existing row(s) — this row makes ${same + 1}`,
      );
    }
  }

  const leaks = leakScan(row);
  if (leaks.length)
    problems.push(
      `fixture content still references a private-repo identifier in: ${leaks.join(', ')}`,
    );

  console.log(`finalize --check ${path.basename(file)} (id=${row.id ?? '<no id>'})`);
  if (problems.length === 0) console.log('  OK — no problems');
  else for (const p of problems) console.log(`  PROBLEM  ${p}`);
  for (const w of warnings) console.log(`  ${w}`);

  if (problems.length > 0) throw new BenchAbort(1, `finalize: ${problems.length} problem(s)`);
}

// ─── --append ───────────────────────────────────────────────────────────────────────

function listProposalFiles() {
  if (!existsSync(PROPOSALS_DIR)) return [];
  return readdirSync(PROPOSALS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => path.join(PROPOSALS_DIR, f));
}

function loadOverlay() {
  if (!existsSync(OVERLAY_FILE)) return [];
  return parseCasesText(readFileSync(OVERLAY_FILE, 'utf8'));
}

/** Canonical key order for an appended row — matches the shape hand-written rows already use, so
 * a human diffing cases-*.jsonl sees a consistent layout regardless of a proposal's key order. */
const KEY_ORDER = [
  'id',
  'reviewer',
  'expected',
  'expectItems',
  'reasonPattern',
  'repo',
  'note',
  'difficulty',
  'provenance',
  'source',
  'caseId',
  'sourcePr',
  'variantOf',
  'holdout',
];

function reorderRow(row) {
  const out = {};
  for (const k of KEY_ORDER) if (row[k] !== undefined) out[k] = row[k];
  for (const k of Object.keys(row)) if (!(k in out)) out[k] = row[k];
  return out;
}

/** Holdout per pair GROUP (caseId ∪ variantOf), never per row — a split pair puts a near-copy of a
 * holdout row in dev (sc-2495). Gold groups alternate in sorted order; decoy-only groups default to dev. */
export function assignHoldout(rows, existingRows = []) {
  // Group over batch + corpus together: a batch row linked to a row already IN the corpus inherits
  // that member's holdout (the corpus side is fixed); only groups with no corpus member alternate.
  const existingIds = new Set(existingRows.map((r) => r.id));
  const groups = groupByPair([...existingRows, ...rows]);
  let i = 0;
  for (const [key, g] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const fresh = g.filter((r) => !existingIds.has(r.id));
    if (fresh.length === 0) continue;
    const anchors = g.filter((r) => existingIds.has(r.id));
    const anchor = anchors[0];
    if (anchor) {
      if (anchors.some((r) => !!r.holdout !== !!anchor.holdout))
        throw new BenchAbort(
          2,
          `finalize: pair group ${key} joins existing rows on opposite sides of the holdout boundary — repair their partition before appending`,
        );
      for (const r of fresh) r.holdout = !!anchor.holdout;
      continue;
    }
    const hasGold = g.some((r) => r.expected === 'FAIL');
    const holdout = hasGold ? i % 2 === 0 : false;
    if (hasGold) i += 1;
    for (const r of fresh) r.holdout = holdout;
  }
}

/** Pack fresh members of complete pair groups; existing rows can connect otherwise separate proposals. */
export function packByMax(rows, max, existingRows = []) {
  if (max === null) return { accepted: rows, deferred: [] };
  const freshIds = new Set(rows.map((r) => r.id));
  const groups = [...groupByPair([...existingRows, ...rows]).values()]
    .map((group) => group.filter((row) => freshIds.has(row.id)))
    .filter((group) => group.length > 0);
  const ordered = groups.sort((a, b) => {
    const ai = a.reduce((m, r) => (r.id < m ? r.id : m), a[0].id);
    const bi = b.reduce((m, r) => (r.id < m ? r.id : m), b[0].id);
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });
  const accepted = [];
  const deferred = [];
  let budget = max;
  for (const group of ordered) {
    if (group.length <= budget) {
      accepted.push(...group);
      budget -= group.length;
    } else {
      deferred.push(...group);
    }
  }
  return { accepted, deferred };
}

/** Re-verifies the ≥3-holdout-per-expected-class invariant across (existing + accepted) rows;
 * flips the minimal number of ACCEPTED rows (deterministic, sorted by id) to holdout:true when a
 * class would otherwise fall short, and reports every flip. */
function enforceHoldoutFloor(existingRows, acceptedRows) {
  // Flips whole pair GROUPS (never a lone member), smallest group key first, until the class floor
  // holds; a group anchored to a corpus row inherited its holdout and is never flipped.
  const flipped = [];
  const existingIds = new Set(existingRows.map((r) => r.id));
  const groups = [...groupByPair([...existingRows, ...acceptedRows]).entries()]
    .filter(([, g]) => !g.some((r) => existingIds.has(r.id)))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const expected of ['FAIL', 'PASS']) {
    const count = () =>
      [...existingRows, ...acceptedRows].filter((r) => r.expected === expected && r.holdout).length;
    for (const [, g] of groups) {
      if (count() >= 3) break;
      if (!g.some((r) => r.expected === expected && !r.holdout)) continue;
      for (const r of g) {
        if (!r.holdout) flipped.push(r.id);
        r.holdout = true;
      }
    }
  }
  return flipped;
}

/** Exclusive append lock beside the cases file — appendSuite reads the corpus, then appends; two
 * concurrent --append invocations would both read pre-append state and write duplicate ids,
 * corrupting the corpus for every later loadRows caller. `wx` creation is the atomicity; a lock
 * older than 10 min is treated as stale (a crashed run) and stolen with a warning. */
const LOCK_STALE_MS = 10 * 60 * 1000;
function acquireAppendLock(reviewer) {
  const lockPath = `${casesFile(reviewer)}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath, `${process.pid} ${new Date().toISOString()}\n`, { flag: 'wx' });
      return lockPath;
    } catch (e) {
      if ((e as { code?: string }).code !== 'EEXIST') throw e;
      const age = Date.now() - statSync(lockPath).mtimeMs;
      if (age > LOCK_STALE_MS) {
        console.error(`finalize: stealing stale append lock (${Math.round(age / 1000)}s old)`);
        unlinkSync(lockPath);
        continue;
      }
      throw new BenchAbort(
        2,
        `finalize: another --append holds ${path.basename(lockPath)} (age ${Math.round(age / 1000)}s) — retry when it finishes`,
      );
    }
  }
  throw new BenchAbort(2, 'finalize: could not acquire append lock');
}

function appendSuite(suite, max) {
  const reviewer = BENCH_REVIEWERS.find((r) => r.skill === suite);
  if (!reviewer) {
    throw new BenchAbort(
      2,
      `finalize: unknown --suite ${suite} (want one of ${BENCH_REVIEWERS.map((r) => r.skill).join(', ')})`,
    );
  }

  // Held for the remainder of the process (this is a one-shot CLI); released on every exit path
  // via the 'exit' hook, and by the stale-lock rule if the process is SIGKILLed.
  const lockPath = acquireAppendLock(reviewer);
  process.on('exit', () => {
    try {
      unlinkSync(lockPath);
    } catch {
      /* already gone — fine */
    }
  });

  const proposalFiles = listProposalFiles();
  const allProposals = proposalFiles.map((f) => ({ file: f, row: readProposal(f) }));

  const overlay = loadOverlay();
  const matchedRefs = new Set();
  for (const { ref, set } of overlay) {
    const hit = allProposals.find((p) => p.row.id === ref);
    if (hit) {
      Object.assign(hit.row, set);
      matchedRefs.add(ref);
    }
  }
  for (const { ref } of overlay)
    if (!matchedRefs.has(ref))
      console.log(`finalize: audit-overlay ref "${ref}" matched no proposal — ignored`);

  const suiteRows = allProposals.filter((p) => p.row.reviewer === reviewer.name).map((p) => p.row);
  if (suiteRows.length === 0) {
    console.log(`finalize: no raw/proposals/*.json targets ${reviewer.name} — nothing to append`);
    return;
  }

  const existingRows = loadRows(reviewer);
  const existingIds = new Set(existingRows.map((r) => r.id));
  const fresh = [];
  for (const row of suiteRows) {
    if (existingIds.has(row.id)) {
      console.log(`finalize: ${row.id} already in ${path.basename(casesFile(reviewer))} — skipped`);
      continue;
    }
    fresh.push(row);
  }
  if (fresh.length === 0) {
    console.log('finalize: every proposal for this suite is already in the corpus — nothing to do');
    return;
  }

  // Same structural lint --check runs on a single proposal before it's ever hand-approved — run it
  // again here, on the post-overlay rows, right before anything is written. A row can reach this
  // point without ever having gone through --check (nothing enforces that ordering), and the
  // audit-overlay's Object.assign above can itself reintroduce a broken field on a row that DID
  // pass --check earlier. lintRows throws BenchAbort on the first bad row, aborting the whole
  // batch before a single line is appended — a refused append is safer than a corpus row that
  // crashes every downstream loadRows() (bench/gate) for this reviewer.
  lintRows(fresh, reviewer.name);
  // Same reasoning for the leak scan: --append is the last line of defense before private-repo
  // identifiers reach the public corpus, and nothing guarantees --check ran (or ran after the
  // overlay was applied).
  for (const row of fresh) {
    const leaks = leakScan(row);
    if (leaks.length)
      throw new BenchAbort(
        2,
        `finalize: ${row.id} fixture content references a private-repo identifier in: ${leaks.join(', ')} — fix the proposal (or overlay) before appending`,
      );
  }

  // And the admission rule: --append is where a row actually enters the corpus, and the overlay
  // may be what added (or removed) the pair link, so the twin check runs on the post-overlay rows.
  const twinProblems = unrelatedTwinProblems(fresh, existingRows);
  if (twinProblems.length)
    throw new BenchAbort(
      2,
      `finalize: refused by the near-twin rule —\n  ${twinProblems.join('\n  ')}`,
    );

  assignHoldout(fresh, existingRows);

  const { accepted, deferred } = packByMax(fresh, max, existingRows);
  if (accepted.length === 0) {
    console.log(
      `finalize: --max ${max} is smaller than every remaining pair group — nothing appended this batch`,
    );
    return;
  }

  const flipped = enforceHoldoutFloor(existingRows, accepted);
  if (flipped.length)
    console.log(
      `finalize: flipped ${flipped.length} row(s) to holdout:true to hold the ≥3-per-class floor — ${flipped.join(', ')}`,
    );

  const allNow = [...existingRows, ...accepted];
  assertHoldoutGroups(allNow, reviewer.name);
  const file = casesFile(reviewer);
  for (const row of accepted) appendFileSync(file, `${JSON.stringify(reorderRow(row))}\n`);

  const countFor = (expected, holdout) =>
    allNow.filter((r) => r.expected === expected && !!r.holdout === holdout).length;

  console.log(
    [
      `finalize: appended ${accepted.length} row(s) to ${path.basename(file)}: ${accepted.map((r) => r.id).join(', ')}`,
      deferred.length
        ? `  deferred (exceeded --max, pair group kept whole): ${deferred.map((r) => r.id).join(', ')}`
        : null,
      `  corpus now: ${countFor('FAIL', false) + countFor('FAIL', true)} gold ` +
        `(${countFor('FAIL', true)} holdout) / ${countFor('PASS', false) + countFor('PASS', true)} decoy ` +
        `(${countFor('PASS', true)} holdout)`,
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

// ─── CLI ──────────────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(
    [
      'usage: finalize.mts --check <raw/proposals/foo.json>',
      '       finalize.mts --append --suite <s> [--max N]',
    ].join('\n'),
  );
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
    printHelp();
    return;
  }
  if (argv.includes('--check')) {
    const idx = argv.indexOf('--check');
    const file = argv[idx + 1];
    if (!file) throw new BenchAbort(2, 'finalize: --check needs a <raw/proposals/foo.json> path');
    checkProposal(path.resolve(file));
    return;
  }
  if (argv.includes('--append')) {
    const suiteIdx = argv.indexOf('--suite');
    const suite = suiteIdx !== -1 ? argv[suiteIdx + 1] : null;
    if (!suite) throw new BenchAbort(2, 'finalize: --append needs --suite <s>');
    const maxIdx = argv.indexOf('--max');
    const max = maxIdx !== -1 ? Number.parseInt(argv[maxIdx + 1], 10) : null;
    if (max !== null && (!Number.isFinite(max) || max <= 0))
      throw new BenchAbort(2, 'finalize: --max must be a positive integer');
    appendSuite(suite, max);
    return;
  }
  printHelp();
  process.exit(2);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    main();
  } catch (e) {
    if (e instanceof BenchAbort) {
      console.error(e.message);
      process.exit(e.code);
    }
    throw e;
  }
}
