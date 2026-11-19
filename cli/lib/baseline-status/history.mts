/**
 * The runs that can answer: a branch's GitHub head's first-parent commits, looked up by sha, or
 * for `--history` the workflow's newest runs on every branch.
 *
 * Distance from the head is then a fact about git, not about how fresh GitHub's run listing is.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gitRunner, line, ok } from '../ship/base-drift/git-run.mts';
import {
  GhUnavailable,
  type RunRef,
  type UnknownReason,
  branchHead,
  isUsableRun,
  recentRuns,
  runsForCommit,
} from './gh.mts';
import type { FileOutcome, TestReportSummary } from './produce.mts';
import { loadSummary } from './source.mts';
import { type TestStatus, normaliseTestName, testVerdict } from './test-verdict.mts';

/** Download failures that describe one run's artifact, so the window goes on without it. */
const RUN_DATA_REASONS = new Set<UnknownReason>([
  'no-artifact',
  'artifact-unreadable',
  'schema-mismatch',
]);

/** `--history` window: about a third of listed runs are in flight or cancelled and carry no report. */
export const DEFAULT_HISTORY_RUNS = 20;

/** A run, and how many first-parent commits its commit sits behind the branch head. */
export interface WalkedRun {
  run: RunRef;
  behind: number;
}

/** git's stdout, or null when it failed; the runner is bounded by a timeout and never prompts. */
function git(cwd: string, args: string[]): string | null {
  const result = gitRunner(cwd)(args);
  return ok(result) ? line(result).trim() : null;
}

/** `at` anchors the walk at a local commit (a PR's base) instead of the branch's GitHub head. */
interface WalkOptions {
  cwd: string;
  workflow: string;
  ref: string;
  maxCommits: number;
  at?: string;
}

/** `at` as a full commit sha; a revspec this checkout cannot resolve is a history fact, not a guess. */
function anchor(cwd: string, at: string): string {
  const sha = git(cwd, ['rev-parse', '--verify', '--quiet', `${at}^{commit}`]);
  if (sha) return sha;
  throw new GhUnavailable('history-unavailable', `--at ${at} is not a commit in this checkout`);
}

/** Runs newest-first across the head's first-parent history, looked up one commit at a time. */
export class BranchWalk {
  readonly head: string;
  readonly commitsWithoutRun: string[] = [];
  /** null when the head is not in this checkout; the first lookup then reports it. */
  private readonly commits: string[] | null;
  private readonly runs: WalkedRun[] = [];
  private readonly opts: WalkOptions;
  private looked = 0;

  constructor(opts: WalkOptions) {
    this.opts = opts;
    this.head = opts.at ? anchor(opts.cwd, opts.at) : branchHead({ cwd: opts.cwd, ref: opts.ref });
    const list = git(opts.cwd, [
      'rev-list',
      '--first-parent',
      `--max-count=${opts.maxCommits}`,
      this.head,
    ]);
    this.commits = list === null ? null : list.split('\n').filter(Boolean);
  }

  /** The i-th run, fetching the next commit's runs only once every earlier run has been consumed. */
  at(i: number): WalkedRun | undefined {
    if (this.commits === null) {
      throw new GhUnavailable(
        'history-unavailable',
        `${this.opts.ref} head ${this.head.slice(0, 8)} is not in this checkout`,
      );
    }
    while (this.runs.length <= i && this.looked < this.commits.length) {
      const behind = this.looked;
      const sha = this.commits[behind] ?? '';
      const found = runsForCommit({ ...this.opts, sha });
      this.looked++;
      if (found.length === 0) this.commitsWithoutRun.push(sha);
      for (const run of found) this.runs.push({ run, behind });
    }
    return this.runs[i];
  }

  /** How many commits have been looked up so far. */
  get commitsLooked(): number {
    return this.looked;
  }

  /** The walk ran out before --max-runs at a shallow cut of THIS history, not a shallow elsewhere. */
  endedAtShallowBoundary(): boolean {
    const last = this.commits?.at(-1);
    const path = git(this.opts.cwd, ['rev-parse', '--git-path', 'shallow']);
    if (!last || (this.commits?.length ?? 0) >= this.opts.maxCommits || !path) return false;
    try {
      return readFileSync(resolve(this.opts.cwd, path), 'utf8').split('\n').includes(last);
    } catch {
      return false; // no shallow file: the clone is complete
    }
  }
}

/** One run's line in `--history`: the file's outcome, or under `--test` that test's verdict. */
export type HistoryStatus = TestStatus | FileOutcome | 'not-in-run';

export interface HistoryRow {
  runId: number;
  attempt: number;
  branch: string;
  event: string;
  sha: string;
  createdAt: string;
  status: HistoryStatus;
  reason?: string;
}

export interface HistoryAnswer {
  workflow: string;
  path: string;
  test?: string;
  /** Runs gh listed, usable or not; `rows` plus `skippedRuns` account for every one. */
  listed: number;
  /** Newest first. */
  rows: HistoryRow[];
  skippedRuns: { runId: number; branch: string; conclusion: string; why: string }[];
  /** `failed` and `passed` make the rate; `filePassed` does not, since its test may not exist there. */
  counts: { failed: number; passed: number; filePassed: number; other: number };
  latestFailure: { runId: number; createdAt: string } | null;
  failedBranches: string[];
  passedBranches: string[];
  reason?: UnknownReason;
  detail?: string;
}

