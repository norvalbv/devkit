/**
 * Under `--wait-ci-required`, holds the wait open for required checks gh has not listed yet: `gh pr
 * checks --required` filters only the REPORTED rollup (cli/cli#8855), so an unstarted one is absent.
 */
import { classifyChecksFailure, type ExecFailure } from './classify.mts';
import type { CheckRow, ChecksExec, PollResult } from './wait.mts';

/** Active rulesets only: GitHub omits rules in `evaluate` or `disabled` rulesets from this endpoint. */
const RULESET_CONTEXTS =
  '.[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context';
const CLASSIC_CONTEXTS = '.protection.required_status_checks.contexts[]?';
/** GitHub's 403 for rulesets on a plan without them: none can apply, so it is an empty set, not trouble. */
const PLAN_REFUSED = /upgrade to github \w+ or make this repository public/i;

export interface RequiredSetOptions {
  pr: string;
  repo: string;
  cwd: string;
  exec: ChecksExec;
}

/** The base branch's required contexts, from two reads that need no admin rights. Throws on gh trouble. */
export function readRequiredContexts({ pr, repo, cwd, exec }: RequiredSetOptions): string[] {
  const view = ['pr', 'view', pr, '--repo', repo, '--json', 'baseRefName', '--jq', '.baseRefName'];
  const base = encodeURIComponent(exec(view, cwd).trim());
  const rules = ['api', '--paginate', `repos/${repo}/rules/branches/${base}`];
  const classic = ['api', `repos/${repo}/branches/${base}`];
  const out = `${rulesetContexts(exec, [...rules, '--jq', RULESET_CONTEXTS], cwd)}\n${exec([...classic, '--jq', CLASSIC_CONTEXTS], cwd)}`;
  return [...new Set(out.split('\n').map((l) => l.trim()))].filter(Boolean);
}

function rulesetContexts(exec: ChecksExec, args: string[], cwd: string): string {
  try {
    return exec(args, cwd);
  } catch (e) {
    // SAFETY: execFileSync rejects with an Error carrying optional code/status/stdout/stderr.
    if (PLAN_REFUSED.test(String((e as ExecFailure).stderr ?? ''))) return '';
    throw e;
  }
}

/** A pending row per required context with no reported row, so `summarise` cannot call the set terminal. */
export function expectRequired(rows: CheckRow[], contexts: string[]): CheckRow[] {
  const reported = new Set(rows.map((r) => r.name));
  const expected = contexts
    .filter((name) => !reported.has(name))
    .map((name): CheckRow => ({
      bucket: 'pending',
      name,
      state: 'EXPECTED',
      link: '',
      workflow: '',
    }));
  return [...rows, ...expected];
}

/** What `wait.mts` drives: the narrowed poll, and the set once read (null until then). */
export interface RequiredSetPoller {
  poll: (attempt: number) => Promise<PollResult>;
  contexts: () => string[] | null;
}

/**
 * Wrap the `--required` poller. The set is cached only after a successful read, and a failed read is
 * classified like any gh failure — never taken as "nothing is required".
 */
export function requiredSetPoller(
  poll: (attempt: number) => PollResult | Promise<PollResult>,
  options: RequiredSetOptions,
): RequiredSetPoller {
  let contexts: string[] | null = null;
  return {
    contexts: () => contexts,
    poll: async (attempt) => {
      if (!contexts) {
        try {
          contexts = readRequiredContexts(options);
        } catch (e) {
          // SAFETY: execFileSync rejects with an Error carrying optional code/status/stdout/stderr.
          const failure = classifyChecksFailure(e as ExecFailure);
          // The classifier's empty-set answer belongs to `gh pr checks`; a failed set read is no answer.
          if (failure.kind === 'rows')
            return {
              kind: 'unavailable',
              reason: 'gh-failed',
              message: 'required-set read: gh gave no answer',
            };
          return { ...failure, message: `required-set read: ${failure.message}` };
        }
      }
      const result = await poll(attempt);
      return result.kind === 'rows'
        ? { kind: 'rows', rows: expectRequired(result.rows, contexts) }
        : result;
    },
  };
}
