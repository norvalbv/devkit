/**
 * The READER side of the baseline oracle — the logic behind `devkit baseline-status`.
 *
 * Answers "was this already broken on the default branch?" from the structured artifact
 * cli/lib/baseline-status/produce.mts emits, so no caller ever has to parse a CI log again.
 *
 * The design constraint that shapes everything here: an agent uses this answer to decide whether a
 * failure is its own. A confidently wrong "it was already red" is worse than no oracle at all, so
 * every path that cannot establish a fact returns a NAMED unknown instead of a plausible default.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { writeFileAtomic } from '../atomic-write.mts';
import { detectGitRoot } from '../detect-git-root.mts';
import {
  GhUnavailable,
  type RunRef,
  type UnknownReason,
  downloadSummary,
  isUsableRun,
  parseSummary,
  assertProvenance,
} from './gh.mts';
import { BranchWalk } from './history.mts';
import { escapesRoot } from './produce.mts';
import type { TestReportSummary } from './produce.mts';

export const CACHE_DIR = '.devkit/baseline-status';
export const DEFAULT_WORKFLOW = 'gate.yml';
export const DEFAULT_ARTIFACT = 'test-report-summary';
/** How many first-parent commits the walk-back looks up, one gh call each. */
export const DEFAULT_MAX_RUNS = 10;
/**
 * Hard ceiling on the commits walked: without it `--max-runs 9007199254740991` turns one question
 * into the branch's whole history of gh calls. It lives here so every caller of queryBaseline has it.
 */
export const MAX_RUNS_CEILING = 50;

/** What is known about ONE file at the baseline commit. */
export type FileStatus = 'passed' | 'failed' | 'skipped' | 'excluded' | 'absent' | 'unknown';

export interface BaselineAnswer {
  /** The run as a whole — lint, typecheck, ratchets and tests. */
  runStatus: 'green' | 'red' | 'unknown';
  /** Just the test step. A red run whose tests passed is a real and common state. */
  testsStatus: 'green' | 'red' | 'unknown';
  ref: string;
  runId: number | null;
  attempt: number | null;
  sha: string | null;
  failingFiles: string[];
  /** The branch head as the remote reported it, which `sha` is measured against. */
  head: string | null;
  /** First-parent commits between `head` and `sha`; above 0, the newer commits had no usable run. */
  commitsBehindHead: number | null;
  /** Walked commits on which the workflow has no run on this branch ([skip ci], path filters). */
  commitsWithoutRun: string[];
  /** Runs skipped before a usable one was found, each with the conclusion that disqualified it. */
  skippedRuns: { runId: number; sha: string; conclusion: string; why: string }[];
  reason?: UnknownReason;
  detail?: string;
  /** What to change so the next query can answer — set only where the fix is on the consumer side. */
  remedy?: string;
  file?: FileAnswer;
}

export interface FileAnswer {
  path: string;
  status: FileStatus;
  reason?: string;
  lastPassed: { sha: string; runId: number; attempt: number } | null;
  /** Why lastPassed is null — 'no-artifact-history' is the honest day-one answer, not "never passed". */
  lastPassedReason: 'found' | 'not-in-scanned-window' | 'no-artifact-history' | 'lookup-failed';
  searchedRuns: number;
  runsWithoutArtifact: number;
}

/** The default branch, preferring what the remote actually says over a guess at its name. */
export function resolveRef(cwd: string, override?: string): string {
  if (override) return override;
  try {
    const head = execFileSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (head.startsWith('origin/')) return head.slice('origin/'.length);
  } catch {
    // no origin/HEAD ref (a fresh clone that never ran `git remote set-head`) — fall through
  }
  return 'main';
}

/** Put a `--file` into the form the summary is keyed by: CWD-resolved, git-root-relative, POSIX. */
export function normaliseFilePath(cwd: string, path: string): string {
  const { gitRoot } = detectGitRoot(cwd);
  // Same POSIX convention as the artifact's keys — a host separator here would miss every one.
  const rel = relative(gitRoot, resolve(cwd, path)).split(sep).join('/');
  return escapesRoot(rel) ? path : rel;
}

/**
 * Did `path` exist at `sha`? null when the answer cannot be established.
 *
 * The commit is probed first: an unfetched commit would otherwise report every path as absent.
 */
