/**
 * Which CI workflow and artifact `devkit baseline-status` reads (sc-3445): the CONSUMER's
 * guard.config.json `baselineStatus` (W-3), else devkit's own gate.yml defaults — and one run's
 * summary artifact, from cache or from GitHub.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { z } from 'zod';
import { CONFIG_FILENAME } from '../../../gate-engine/config.mts';
import { parseJsonObject } from '../../../gate-engine/config-json.mts';
import { writeFileAtomic } from '../atomic-write.mts';
import { detectGitRoot } from '../detect-git-root.mts';
import { COMMIT_SHA, GhUnavailable, type RunRef, gh } from './gh.mts';
import type { TestReportSummary } from './produce.mts';
import {
  FILE_OUTCOMES,
  SUMMARY_NAME,
  SUMMARY_SCHEMA,
  fileTestsSchema,
  unhandledRecordSchema,
} from './produce.mts';

/** Per-test names are optional evidence: malformed, they are dropped and the file answers stand. */
const testsSchema = z.record(z.string(), fileTestsSchema);

export const CACHE_DIR = '.devkit/baseline-status';
export const DEFAULT_WORKFLOW = 'gate.yml';
export const DEFAULT_ARTIFACT = 'test-report-summary';

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
  run: Pick<RunRef, 'databaseId' | 'attempt'>;
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

/**
 * The workflow as gh's `--workflow` expects it: GitHub reads workflows only from the top of
 * `.github/workflows/`, so a path is a filename in disguise — and gh 404s on the path form.
 */
export function workflowSelector(workflow: string): string {
  return workflow.trim().split(/[\\/]/).pop() ?? '';
}

export interface BaselineSource {
  workflow: string;
  artifact: string;
  /** The matrix job whose shards `ship --wait-ci` attribution pairs: `<shardJob> (<values>)`. */
  shardJob: string;
}

/** gate.yml's sharded test job. */
const DEFAULT_SHARD_JOB = 'tests';

/**
 * The `baselineStatus` block, typed as EXPECTED at the JSON boundary — the same stance as
 * gate-engine/config.mts: a malformed value is tolerated by `named`, never trusted.
 */
interface RawBaselineStatus {
  baselineStatus?: { workflow?: string; artifact?: string; shardJob?: string } | null;
}

/**
 * The nearest guard.config.json up to the git root — an agent's shell may sit in a package or
 * subfolder, and reading only `cwd` would silently query the default workflow instead.
 */
function configDir(cwd: string): string | null {
  const { gitRoot } = detectGitRoot(cwd);
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, CONFIG_FILENAME))) return dir;
    if (dir === gitRoot || relative(gitRoot, dir).startsWith('..') || dirname(dir) === dir) {
      return null;
    }
  }
}

/**
 * A non-blank string, trimmed; anything else takes the default rather than reaching gh argv.
 * Compared by round-trip rather than a representation check, as config.mts's `str` does.
 */
function named(value: string | undefined, fallback: string): string {
  return value != null && `${value}` === value && value.trim() !== '' ? value.trim() : fallback;
}

/**
 * The configured source for `cwd`. Throws on a corrupt guard.config.json — the same loud failure
 * resolveGuardConfig gives, because a typo'd config must not quietly query the wrong workflow.
 */
export function configuredSource(cwd: string): BaselineSource {
  const dir = configDir(cwd);
  if (dir === null) {
    return { workflow: DEFAULT_WORKFLOW, artifact: DEFAULT_ARTIFACT, shardJob: DEFAULT_SHARD_JOB };
  }
  const path = join(dir, CONFIG_FILENAME);
  const block = parseJsonObject<RawBaselineStatus>(
    readFileSync(path, 'utf8'),
    `${CONFIG_FILENAME} at ${path}`,
  ).baselineStatus;
  // Normalised HERE, like the --workflow flag: a path that names no file is a typo, not a default.
  const workflow = workflowSelector(named(block?.workflow, DEFAULT_WORKFLOW));
  if (!workflow) {
    throw new Error(
      `${CONFIG_FILENAME} at ${path}: baselineStatus.workflow names no workflow file`,
    );
  }
  return {
    workflow,
    artifact: named(block?.artifact, DEFAULT_ARTIFACT),
    shardJob: named(block?.shardJob, DEFAULT_SHARD_JOB),
  };
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
  // PR code writes the artifact, so a sha that is not a commit id is dropped before any output names it.
  const sha = parsed.sha ?? null; // round-trip, not coercion: `["<sha>"]` stringifies to a commit id
  if (sha !== null && (`${sha}` !== sha || !COMMIT_SHA.test(sha))) parsed.sha = null;
  const tests = testsSchema.safeParse(parsed.tests);
  if (tests.success) parsed.tests = tests.data;
  else delete parsed.tests;
  // A count from before error lists were recorded proves nothing about which errors, so it is dropped.
  const unhandled = unhandledRecordSchema.safeParse(parsed.unhandled);
  if (unhandled.success) parsed.unhandled = unhandled.data;
  else delete parsed.unhandled;
  return parsed;
}

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

/** Fetch one run's summary artifact — never the full report, which is multi-MB for a 270-file suite. */
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
        if (e instanceof GhUnavailable) lastError = e; // an unreadable later file must not erase it
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
