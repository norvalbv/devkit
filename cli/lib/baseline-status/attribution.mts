/**
 * Which of a red PR's failures its base already had: the PR run's per-file summary against the run
 * on its merge commit's first parent. Never guesses; an unreadable input is a named reason.
 */
// Types only: wait.mts imports this module from its top-level await, so a value import deadlocks it.
import type { CheckRow } from '../ship/wait-ci/wait.mts';
import { type CommitCi, GhUnavailable, commitCi, gh, runView } from './gh.mts';
import type { TestReportSummary } from './produce.mts';
import { loadSummary, workflowSelector } from './query.mts';
import { configuredSource } from './source.mts';

export type AttributionToken = 'inherited-only' | 'new' | 'unknown';

/** The base run compared against, once one is found. */
interface BaseFields {
  baseRun: number;
  baseCi: CommitCi['verdict'];
}

/** The line's values, uncapped, for `--json`; a field is absent when the comparison stopped short. */
export interface Attribution extends Partial<BaseFields> {
  token: AttributionToken;
  /** Failing test files, or null when the comparison could not run. */
  inherited: number | null;
  fresh: number | null;
  /** The ` key=value` fields appended to the verdict line. */
  line: string;
  reason?: string;
  newFailing?: string[];
  newSteps?: string[];
  unsure?: string[];
  unattributed?: string[];
}

export interface FileComparison {
  inherited: string[];
  fresh: string[];
  unsure: string[];
}

/** Listed values per field; past this the line says `+N` rather than growing without bound. */
const LIST_CAP = 5;

const own = <T,>(map: Record<string, T> | undefined, key: string): T | undefined =>
  map && Object.hasOwn(map, key) ? map[key] : undefined;

/**
 * Both-failed is inherited only on complete, non-empty name lists: an import error records no names.
 * A failed name the base lists as PASSED is new whatever else is truncated.
 */
export function classifyFile(
  file: string,
  pr: TestReportSummary,
  base: TestReportSummary,
): keyof FileComparison {
  if (own(base.files, file) !== 'failed') return 'fresh';
  const p = own(pr.tests, file);
  const b = own(base.tests, file);
  const complete = (t: typeof p): t is NonNullable<typeof p> =>
    !!t && !t.truncated && t.failed.length > 0;
  if (p?.failed.some((name) => b?.passed.includes(name))) return 'fresh';
  if (!complete(p) || !complete(b)) return 'unsure';
  return p.failed.every((name) => b.failed.includes(name)) ? 'inherited' : 'fresh';
}

/** Every file the PR run failed, bucketed against the base run. */
export function compareSummaries(pr: TestReportSummary, base: TestReportSummary): FileComparison {
  const out: FileComparison = { inherited: [], fresh: [], unsure: [] };
  for (const [file, outcome] of Object.entries(pr.files)) {
    if (outcome === 'failed') out[classifyFile(file, pr, base)].push(file);
  }
  return out;
}

/** `inherited-only` is earned: no new or unsure file, no new failing step, no check left unread. */
export function attributionToken(
  files: FileComparison,
  newSteps: string[],
  unattributed: string[],
): AttributionToken {
  if (files.fresh.length > 0 || newSteps.length > 0) return 'new';
  return files.unsure.length > 0 || unattributed.length > 0 ? 'unknown' : 'inherited-only';
}

/** One verdict-line value: whitespace collapsed (the line is grepped line-wise), capped, or `none`. */
export function capped(values: string[]): string {
  if (values.length === 0) return 'none';
  const shown = values.slice(0, LIST_CAP).map((v) => v.replace(/\s+/g, ' ').trim());
  const rest = values.length - shown.length;
  return rest > 0 ? `${shown.join(',')},+${rest}` : shown.join(',');
}

const baseText = (base?: BaseFields) =>
  base ? ` base-run=${base.baseRun} base-ci=${base.baseCi}` : '';

export const unknownAttribution = (reason: string, base?: BaseFields): Attribution => ({
  token: 'unknown',
  inherited: null,
  fresh: null,
  line: `attribution=unknown reason=${reason}${baseText(base)}`,
  reason,
  ...base,
});

const RUN_ID = /\/actions\/runs\/(\d+)/;

/** The run a failing check links to, or null for a check that is not a GitHub Actions job. */
const runIdOf = (row: CheckRow): number | null => {
  const id = RUN_ID.exec(row.link)?.[1];
  return id ? Number(id) : null;
};

/** The failing checks' run that belongs to the configured workflow, with its attempt. */
function workflowRun(cwd: string, failures: CheckRow[], workflow: string) {
  for (const id of new Set(failures.map(runIdOf))) {
    if (id === null) continue;
    const raw = gh(
      ['api', `repos/{owner}/{repo}/actions/runs/${id}`, '--jq', '[.path, .run_attempt] | @tsv'],
      cwd,
    );
    const [path, attempt] = raw.trim().split('\t');
    if (workflowSelector(path ?? '') === workflow)
      return { databaseId: id, attempt: Number(attempt) };
  }
  return null;
}

/**
 * Attribute a failed PR's checks. Every gh call resolves the repository from `cwd`, so the PR, its
 * runs and the base run can never come from two different remotes.
 */
export function attributeFailures({
  cwd,
  pr,
  failures,
}: {
  cwd: string;
  pr: string;
  failures: CheckRow[];
}): Attribution {
  const { workflow, artifact } = configuredSource(cwd);
  let base: BaseFields | undefined; // kept once known, so a later unreadable artifact still names it
  try {
    const run = workflowRun(cwd, failures, workflow);
    if (!run) return unknownAttribution('no-workflow-run');
    const unattributed = failures.filter((f) => runIdOf(f) !== run.databaseId).map((f) => f.name);
    const prSummary = loadSummary({ cwd, run, artifact });
    if (!prSummary.sha) return unknownAttribution('base-unknown');
    const ref = gh(['pr', 'view', pr, '--json', 'baseRefName', '--jq', '.baseRefName'], cwd).trim();
    const sha = gh(
      ['api', `repos/{owner}/{repo}/commits/${prSummary.sha}`, '--jq', '.parents[0].sha'],
      cwd,
    ).trim();
    if (!ref || !sha) return unknownAttribution('base-unknown');
    const ci = commitCi({ cwd, workflow, ref, sha });
    if (!ci.run || !ci.failing) return unknownAttribution(`base-${ci.verdict}`);
    base = { baseRun: ci.run.databaseId, baseCi: ci.verdict };
    const files = compareSummaries(prSummary, loadSummary({ cwd, run: ci.run, artifact }));
    const baseSteps = ci.failing;
    const newSteps = runView(cwd, run.databaseId).failing.filter((s) => !baseSteps.includes(s));
    const token = attributionToken(files, newSteps, unattributed);
    const unsure = files.unsure.length > 0 ? ` unsure=${files.unsure.length}` : '';
    const other = unattributed.length > 0 ? ` unattributed=${capped(unattributed)}` : '';
    return {
      token,
      inherited: files.inherited.length,
      fresh: files.fresh.length,
      line:
        `attribution=${token} inherited=${files.inherited.length} new=${files.fresh.length}${unsure}` +
        ` new-failing=${capped(files.fresh)} new-steps=${capped(newSteps)}${other}${baseText(base)}`,
      newFailing: files.fresh,
      newSteps,
      unsure: files.unsure,
      unattributed,
      ...base,
    };
  } catch (e) {
    if (e instanceof GhUnavailable) return unknownAttribution(e.reason, base);
    throw e;
  }
}
