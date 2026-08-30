/**
 * The `gh` boundary for `devkit baseline-status`.
 *
 * `gh` is a SOFT dependency. It is not added to any consumer's package.json (that is what
 * docs/decisions/zero-consumer-tool-deps.md forbids) and every failure to reach it degrades to a
 * NAMED unknown rather than an exception or, far worse, a guess. This is the shape already proven by
 * `detectMerged` in cli/lib/reconcile.mts, which collapses gh-absent / offline / no-PR to a single
 * UNKNOWN and never crashes a caller.
 *
 * The one rule this module exists to enforce: no answer is better than a wrong answer. An agent that
 * reads "this file passed on main" and ships on it must never have been told that by a fallback.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestReportSummary } from './produce.mts';
import { FILE_OUTCOMES, SUMMARY_NAME, SUMMARY_SCHEMA } from './produce.mts';

/** Every way this can fail to produce data, each distinguishable by a consumer. */
export type UnknownReason =
  | 'gh-missing'
  | 'gh-unauthenticated'
  | 'not-a-github-repo'
  | 'gh-failed'
  | 'no-usable-run'
  | 'no-artifact'
  | 'artifact-unreadable'
  | 'schema-mismatch';

export class GhUnavailable extends Error {
  reason: UnknownReason;

  constructor(reason: UnknownReason, message: string) {
    super(message);
    this.name = 'GhUnavailable';
    this.reason = reason;
  }
}

/** One candidate run, as `gh run list` reports it. */
export interface RunRef {
  databaseId: number;
  attempt: number;
  conclusion: string;
  status: string;
  headSha: string;
  createdAt: string;
}

/**
 * The shape gh emits for `--json databaseId,attempt,conclusion,status,headSha,createdAt`, with every
 * field optional so a malformed entry is REJECTED here rather than dereferenced downstream.
 */
interface RunRefCandidate {
  databaseId?: unknown;
  attempt?: unknown;
  conclusion?: unknown;
  status?: unknown;
  headSha?: unknown;
}

/** Every entry must carry the fields this reader dereferences; `[null]` otherwise reaches them. */
function isRunRef(value: RunRefCandidate | null): value is RunRef {
  return (
    !!value &&
    Number.isFinite(value.databaseId) &&
    Number.isFinite(value.attempt) &&
    STRING_FIELDS.every((f) => (value[f] ?? null) !== null && `${value[f]}` === value[f])
  );
}

/** The three fields read as text; compared by round-trip rather than a representation check. */
const STRING_FIELDS = ['conclusion', 'status', 'headSha'] as const;

/**
 * A run whose tests actually executed. `status: 'completed'` is NOT the predicate — cancelled,
 * timed_out, startup_failure and skipped are all "completed" and carry no report.
 */
export function isUsableRun(run: RunRef): boolean {
  return (
    run.status === 'completed' && (run.conclusion === 'success' || run.conclusion === 'failure')
  );
}

/**
 * What `execFileSync` throws. Every field optional on purpose: this is read to CLASSIFY a failure,
 * so a throw that does not match simply lands in the least specific bucket.
 */
interface ExecFailure {
  code?: string;
  stderr?: string;
  message?: string;
}

/** Turn gh's stderr into the most specific reason it supports. */
function classify(e: ExecFailure): GhUnavailable {
  if (e?.code === 'ENOENT') {
    return new GhUnavailable('gh-missing', 'the `gh` CLI is not on PATH');
  }
  const stderr = String(e?.stderr ?? '');
  const msg = stderr.trim() || e?.message || String(e);
  if (/gh auth login|authentication|not logged/i.test(stderr)) {
    return new GhUnavailable('gh-unauthenticated', `gh is not authenticated: ${msg}`);
  }
  if (
    /no git remotes|not a git repository|could not determine|none of the git remotes/i.test(stderr)
  ) {
    return new GhUnavailable('not-a-github-repo', `no GitHub remote to query: ${msg}`);
  }
  return new GhUnavailable('gh-failed', msg);
}

