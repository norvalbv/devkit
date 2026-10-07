/** guard-coverage's `scope: "diff"` mode: block on coverage of the executable lines a change ADDS,
 * read from a scoped or full `devkit coverage-run`. */
import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { z } from 'zod';
import { type CoverageConfig, resolveGuardConfig } from '../config.mts';
import { failLine } from '../deterministic/reason.mts';
import { displayPath, humanAge } from './failures.mts';
import {
  artifactLine,
  BYPASS_REMEDY,
  canonicalPath,
  classifier,
  emitProvenance,
  listPaths,
  OPT_OUT_REMEDY,
  recordReviewNotice,
  repoTop,
  reviewNotMeasuredAbsent,
  reviewNotMeasuredEmpty,
} from './gate-shared.mts';
import { addedLineCoverage, addedLinesOf, lineRanges } from './lines.mts';
import { COVERAGE_DIR, COVERAGE_FILE } from './produce.mts';
import {
  type ArtifactRead,
  type Classify,
  checkProvenance,
  git,
  keysByPath,
  readArtifact,
} from './provenance.mts';

const RERUN_HINT =
  '   Measure them: `devkit coverage-run <test files that exercise them>` (seconds, not a full run).';
const REPO_KEYS = ['statements', 'functions', 'branches', 'lines'] as const;

// Only the fields lineHits reads; a wrong shape here is corrupt data, never a crash or a pass.
// istanbul always writes both maps; an entry without them is corrupt, not a file with no statements.
const entrySchema = z.object({
  s: z.record(z.string(), z.number()),
  statementMap: z.record(z.string(), z.object({ start: z.object({ line: z.number() }) })),
});
const artifactSchema = z.record(z.string(), entrySchema);

export type ScopeResult = { scope: 'repo' } | { scope: 'diff'; min: number } | { error: string };

/** Which mode the config asks for; a misspelt scope or a bad addedLines is an error, never a pass. */
export function resolveScope(coverage: Exclude<CoverageConfig, false>): ScopeResult {
  const { scope = 'repo', addedLines } = coverage;
  if (scope === 'repo') return { scope };
  if (scope !== 'diff')
    return { error: `coverage.scope must be "repo" or "diff", got ${JSON.stringify(scope)}` };
  const min = z.number().min(0).max(100).safeParse(addedLines);
  if (!min.success) {
    return {
      error: `coverage.scope "diff" needs coverage.addedLines, a number from 0 to 100 (got ${JSON.stringify(addedLines)})`,
    };
  }
  return { scope, min: min.data };
}

interface StagedChange {
  path: string;
  /** The pre-rename path, so a moved file is judged only on the lines the move changed. */
  from?: string;
}

/** Added, modified and renamed regular files between HEAD and the commit's index. */
function stagedChanges(top: string): StagedChange[] {
  const tokens = git(top, [
    'diff',
    '--cached',
    '--raw',
    '-z',
    '-M',
    '--diff-filter=AMR',
    'HEAD',
  ]).split('\0');
  const out: StagedChange[] = [];
  for (let i = 0; i < tokens.length;) {
    const head = tokens[i++] ?? '';
    if (!head.startsWith(':')) continue;
    const [, mode = '', , , status = ''] = head.slice(1).split(' ');
    const from = status.startsWith('R') ? tokens[i++] : undefined;
    const path = tokens[i++];
    // A symlink's added "line" is its target text, and a submodule has no lines at all.
    if (path && mode !== '120000' && mode !== '160000') out.push({ path, from });
  }
  return out;
}

/** Repo-relative path → the lines its staged version adds, for production source with any added. */
function addedProductionLines(top: string, classify: Classify): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const { path, from } of stagedChanges(top)) {
    if (classify(path, false) !== 'production') continue;
    const spec = from ? [from, path] : [path];
    const patch = git(top, [
      'diff',
      '--cached',
      '-U0',
      '-M',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      'HEAD',
      '--',
      ...spec,
    ]);
    const added = addedLinesOf(patch);
    if (added.size) out.set(path, added);
  }
  return out;
}

function failAbsent(changed: string[], cwd: string, top: string): number {
  failLine(
    `🚫 Coverage gate FAILED — no coverage data (${COVERAGE_FILE} absent) for added lines in:`,
  );
  for (const line of listPaths(changed, cwd, top)) failLine(line);
  console.error(RERUN_HINT);
  for (const line of BYPASS_REMEDY) console.error(line);
  for (const line of OPT_OUT_REMEDY) console.error(line);
  return 1;
}

function failUnreadable(file: string, why: string): number {
  failLine(`🚫 Coverage gate FAILED — ${COVERAGE_FILE} ${why}.`);
  console.error(artifactLine(file));
  console.error(RERUN_HINT);
  for (const line of BYPASS_REMEDY) console.error(line);
  return 1;
}

const pct = (covered: number, total: number): string =>
  total === 0 ? '100%' : `${((covered / total) * 100).toFixed(1)}%`;

