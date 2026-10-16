// @ts-nocheck — BENCH-ONLY; refuses a run whose judges cannot answer, before any task is spent.
import { execFileSync } from 'node:child_process';
import { reachabilityOf } from '../../../../../cli/lib/ship/preflight/judge.mts';
import { BenchAbort } from '../../../../decisions/eval/bench.mts';
import { formatResetDelta } from '../../../../judge/outage/classify.mts';

/** The bench knob that moves each role off its pin. */
const ROLE_KNOB = {
  correctness: 'BENCH_CORRECTNESS_MODEL',
  review: 'BENCH_MODEL',
  escalation:
    'BENCH_ESCALATE_MODEL (or BENCH_CASCADE=off, which measures the single-pass arm instead)',
};

const DARK = new Set(['absent', 'unauthenticated', 'unavailable', 'rate-limited']);

/** The judges a run will spawn: only reviewers with selected rows, each on its effective model. */
export function benchJudgeRoles(plan, { effModel, effCascade, escalationModel }) {
  const selected = plan.filter((p) => p.rows.length > 0).map((p) => p.reviewer);
  const roles = selected.map((reviewer) => ({
    role: reviewer.name === 'correctness-reviewer' ? 'correctness' : 'review',
    model: effModel(reviewer),
  }));
  if (selected.some(effCascade)) roles.push({ role: 'escalation', model: escalationModel });
  return [...new Map(roles.map((r) => [`${r.role}@${r.model}`, r])).values()];
}

function claudeVersionRuns() {
  try {
    execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function darkReason(s, now) {
  if (s.state === 'absent') return `\`${s.bin}\` is not installed or does not run`;
  if (s.state === 'unauthenticated') return `\`${s.bin}\` is not authenticated`;
  if (s.state === 'unavailable')
    return `not served on this ${s.planType} plan (serves: ${s.served?.join(', ') || 'none listed'})`;
  const reset = s.resetsAt === undefined ? '' : `, resets in ${formatResetDelta(s.resetsAt, now)}`;
  return `usage limit reached${reset}`;
}

/** A missing or logged-out CLI is fixed on this machine; a plan refusal or lock is not. */
function darkRemedy(s) {
  if (s.state === 'absent' || s.state === 'unauthenticated')
    return `Install or log in to \`${s.bin}\` and re-run, or move the role with`;
  return 'Re-running will not help; move the role with';
}

/** Throws BenchAbort(2) naming every dark role; an unverified role proceeds (positive signal only). */
export async function preflightBenchJudges(
  roles,
  root,
  { judge, claudeVersion = claudeVersionRuns, now = Date.now() } = {},
) {
  const statuses = await reachabilityOf(roles, root, judge);
  // A claude on PATH can still fail to start; the old bench preflight caught that, so keep it.
  if (statuses.some((s) => s.bin === 'claude' && s.state === 'ok') && !claudeVersion())
    for (const s of statuses) if (s.bin === 'claude') s.state = 'absent';
  const dark = statuses.filter((s) => DARK.has(s.state));
  if (dark.length === 0) return statuses;
  const lines = dark.map(
    (s) =>
      `  ${s.role}: ${s.model} via ${s.bin} — ${darkReason(s, now)}. ${darkRemedy(s)} ${ROLE_KNOB[s.role]}.`,
  );
  throw new BenchAbort(
    2,
    [
      'reviewer-eval: a judge this run needs cannot answer — no task was spent:',
      ...lines,
      'An off-pin model is keyed as its own section, so it never compares against the pinned baseline.',
    ].join('\n'),
  );
}