function gh(args: string[], cwd: string): string {
  const debug = process.env.DEVKIT_BASELINE_DEBUG; // surface gh's stderr instead of collapsing it
  try {
    return execFileSync('gh', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    // SAFETY: execFileSync rejects with an Error carrying optional `code`/`stderr`; ExecFailure
    // declares every field optional, so a non-conforming throw classifies as the generic gh-failed.
    const failure = classify(e as ExecFailure);
    if (debug) console.error(`baseline-status: gh ${args.join(' ')} — ${failure.message}`);
    throw failure;
  }
}

/** Candidate runs on `ref`, newest first. Throws GhUnavailable rather than returning a fallback. */
export function listRuns({
  cwd,
  workflow,
  ref,
  limit,
}: {
  cwd: string;
  workflow: string;
  ref: string;
  limit: number;
}): RunRef[] {
  const out = gh(
    [
      'run',
      'list',
      '--workflow',
      workflow,
      '--branch',
      ref,
      '--limit',
      String(limit),
      '--json',
      'databaseId,attempt,conclusion,status,headSha,createdAt',
    ],
    cwd,
  );
  let runs: unknown;
  try {
    runs = JSON.parse(out);
  } catch {
    throw new GhUnavailable('gh-failed', 'gh run list returned unparseable JSON');
  }
  // SAFETY: `runs` is unvalidated JSON; RunRefCandidate declares every field optional and isRunRef
  // is what admits it, so an entry that disagrees is rejected rather than read.
  if (!Array.isArray(runs) || !(runs as (RunRefCandidate | null)[]).every(isRunRef)) {
    throw new GhUnavailable('gh-failed', 'gh run list returned JSON this reader cannot use');
  }
  return runs;
}

/** Admit a summary only if every value in it is one this repo could have written. */
export function parseSummary(raw: string, label: string): TestReportSummary {
  let parsed: TestReportSummary;
  try {
    // SAFETY: unverified at this point BY DESIGN — the checks below are what admit it.
    parsed = JSON.parse(raw) as TestReportSummary;
  } catch (e) {
    throw new GhUnavailable(
      'artifact-unreadable',
      `${label} could not be read: ${e instanceof Error ? e.message : e}`,
    );
  }
  if (parsed?.schema !== SUMMARY_SCHEMA) {
    throw new GhUnavailable(
      'schema-mismatch',
      `${label} is schema ${String(parsed?.schema)}, expected ${SUMMARY_SCHEMA}`,
    );
  }
  // Compared against the two domain values rather than tested for representation: `'false'` is a
  // string AND truthy, so an unvalidated read reports a red test step as green.
  if (parsed.testsPassed !== true && parsed.testsPassed !== false) {
    throw new GhUnavailable('schema-mismatch', `${label} has a non-boolean testsPassed`);
  }
  // `Object(x) !== x` rejects primitives: `Object.entries(42)` is empty, so `files: 42` would
  // otherwise pass every check below.
  if (!parsed.files || Array.isArray(parsed.files) || Object(parsed.files) !== parsed.files) {
    throw new GhUnavailable('schema-mismatch', `${label} has no files map`);
  }
  const outcomes: readonly string[] = FILE_OUTCOMES;
  // A non-object `files` survives the guard above but yields entries whose values are not outcomes,
  // so this loop rejects it too — one check covering both malformed shapes and malformed values.
  for (const [file, outcome] of Object.entries(parsed.files)) {
    if (!outcomes.includes(outcome)) {
      throw new GhUnavailable('schema-mismatch', `${label} records "${outcome}" for ${file}`);
    }
  }
  return parsed;
}

/**
 * Fetch one run's summary artifact — never the full report, which is multi-MB for a 270-file suite.
 */
/**
 * Refuse a summary that does not positively identify itself as the run it is being served for.
 *
 * Both fields must MATCH — absent is not a pass. An artifact fetched from a CI run was produced by
 * that run and therefore carries its identity; one that carries none was produced somewhere else and
 * has no claim to be evidence here. Requiring a match rather than merely the absence of a
 * contradiction is what makes every producer-side race a MISSING answer instead of a wrong one.
 *
 * Attempt as well as id: a re-run keeps the id and only bumps the attempt, so checking the id alone
 * admits attempt 1's results as attempt 2's — the staleness the runId+attempt cache key exists for.
 */
export function assertProvenance(
  summary: TestReportSummary,
  want: { runId: number; attempt: number },
  label: string,
): void {
  if (summary.runId !== want.runId || summary.attempt !== want.attempt) {
    throw new GhUnavailable(
      'schema-mismatch',
      `${label} records run ${summary.runId}/attempt ${summary.attempt}, not ${want.runId}/${want.attempt}`,
    );
  }
}

/** Every `summary.json` in a downloaded artifact — at its root, or one level down per run dir. */
function summaryFiles(dir: string): string[] {
  const found: string[] = [];
  const visit = (base: string, depth: number): void => {
    let entries: string[];
    try {
      entries = readdirSync(base);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(base, entry);
      if (entry === SUMMARY_NAME) found.push(full);
      else if (depth > 0 && safeIsDir(full)) visit(full, depth - 1);
    }
  };
  visit(dir, 1);
  return found.sort();
}

function safeIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function downloadSummary({
  cwd,
  runId,
  attempt,
  artifact,
}: {
  cwd: string;
  runId: number;
  attempt: number;
  artifact: string;
}): TestReportSummary {
  const dir = mkdtempSync(join(tmpdir(), 'devkit-baseline-'));
  try {
    try {
      gh(['run', 'download', String(runId), '--name', artifact, '--dir', dir], cwd);
    } catch (e) {
      // "no artifact" is a claim ABOUT THE RUN and it shrinks the walk-back window, so only gh's own
      // no-match message may produce it. A transient 5xx or rate limit keeps its generic reason —
      // relabelling it would assert a fact about CI history from a fact about the network.
      if (
        e instanceof GhUnavailable &&
        e.reason === 'gh-failed' &&
        /no (valid )?artifacts? /i.test(e.message)
      ) {
        throw new GhUnavailable('no-artifact', `run ${runId} has no \`${artifact}\` artifact`);
      }
      throw e;
    }
    // The producer writes into a per-run directory rather than a shared path, so an artifact holds
    // one summary per run directory it captured — usually exactly one. Select by the provenance
    // RECORDED INSIDE each candidate, never by filename or position, which is what makes a leftover
    // directory from an earlier run harmless rather than a source of stale evidence.
    const candidates = summaryFiles(dir);
    if (candidates.length === 0) {
      throw new GhUnavailable('artifact-unreadable', `run ${runId}'s artifact holds no summary`);
    }
    let lastError: GhUnavailable | undefined;
    for (const file of candidates) {
      try {
        const summary = parseSummary(readFileSync(file, 'utf8'), `run ${runId}'s summary`);
        assertProvenance(summary, { runId, attempt }, `run ${runId}'s artifact`);
        return summary;
      } catch (e) {
        lastError = e instanceof GhUnavailable ? e : undefined;
      }
    }
    throw (
      lastError ??
      new GhUnavailable('schema-mismatch', `run ${runId}'s artifact holds no matching summary`)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
