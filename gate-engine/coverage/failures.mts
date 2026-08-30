import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * The regex handed to vitest's `--retry.condition`, which retries ONLY errors whose message matches.
 *
 * Deliberately narrow. A blanket `--retry` would launder genuine order-dependent and racy assertion
 * failures — the class most worth surfacing — into green, on a command consumers have already wired
 * into `test:run:coverage`. Scoped to the timeout shape it rescues the load artifact and nothing else:
 * verified against vitest 4.1.10 with one timeout flake and one `expect(2).toBe(99)` in the same file,
 * the timeout was retried and passed while the AssertionError was not retried and the run exited 1.
 */
export const RETRY_CONDITION = '(Test|Hook) timed out';

/** vitest's json-reporter output. Lands in the run directory, which only this run may touch. */
export const RESULTS_NAME = 'results.json';

/** The advisory sidecar a CLEARING run leaves beside the artifact it removed. */
export const CLEAR_MARKER_NAME = '.last-clear.json';

/** A test that failed an attempt and passed a later one — i.e. the retry earned its keep. */
export interface FlakyTest {
  file: string;
  name: string;
}

export interface RunDiagnosis {
  /** Absolute paths of test files with at least one STILL-failing test. */
  failedFiles: string[];
  /** Tests rescued by a retry. Under our injected condition these are timeouts by construction. */
  flaky: FlakyTest[];
}

/** What a run that cleared the artifact leaves behind so the next reader knows what happened. */
export interface ClearMarker {
  clearedAt: string;
  previousMtime: number | null;
  head: string | null;
  failedFiles: string[];
}

interface VitestAssertion {
  status?: string;
  fullName?: string;
  title?: string;
  failureMessages?: string[];
}
interface VitestSuite {
  name?: string;
  status?: string;
  assertionResults?: VitestAssertion[];
}
interface VitestReport {
  testResults?: VitestSuite[];
}

/** realpath where possible — vitest reports /private/tmp for a file created under /tmp on macOS. */
const canonical = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/**
 * Read vitest's json report into the two facts worth printing.
 *
 * Returns null — say nothing — when the file is absent, unparseable, or not the shape we expect. An
 * older vitest silently ignores the dotted `--outputFile.json`, and a consumer who passed their own
 * `--reporter` never got ours, so "no report" is an ordinary outcome rather than an error. The gate
 * is unaffected either way: this is diagnosis, never verification.
 */
export function readDiagnosis(resultsFile: string): RunDiagnosis | null {
  try {
    const report: VitestReport = JSON.parse(readFileSync(resultsFile, 'utf8'));
    if (!Array.isArray(report?.testResults)) return null;

    // A SET, not an array. vitest's `projects` put one file in the report once per project it
    // matches, so a suite run under two environments arrives twice — and every reader downstream (the
    // printed list, its count, the marker, the staged-diff answer) would repeat it. "2 test file(s)
    // failed: a.test.ts, a.test.ts" reads as two problems. Insertion order is preserved, so the list
    // still matches the order vitest reported.
    const failedFiles = new Set<string>();
    const flaky: FlakyTest[] = [];
    for (const suite of report.testResults) {
      const file = suite?.name;
      if (!file) continue;
      let failed = false;
      for (const a of suite.assertionResults ?? []) {
        const messages = a?.failureMessages ?? [];
        if (a?.status === 'failed') {
          failed = true;
        } else if (a?.status === 'passed' && messages.length > 0) {
          // Passed, yet carrying the record of a failure: an earlier attempt threw and the retry
          // rescued it. This is the ONLY place vitest exposes that, and it is why the flaky report
          // can be exact rather than inferred from the console.
          flaky.push({ file, name: a.fullName ?? a.title ?? '' });
        }
      }
      // A suite can fail with NO assertion results at all — a collection or import error kills the
      // file before any test runs. Naming the file is the point, so take the suite's own verdict too.
      if (failed || suite.status === 'failed') failedFiles.add(file);
    }
    return { failedFiles: [...failedFiles], flaky };
  } catch {
    // Absent, torn, or shaped unlike VitestReport. All three mean the same thing to the caller —
    // there is nothing to say — and none of them may cost somebody their test run.
    return null;
  }
}

/**
 * Absolute paths of the staged files, or null when git cannot answer.
 *
 * null is NOT an empty diff, and the caller must not collapse the two: an empty list licenses the
 * sentence "none of them are in your staged diff", which is a claim. devkit runs inside a repo it does
 * not own and may be invoked outside a work tree entirely — same reason sc-1959 ruled that a gate
 * which cannot run git must not report a missing catalog.
 */
export function stagedFiles(cwd: string): string[] | null {
  const git = (args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const top = canonical(git(['rev-parse', '--show-toplevel']).trim());
    return git(['diff', '--cached', '--name-only', '-z'])
      .split('\0')
      .filter(Boolean)
      .map((p) => canonical(join(top, p)));
  } catch {
    return null;
  }
}