export function fileExistsAt(cwd: string, sha: string, path: string): boolean | null {
  const has = (arg: string): boolean => {
    try {
      execFileSync('git', ['cat-file', '-e', arg], { cwd, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  if (!has(`${sha}^{commit}`)) return null;
  return has(`${sha}:${path}`);
}

/** Cache entry name: the artifact is part of the key, so a reconfigured artifact never reads another's. */
export function cacheName(runId: number, attempt: number, artifact: string): string {
  return `${runId}-${attempt}-${encodeURIComponent(artifact)}.json`;
}

/**
 * The summary for one run, from cache or from GitHub. Keyed on runId + ATTEMPT, never sha: a re-run
 * keeps the sha, so a sha key would serve the pre-re-run answer after main was made green.
 */
export function loadSummary({
  cwd,
  run,
  artifact,
}: {
  cwd: string;
  run: RunRef;
  artifact: string;
}): TestReportSummary {
  const cacheFile = join(cwd, CACHE_DIR, cacheName(run.databaseId, run.attempt, artifact));
  if (existsSync(cacheFile)) {
    try {
      // Re-validated, not trusted: `{}` parses, so JSON.parse alone would admit it.
      const label = `cached run ${run.databaseId}`;
      const cached = parseSummary(readFileSync(cacheFile, 'utf8'), label);
      // The FILENAME is not provenance: a correctly named entry can describe another run.
      assertProvenance(cached, { runId: run.databaseId, attempt: run.attempt }, label);
      return cached;
    } catch {
      // unreadable or non-conforming — fall through and refetch
    }
  }
  const summary = downloadSummary({
    cwd,
    runId: run.databaseId,
    attempt: run.attempt,
    artifact,
  });
  try {
    mkdirSync(join(cwd, CACHE_DIR), { recursive: true });
    writeFileAtomic(cacheFile, `${JSON.stringify(summary, null, 2)}\n`);
  } catch {
    // an unwritable cache costs a refetch, nothing more
  }
  return summary;
}

/** One file's verdict at the baseline commit, and why — a named contract, not an inline shape. */
interface FileVerdict {
  status: FileStatus;
  reason?: string;
}

/** Resolve one file against a summary, splitting the three very different kinds of "did not run". */
function statusOf({
  cwd,
  summary,
  run,
  path,
}: {
  cwd: string;
  summary: TestReportSummary;
  run: RunRef;
  path: string;
}): FileVerdict {
  // hasOwn, not truthiness: `files.toString` is a FUNCTION on any JSON-parsed object, so a query
  // for a file named `toString` was answered with an inherited member instead of a real outcome.
  if (Object.hasOwn(summary.files, path)) return { status: summary.files[path] };

  // Not collected by the runner. WHY matters: an agent reads an undifferentiated "did not run" as
  // reassurance, and a path typo would land in exactly that bucket.
  const exists = fileExistsAt(cwd, run.headSha, path);
  if (exists === null) {
    return {
      status: 'unknown',
      reason: `commit ${run.headSha.slice(0, 8)} is not in this checkout — run \`git fetch\` and retry`,
    };
  }
  if (!exists) {
    return { status: 'absent', reason: `no such path at ${run.headSha.slice(0, 8)}` };
  }
  return {
    status: 'excluded',
    reason:
      "existed at that commit but the test runner did not collect it (check the suite's include globs)",
  };
}

/**
 * Walk back for the most recent run in which `path` passed. Fetches only the small summary per run.
 */
function findLastPassed({
  cwd,
  walk,
  artifact,
  path,
}: {
  cwd: string;
  walk: BranchWalk;
  artifact: string;
  path: string;
}): Pick<FileAnswer, 'lastPassed' | 'lastPassedReason' | 'searchedRuns' | 'runsWithoutArtifact'> {
  let searchedRuns = 0;
  let runsWithoutArtifact = 0;
  let lookupFailed = false;
  for (let i = 0; ; i++) {
    let run: RunRef | undefined;
    try {
      run = walk.at(i)?.run;
    } catch {
      lookupFailed = true; // a fact about gh, not about CI history
      break;
    }
    if (!run) break;
    if (!isUsableRun(run)) continue;
    searchedRuns++;
    let summary: TestReportSummary;
    try {
      summary = loadSummary({ cwd, run, artifact });
    } catch {
      // STOP, do not skip. "The latest run in which it passed" is only knowable if every NEWER run
      // could be read; one unavailable run means an older pass is merely the latest we have
      // evidence for, which is a weaker claim than the field's name makes.
      runsWithoutArtifact++;
      break;
    }
    if (Object.hasOwn(summary.files, path) && summary.files[path] === 'passed') {
      return {
        lastPassed: { sha: run.headSha, runId: run.databaseId, attempt: run.attempt },
        lastPassedReason: 'found',
        searchedRuns,
        runsWithoutArtifact,
      };
    }
  }
  return {
    lastPassed: null,
    // A hole in the window is a fact about the DATA; a complete window is a fact about the FILE.
    lastPassedReason: lookupFailed
      ? 'lookup-failed'
      : runsWithoutArtifact > 0
        ? 'no-artifact-history'
        : 'not-in-scanned-window',
    searchedRuns,
    runsWithoutArtifact,
  };
}

function unknownAnswer(ref: string, reason: UnknownReason, detail: string): BaselineAnswer {
  return {
    runStatus: 'unknown',
    testsStatus: 'unknown',
    ref,
    runId: null,
    attempt: null,
    sha: null,
    failingFiles: [],
    head: null,
    commitsBehindHead: null,
    commitsWithoutRun: [],
    skippedRuns: [],
    reason,
    detail,
  };
}

/**
 * The workflow as gh's `--workflow` expects it: GitHub reads workflows only from the top of
 * `.github/workflows/`, so a path is a filename in disguise — and gh 404s on the path form.
 */
export function workflowSelector(workflow: string): string {
  return workflow.trim().split(/[\\/]/).pop() ?? '';
}

/** How to make the producer side exist; shared by every reason that means "CI emits nothing here". */
function producerRemedy(workflow: string, artifact: string, branch: string): string {
  return (
    `The workflow that runs your tests on pushes to ${branch} must run \`devkit test-report-run\` ` +
    `and upload \`${artifact}\` with \`if: always()\` (see \`devkit test-report-run --help\`). ` +
    `If that is not ${workflow}, name it with --workflow <file> or ` +
    `{ "baselineStatus": { "workflow": "<file>" } } in guard.config.json.`
  );
}

/** The whole query. Never throws for a knowable-unknown; the caller renders whatever comes back. */
export function queryBaseline({
  cwd = process.cwd(),
  ref,
  file,
  workflow = DEFAULT_WORKFLOW,
  artifact = DEFAULT_ARTIFACT,
  maxRuns = DEFAULT_MAX_RUNS,
}: {
  cwd?: string;
  ref?: string;
  file?: string;
  workflow?: string;
  artifact?: string;
  maxRuns?: number;
} = {}): BaselineAnswer {
  const branch = resolveRef(cwd, ref);
  workflow = workflowSelector(workflow);
  const skippedRuns: BaselineAnswer['skippedRuns'] = [];
  const maxCommits = Math.min(Math.max(maxRuns, 1), MAX_RUNS_CEILING);
  let walk: BranchWalk | undefined;
  let runsWithoutArtifact = 0;
  for (let i = 0; ; i++) {
    let walked: ReturnType<BranchWalk['at']>;
    try {
      walk ??= new BranchWalk({ cwd, workflow, ref: branch, maxCommits });
      walked = walk.at(i);
    } catch (e) {
      // Answering from an older commit after a failed lookup would present it as the newest evidence.
      const failure =
        e instanceof GhUnavailable
          ? e
          : new GhUnavailable('gh-failed', e instanceof Error ? e.message : String(e));
      return {
        ...lookupFailure(failure, { branch, workflow, artifact }),
        ...walkFields(walk),
        skippedRuns,
      };
    }
    if (!walked) break;
    const { run, behind } = walked;
    if (!isUsableRun(run)) {
      skippedRuns.push({
        runId: run.databaseId,
        sha: run.headSha,
        conclusion: run.conclusion || run.status,
        why: 'did not run to a pass/fail conclusion, so it carries no test report',
      });
      continue;
    }
    let summary: TestReportSummary;
    try {
      summary = loadSummary({ cwd, run, artifact });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      skippedRuns.push({
        runId: run.databaseId,
        sha: run.headSha,
        conclusion: run.conclusion,
        why,
      });
      // "This run has no artifact" is a fact about the run, so walking on to an older one is right.
      // ANY other failure — including a native EACCES/ENOSPC that is not a GhUnavailable at all —
      // means evidence may exist but could not be read, and answering from an older run would
      // present a stale baseline as the current one.
      const isMissing = e instanceof GhUnavailable && e.reason === 'no-artifact';
      if (isMissing) runsWithoutArtifact++;
      if (!isMissing) {
        const reason = e instanceof GhUnavailable ? e.reason : 'artifact-unreadable';
        return { ...unknownAnswer(branch, reason, why), ...walkFields(walk), skippedRuns };
      }
      continue;
    }

    const answer: BaselineAnswer = {
      runStatus: run.conclusion === 'success' ? 'green' : 'red',
      testsStatus: summary.testsPassed ? 'green' : 'red',
      ref: branch,
      runId: run.databaseId,
      attempt: run.attempt,
      sha: run.headSha,
      failingFiles: Object.entries(summary.files)
        .filter(([, outcome]) => outcome === 'failed')
        .map(([path]) => path)
        .sort(),
      ...walkFields(walk),
      commitsBehindHead: behind,
      skippedRuns,
    };
    if (file) {
      // Normalised ONCE so the lookup, the git probe and the walk-back cannot disagree on the key.
      const path = normaliseFilePath(cwd, file);
      // git resolves `<sha>:<path>` from the REPO ROOT, so the existence probe must run there too.
      const { gitRoot } = detectGitRoot(cwd);
      answer.file = {
        path,
        ...statusOf({ cwd: gitRoot, summary, run, path }),
        ...findLastPassed({ cwd, walk, artifact, path }),
      };
      answer.commitsWithoutRun = [...walk.commitsWithoutRun]; // the walk-back may have gone further
    }
    return answer;
  }

  const looked = walk?.commitsLooked ?? 0;
  if (walk?.endedAtShallowBoundary()) {
    const unknown = unknownAnswer(
      branch,
      'history-unavailable',
      `this clone is shallow: only ${looked} commit(s) of ${branch} are local, none with a usable run`,
    );
    unknown.remedy = 'Fetch full history (`git fetch --unshallow`, or `fetch-depth: 0` in CI).';
    return { ...unknown, ...walkFields(walk), skippedRuns };
  }
  const ranAtAll = skippedRuns.length > 0;
  const answer: BaselineAnswer = {
    ...unknownAnswer(
      branch,
      'no-usable-run',
      // Zero runs is its own fact — the workflow exists but never ran on this branch (a PR-only
      // trigger, say) — and "none of the last 0 carried an artifact" would hide that.
      ranAtAll
        ? `no run of ${workflow} on the last ${looked} commit(s) of ${branch} carried a \`${artifact}\` artifact`
        : `${workflow} has no runs on the last ${looked} commit(s) of ${branch}`,
    ),
    ...walkFields(walk),
    skippedRuns,
  };
  // Only where the producer is the gap: a window of cancelled runs is a CI-history fact that no
  // workflow edit fixes, and telling the reader to rewire CI there would be advice about nothing.
  if (!ranAtAll || runsWithoutArtifact > 0) {
    answer.remedy = producerRemedy(workflow, artifact, branch);
  }
  // Rebase merges and path filters leave run-less commits; a full window of them says nothing of CI.
  if (!ranAtAll && looked === maxCommits) {
    answer.remedy = `Walk further back with --max-runs <n> (up to ${MAX_RUNS_CEILING}). ${answer.remedy}`;
  }
  return answer;
}

/** The walk's provenance fields; empty until the remote head has been resolved. */
function walkFields(
  walk: BranchWalk | undefined,
): Pick<BaselineAnswer, 'head' | 'commitsWithoutRun'> {
  return { head: walk?.head ?? null, commitsWithoutRun: [...(walk?.commitsWithoutRun ?? [])] };
}

/** A failure to find runs, named; never throws, so the caller always has an answer to render. */
function lookupFailure(
  e: GhUnavailable,
  { branch, workflow, artifact }: { branch: string; workflow: string; artifact: string },
): BaselineAnswer {
  const unknown = unknownAnswer(branch, e.reason, e.message);
  if (e.reason === 'workflow-missing') {
    unknown.remedy =
      `No workflow \`${workflow}\` exists on the default branch. ` +
      producerRemedy(workflow, artifact, branch);
  }
  if (e.reason === 'history-unavailable') {
    unknown.remedy = `Fetch ${branch} from the repository gh queries (\`gh repo set-default --view\`) and retry.`;
  }
  return unknown;
}