/** The diff-scope gate. Exit 0 pass, 1 fail, 2 review-only NOT MEASURED. */
export function runDiffCoverage(
  cwd: string,
  coverage: Exclude<CoverageConfig, false>,
  min: number,
  reviewMode: boolean,
): number {
  const ignored = REPO_KEYS.filter((k) => coverage[k] !== undefined);
  if (ignored.length)
    console.log(
      `ℹ️  coverage.scope "diff" ignores ${ignored.join(', ')} — those are whole-repo thresholds.`,
    );
  const top = repoTop(cwd);
  const classify = classifier(
    resolveGuardConfig(cwd).sourceExtensions,
    relative(canonicalPath(top), canonicalPath(cwd)).replaceAll('\\', '/'),
  );
  let added: Map<string, Set<number>>;
  try {
    added = addedProductionLines(top, classify);
  } catch {
    failLine(
      '🚫 Coverage gate FAILED — git could not read the staged diff, so the added lines are unknown.',
    );
    for (const line of BYPASS_REMEDY) console.error(line);
    return 1;
  }
  if (added.size === 0) {
    console.log(
      '✓ Coverage gate passed (no added lines in production source; no artifact needed).',
    );
    return 0;
  }
  const changed = [...added.keys()].sort();

  const file = resolve(cwd, COVERAGE_FILE);
  if (!existsSync(file))
    return reviewMode ? reviewNotMeasuredAbsent(cwd) : failAbsent(changed, cwd, top);
  let artifact: ArtifactRead;
  let cov: z.infer<typeof artifactSchema>;
  try {
    artifact = readArtifact(file);
    cov = artifactSchema.parse(JSON.parse(artifact.bytes));
  } catch {
    return failUnreadable(file, 'is present but not valid coverage data');
  }
  if (Object.keys(cov).length === 0) {
    return reviewMode ? reviewNotMeasuredEmpty() : failUnreadable(file, 'measured no files');
  }

  const provenance = checkProvenance(cwd, resolve(cwd, COVERAGE_DIR), artifact, classify);
  emitProvenance(provenance);
  if (provenance.state === 'unknown') {
    if (reviewMode) {
      console.log(
        `⚠️  Coverage NOT MEASURED in this review — artifact provenance unknown (${provenance.reason}).`,
      );
      recordReviewNotice('unknown');
      return 2;
    }
    failLine(`🚫 Coverage gate FAILED — artifact provenance unknown (${provenance.reason}).`);
    console.error(artifactLine(file));
    console.error('   Diff scope reads line numbers, so it needs a run whose tree is known.');
    console.error(RERUN_HINT);
    for (const line of BYPASS_REMEDY) console.error(line);
    return 1;
  }
  const age = humanAge(Date.now() - Date.parse(provenance.manifest.finishedAt));
  const run = `run ${provenance.manifest.runId}, measured ${age} ago`;
  if (provenance.state === 'drift' && provenance.production.length > 0) {
    const say = reviewMode ? console.log : failLine;
    say(
      `${reviewMode ? '⚠️  Coverage NOT MEASURED in this review' : '🚫 Coverage gate FAILED'} — the artifact (${run}) predates:`,
    );
    for (const line of listPaths(provenance.production, cwd, top)) say(line);
    say(
      '   Re-run `devkit coverage-run <test files>` after your last source edit (and after the formatter).',
    );
    if (reviewMode) {
      recordReviewNotice('stale');
      return 2;
    }
    for (const line of BYPASS_REMEDY) console.error(line);
    return 1;
  }
  if (provenance.state === 'drift') {
    console.log(
      `⚠️  Coverage artifact predates ${provenance.tests.length} briefed test file(s) — passing, but re-run coverage if they matter.`,
    );
  }

  const keys = keysByPath(Object.keys(cov), provenance.manifest.roots);
  const rows: string[] = [];
  const notMeasured: string[] = [];
  let covered = 0;
  let total = 0;
  for (const path of changed) {
    const key = keys.get(path);
    if (key === undefined) {
      notMeasured.push(path);
      continue;
    }
    const r = addedLineCoverage(cov[key] ?? {}, added.get(path) ?? new Set());
    covered += r.covered;
    total += r.total;
    const missing = r.uncovered.length ? `   uncovered: ${lineRanges(r.uncovered)}` : '';
    if (r.total)
      rows.push(
        `     ${`${r.covered}/${r.total}`.padStart(7)}  ${displayPath(resolve(top, path), cwd)}${missing}`,
      );
  }
  const summary = `${covered}/${total} added executable lines covered (${pct(covered, total)}, min ${min}%)`;
  if (notMeasured.length === 0 && covered * 100 >= min * total) {
    console.log(`✓ Coverage gate passed (${summary}) — artifact ${run}.`);
    console.log(artifactLine(file));
    return 0;
  }
  failLine(`🚫 Coverage gate FAILED — ${summary}:`);
  for (const row of rows) failLine(row);
  if (notMeasured.length) {
    failLine(`   Not measured — source files with added lines absent from ${COVERAGE_FILE}:`);
    for (const line of listPaths(notMeasured, cwd, top)) failLine(line);
    console.error(
      '   Run a test that imports them, or exclude them from coverage if they hold no code.',
    );
  }
  console.error(artifactLine(file));
  console.error('   Add tests for the uncovered lines, then `devkit coverage-run <test files>`.');
  for (const line of BYPASS_REMEDY) console.error(line);
  return 1;
}