/** What one run's summary says about the file, or the test in it; no git probe of other heads. */
function rowStatus(
  summary: TestReportSummary,
  path: string,
  test: string | undefined,
): Pick<HistoryRow, 'status' | 'reason'> {
  if (!Object.hasOwn(summary.files, path)) {
    return { status: 'not-in-run', reason: "the file is not in this run's report" };
  }
  const outcome = summary.files[path];
  if (!test) return { status: outcome };
  const { status, reason } = testVerdict(summary, outcome, path, test);
  return reason ? { status, reason } : { status };
}

/** A run `--history` could not read, with the reason. */
function skipped(run: RunRef, why: string): HistoryAnswer['skippedRuns'][number] {
  return {
    runId: run.databaseId,
    branch: run.headBranch,
    conclusion: run.conclusion || run.status,
    why,
  };
}

/** Fill the counts and branch spread from the rows, which arrive newest first. */
function tally(answer: HistoryAnswer): void {
  const failed = new Set<string>();
  const passed = new Set<string>();
  for (const row of answer.rows) {
    if (row.status === 'failed') {
      answer.counts.failed++;
      failed.add(row.branch);
      answer.latestFailure ??= { runId: row.runId, createdAt: row.createdAt };
    } else if (row.status === 'passed') {
      answer.counts.passed++;
      passed.add(row.branch);
    } else if (row.status === 'file-passed') answer.counts.filePassed++;
    else answer.counts.other++;
  }
  answer.failedBranches = [...failed];
  answer.passedBranches = [...passed];
}

/**
 * One file's, or one test's, outcome in each of the workflow's newest runs on every branch.
 * GitHub's unfiltered run list is fresh; only its branch-filtered form serves stale pages.
 */
export function queryHistory({
  cwd,
  workflow,
  artifact,
  path,
  test,
  maxRuns,
}: {
  cwd: string;
  workflow: string;
  artifact: string;
  path: string;
  test?: string;
  maxRuns: number;
}): HistoryAnswer {
  const name = test === undefined ? undefined : normaliseTestName(test, path);
  const answer: HistoryAnswer = {
    workflow,
    path,
    listed: 0,
    rows: [],
    skippedRuns: [],
    counts: { failed: 0, passed: 0, filePassed: 0, other: 0 },
    latestFailure: null,
    failedBranches: [],
    passedBranches: [],
  };
  if (name !== undefined) answer.test = name;
  let runs: RunRef[];
  try {
    runs = recentRuns({ cwd, workflow, limit: maxRuns });
  } catch (e) {
    if (!(e instanceof GhUnavailable)) throw e;
    return { ...answer, reason: e.reason, detail: e.message };
  }
  answer.listed = runs.length;
  for (const run of runs) {
    if (!isUsableRun(run)) {
      answer.skippedRuns.push(
        skipped(run, 'did not run to a pass/fail conclusion, so it carries no test report'),
      );
      continue;
    }
    let summary: TestReportSummary;
    try {
      summary = loadSummary({ cwd, run, artifact });
    } catch (e) {
      // A run without a readable report is a fact about that run; gh failing to answer is not.
      if (e instanceof GhUnavailable && !RUN_DATA_REASONS.has(e.reason)) {
        answer.reason = e.reason;
        answer.detail = e.message;
        break;
      }
      answer.skippedRuns.push(skipped(run, e instanceof Error ? e.message : String(e)));
      continue;
    }
    answer.rows.push({
      runId: run.databaseId,
      attempt: run.attempt,
      branch: run.headBranch,
      event: run.event,
      sha: run.headSha,
      createdAt: run.createdAt,
      ...rowStatus(summary, path, name),
    });
  }
  tally(answer);
  return answer;
}

/** `--history` as plain text: one line per run, then the rate over test-level verdicts only. */
export function renderHistory(answer: HistoryAnswer): string[] {
  const subject = answer.test ? `${answer.path} > ${answer.test}` : answer.path;
  if (answer.reason) {
    return [`❔ history of ${subject} unknown — ${answer.reason}`, `   ${answer.detail ?? ''}`];
  }
  const lines = [`History of ${subject} in ${answer.workflow}, newest first, all branches:`];
  for (const row of answer.rows) {
    const where = `${row.branch} (${row.event}, ${row.sha.slice(0, 8)})`;
    lines.push(`  ${row.createdAt}  run ${row.runId}  ${where}  ${row.status}`);
  }
  for (const s of answer.skippedRuns) {
    lines.push(`  skipped run ${s.runId} on ${s.branch} (${s.conclusion}): ${s.why}`);
  }
  const { failed, passed, filePassed } = answer.counts;
  const level = answer.test ? 'a test-level verdict' : 'a file verdict';
  const latest = answer.latestFailure;
  const last = latest ? ` (latest failure: run ${latest.runId}, ${latest.createdAt})` : '';
  lines.push(`failed ${failed} of ${failed + passed} run(s) with ${level}${last}`);
  const on = answer.failedBranches.join(', ') || 'none';
  lines.push(`  failed on: ${on} · passed on ${answer.passedBranches.length} branch(es)`);
  if (filePassed) {
    lines.push(`  file passed in ${filePassed} more run(s): test presence unverified, not counted`);
  }
  const usable = answer.rows.length;
  const newest = answer.rows[0]?.createdAt;
  const window = usable ? ` · window ${answer.rows.at(-1)?.createdAt} → ${newest}` : '';
  lines.push(
    `  listed ${answer.listed}, usable ${usable}, skipped ${answer.skippedRuns.length}${window}`,
  );
  return lines;
}
