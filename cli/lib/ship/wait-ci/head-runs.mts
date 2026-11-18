/**
 * The all-checks wait's guard against a green rollup the repo's own CI never spoke in: gh cannot list
 * a scheduled check (cli/cli#7401), so a queued or never-created Actions run is read off the head.
 */
import { z } from 'zod';
import { classifyChecksFailure, type ExecFailure } from './classify.mts';
import { apiArgs, contextsForBase, expectRequired } from './required.mts';
import type { CheckBucket, CheckRow, ChecksExec, PollResult } from './wait.mts';

const pullSchema = z.object({
  state: z.string(),
  mergeable: z.boolean().nullable(),
  head: z.object({ sha: z.string() }),
  base: z.object({ ref: z.string(), repo: z.object({ default_branch: z.string() }) }),
  /** Set only on a member of a GitHub native stack. */
  stack: z.object({ number: z.number() }).nullish(),
});
const runSchema = z.object({
  id: z.number(),
  workflow_id: z.number(),
  name: z.string().nullable(),
  status: z.string().nullable(),
  conclusion: z.string().nullable(),
  html_url: z.string(),
  event: z.string(),
  /** Empty for a fork PR's run, which GitHub does not associate. */
  pull_requests: z.array(z.object({ number: z.number() })).default([]),
});
/** `gh api --paginate --slurp`: one element per page, so a head past 100 runs is still read whole. */
const runPagesSchema = z.array(z.object({ workflow_runs: z.array(runSchema) }));
export type PullState = z.infer<typeof pullSchema>;
export type WorkflowRun = z.infer<typeof runSchema>;

const GREEN_CONCLUSIONS: ReadonlySet<string> = new Set(['success', 'neutral', 'skipped']);
/** The pending row for a head GitHub has not started any workflow on. */
export const NO_RUN = 'no Actions run on head';

type Unavailable = PollResult & { kind: 'unavailable' };
type Read<T> = { ok: true; value: T } | { ok: false; result: Unavailable };

export interface HeadRunsOptions {
  pr: string;
  repo: string;
  cwd: string;
  exec: ChecksExec;
}

/** A set that would settle `passed` or `no-checks`: the only answers this guard may overturn. */
const settledGreen = (row: CheckRow): boolean => row.bucket === 'pass' || row.bucket === 'skipping';

/** `startup_failure` has no check runs at all, so a run's own conclusion is the only red it leaves. */
function runBucket(run: WorkflowRun): CheckBucket | null {
  const unfinished = run.status !== 'completed' || run.conclusion === null;
  if (unfinished || run.conclusion === 'action_required') return 'pending';
  if (GREEN_CONCLUSIONS.has(run.conclusion ?? '')) return null;
  return run.conclusion === 'cancelled' ? 'cancel' : 'fail';
}

/** A fully skipped run (every job `if:`-skipped) is no verdict on the code, so any other run outranks it. */
const rank = (run: WorkflowRun): [number, number] => [run.conclusion === 'skipped' ? 0 : 1, run.id];

/** The deciding run per workflow and event: a re-run or superseded run on the same SHA no longer decides. */
function latestPerWorkflow(runs: WorkflowRun[]): WorkflowRun[] {
  const latest = new Map<string, WorkflowRun>();
  for (const run of runs) {
    const key = `${run.workflow_id}:${run.event}`;
    const held = latest.get(key);
    const [k, id] = rank(run);
    const [heldK, heldId] = held ? rank(held) : [-1, -1];
    if (k > heldK || (k === heldK && id > heldId)) latest.set(key, run);
  }
  return [...latest.values()];
}

function runRow(run: WorkflowRun): CheckRow[] {
  const bucket = runBucket(run);
  const name = run.name ?? `workflow ${run.workflow_id}`;
  const state = (run.conclusion ?? run.status ?? '').toUpperCase();
  return bucket ? [{ bucket, name, state, link: run.html_url, workflow: name }] : [];
}

const NO_RUN_ROW: CheckRow = {
  bucket: 'pending',
  name: NO_RUN,
  state: 'EXPECTED',
  link: '',
  workflow: '',
};

/** A failed gh read as the wait reads it: classified, and never an empty answer. */
function unavailableFrom(failure: ExecFailure): Unavailable {
  const r = classifyChecksFailure(failure);
  const message = `head-runs read: ${r.kind === 'rows' ? 'gh gave no answer' : r.message}`;
  return { kind: 'unavailable', reason: r.kind === 'rows' ? 'gh-failed' : r.reason, message };
}