/** The short HEAD sha, or null outside a work tree. Recorded so a stale marker dates itself. */
export function headSha(cwd: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** Failed files that are also staged. null propagates: unknown stays unknown, never "none". */
export function stagedIntersection(
  failedFiles: string[],
  staged: string[] | null,
): string[] | null {
  if (staged === null) return null;
  const set = new Set(staged);
  return failedFiles.map(canonical).filter((f) => set.has(f));
}

/** Repo-relative where that is shorter and inside cwd; absolute otherwise. Paths are for humans. */
export function displayPath(file: string, cwd: string): string {
  const rel = relative(canonical(cwd), canonical(file));
  return rel && !rel.startsWith('..') ? rel : file;
}

/** "4m", "2h", "3d" — how old the discarded artifact is, so its relevance is judgeable at a glance. */
export function humanAge(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/** Enough to see the shape of a failure; short enough not to bury vitest's own summary. */
const MAX_LISTED_FILES = 10;

const markerPath = (coverageDir: string): string => join(coverageDir, CLEAR_MARKER_NAME);

/** Best-effort: an unwritable marker must never fail somebody's test run. Advisory data only. */
export function writeClearMarker(coverageDir: string, marker: ClearMarker): void {
  try {
    writeFileSync(markerPath(coverageDir), `${JSON.stringify(marker, null, 2)}\n`);
  } catch {
    /* diagnosis is a courtesy, not a guarantee */
  }
}

export function removeClearMarker(coverageDir: string): void {
  try {
    rmSync(markerPath(coverageDir), { force: true });
  } catch {
    /* see writeClearMarker */
  }
}

/** The marker, or null when absent/corrupt. Never throws — the gate's verdict cannot depend on it. */
export function readClearMarker(coverageDir: string): ClearMarker | null {
  const file = markerPath(coverageDir);
  if (!existsSync(file)) return null;
  try {
    const parsed: Partial<ClearMarker> = JSON.parse(readFileSync(file, 'utf8'));
    // clearedAt is the marker's identity — a payload without one is some other file that happens to
    // share the name, and inventing a timestamp for it would date the gate's message wrongly.
    if (!parsed?.clearedAt) return null;
    return {
      clearedAt: parsed.clearedAt,
      previousMtime: parsed.previousMtime ?? null,
      head: parsed.head ?? null,
      failedFiles: Array.isArray(parsed.failedFiles) ? parsed.failedFiles : [],
    };
  } catch {
    return null;
  }
}

/**
 * The producer's post-run lines: what failed, whether it is yours, and — when a retry rescued
 * something — that the suite is flaking on load rather than breaking.
 *
 * The timeout claim is made ONLY from rescued tests. vitest's json reporter replaces a timeout's
 * message with `Error: STACK_TRACE_ERROR`, so the shape cannot be read off a surviving failure; but a
 * rescue can only have happened through RETRY_CONDITION, which matches timeouts alone. Asserting the
 * shape where it is provable and staying quiet where it is not is the difference between a hint and a
 * guess.
 */
export function formatDiagnosis(
  diagnosis: RunDiagnosis,
  cwd: string,
  staged: string[] | null,
): string[] {
  const lines: string[] = [];
  if (diagnosis.flaky.length > 0) {
    lines.push(
      `⚠️  ${diagnosis.flaky.length} test(s) passed only on retry — the suite is flaking, not green:`,
    );
    for (const t of diagnosis.flaky) lines.push(`     ${displayPath(t.file, cwd)} > ${t.name}`);
    lines.push(
      '   These timed out rather than failing an assertion, which is the load-flake shape.',
    );
    lines.push('   If it recurs, lower parallelism (--maxWorkers=50%) or raise testTimeout.');
  }
  if (diagnosis.failedFiles.length > 0) {
    lines.push(`🚫 ${diagnosis.failedFiles.length} test file(s) failed:`);
    for (const f of diagnosis.failedFiles.slice(0, MAX_LISTED_FILES)) {
      lines.push(`     ${displayPath(f, cwd)}`);
    }
    const hidden = diagnosis.failedFiles.length - MAX_LISTED_FILES;
    if (hidden > 0) lines.push(`     …and ${hidden} more`);
    const mine = stagedIntersection(diagnosis.failedFiles, staged);
    if (mine !== null) {
      lines.push(
        mine.length === 0
          ? '   None of them are in your staged diff.'
          : `   In your staged diff: ${mine.map((f) => displayPath(f, cwd)).join(', ')}`,
      );
    }
  }
  return lines;
}

/** The gate's extra lines when the artifact is absent BECAUSE a failed run discarded it. */
export function formatClearMarker(marker: ClearMarker, cwd: string, now = Date.now()): string[] {
  const age = humanAge(now - Date.parse(marker.clearedAt));
  const at = Number.isNaN(Date.parse(marker.clearedAt)) ? marker.clearedAt : `${age} ago`;
  const head = marker.head ? ` (HEAD ${marker.head})` : '';
  const lines = [
    `   The previous artifact was discarded by a test run that produced no report,`,
    `   ${at}${head}.`,
  ];
  if (marker.failedFiles.length > 0) {
    lines.push(`   Failed: ${marker.failedFiles.map((f) => displayPath(f, cwd)).join(', ')}`);
  }
  return lines;
}
