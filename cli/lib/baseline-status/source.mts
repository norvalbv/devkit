/**
 * Which CI workflow and artifact `devkit baseline-status` reads (sc-3445): the CONSUMER's
 * guard.config.json `baselineStatus` (W-3), else devkit's own gate.yml defaults — and one run's
 * summary artifact, from cache or from GitHub.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { CONFIG_FILENAME } from '../../../gate-engine/config.mts';
import { parseJsonObject } from '../../../gate-engine/config-json.mts';
import { writeFileAtomic } from '../atomic-write.mts';
import { detectGitRoot } from '../detect-git-root.mts';
import { type RunRef, assertProvenance, downloadSummary, parseSummary } from './gh.mts';
import type { TestReportSummary } from './produce.mts';

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
}

/**
 * The `baselineStatus` block, typed as EXPECTED at the JSON boundary — the same stance as
 * gate-engine/config.mts: a malformed value is tolerated by `named`, never trusted.
 */
interface RawBaselineStatus {
  baselineStatus?: { workflow?: string; artifact?: string } | null;
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
  if (dir === null) return { workflow: DEFAULT_WORKFLOW, artifact: DEFAULT_ARTIFACT };
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
  return { workflow, artifact: named(block?.artifact, DEFAULT_ARTIFACT) };
}