/** One `gh api` read. `notFound` is the answer a 404 stands for; any other failure is never a pass. */
function readApi<T>(
  schema: z.ZodType<T>,
  args: string[],
  { cwd, exec }: HeadRunsOptions,
  notFound?: T,
): Read<T> {
  let raw: string;
  try {
    raw = exec(args, cwd);
  } catch (e) {
    // SAFETY: execFileSync rejects with an Error carrying optional code/status/stdout/stderr.
    const failure = e as ExecFailure;
    if (notFound !== undefined && /HTTP 404/.test(String(failure.stderr ?? '')))
      return { ok: true, value: notFound };
    return { ok: false, result: unavailableFrom(failure) };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    json = undefined;
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) return { ok: true, value: parsed.data };
  const message = `gh ${args.join(' ')} returned JSON this reader cannot use: ${raw.slice(0, 200)}`;
  return { ok: false, result: { kind: 'unavailable', reason: 'gh-json-unparseable', message } };
}

/** The base's required contexts, read once per wait: protection does not move while CI runs. */
type RequiredFor = (base: string) => Read<string[]>;

function cachedRequired(options: HeadRunsOptions): RequiredFor {
  const known = new Map<string, string[]>();
  return (base) => {
    const cached = known.get(base);
    if (cached) return { ok: true, value: cached };
    try {
      const contexts = contextsForBase(base, options);
      known.set(base, contexts);
      return { ok: true, value: contexts };
    } catch (e) {
      // SAFETY: execFileSync rejects with an Error carrying optional code/status/stdout/stderr.
      return { ok: false, result: unavailableFrom(e as ExecFailure) };
    }
  };
}

/** A run another PR owns (same head SHA, different PR) must not decide this PR's verdict. */
const ownedBy =
  (pr: string) =>
  (run: WorkflowRun): boolean =>
    run.pull_requests.length === 0 || run.pull_requests.some((p) => String(p.number) === pr);

/**
 * Without a pull_request run nothing may pass yet: GitHub starts none on a conflicting PR, may not
 * have computed mergeability, and runs a native stack member against the stack base. Null: no hold.
 */
function holdWithoutPrRun(
  rows: CheckRow[],
  pull: PullState,
  otherRuns: boolean,
): PollResult | null {
  if (pull.mergeable === false)
    return {
      kind: 'unavailable',
      reason: 'merge-conflict',
      message: `the PR has a merge conflict, so GitHub starts no pull_request run on ${pull.head.sha.slice(0, 12)}`,
    };
  // Actions ran other events on this head, so the PR's own run is due, not absent by design.
  const due = pull.mergeable === null || otherRuns;
  const stacked = Boolean(pull.stack) && pull.base.ref !== pull.base.repo.default_branch;
  return due || stacked ? { kind: 'rows', rows: [...rows, NO_RUN_ROW] } : null;
}

/** A green set plus the head's runs, held for every check the base requires that has not reported. */
function readHeadRuns(
  rows: CheckRow[],
  options: HeadRunsOptions,
  requiredFor: RequiredFor,
): PollResult {
  const pull = readApi(pullSchema, apiArgs(options.repo, `pulls/${options.pr}`), options);
  if (!pull.ok) return pull.result;
  const head = pull.value.head.sha;
  // A closed or merged PR's mergeability may never resolve: its rollup is the whole answer.
  if (pull.value.state !== 'open') return { kind: 'rows', rows, head };
  const path = `actions/runs?head_sha=${head}&per_page=100`;
  const flags = ['--paginate', '--slurp'];
  const pages = readApi(runPagesSchema, apiArgs(options.repo, path, flags), options, []);
  if (!pages.ok) return pages.result;
  const found = pages.value.flatMap((page) => page.workflow_runs).filter(ownedBy(options.pr));
  const withRuns = [...rows, ...latestPerWorkflow(found).flatMap(runRow)];
  const prRun = found.some((run) => run.event === 'pull_request' && run.conclusion !== 'skipped');
  const held = prRun ? null : holdWithoutPrRun(withRuns, pull.value, found.length > 0);
  if (held) return held.kind === 'rows' ? { ...held, head } : held;
  const contexts = requiredFor(pull.value.base.ref);
  if (contexts.ok) return { kind: 'rows', rows: expectRequired(withRuns, contexts.value), head };
  // A known red needs no protection read: only a green verdict depends on it.
  return withRuns.some((row) => row.bucket === 'fail')
    ? { kind: 'rows', rows: withRuns, head }
    : contexts.result;
}

/** Wrap the all-checks poller. Red or pending polls pass straight through, costing no extra gh call. */
export function headRunsPoller(
  poll: (attempt: number) => PollResult | Promise<PollResult>,
  options: HeadRunsOptions,
): (attempt: number) => Promise<PollResult> {
  const requiredFor = cachedRequired(options);
  return async (attempt) => {
    const result = await poll(attempt);
    if (result.kind !== 'rows' || !result.rows.every(settledGreen)) return result;
    return readHeadRuns(result.rows, options, requiredFor);
  };
}
