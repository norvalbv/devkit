/** Decision-depth pass: a WARN-ONLY judge of a staged Target's rationale depth (PASS / THIN). Split
 *  from check-alignment (sc-2769); blocks only under GUARD_DEPTH_HARD=1. */
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { envFlag, resolveFromCwd, resolveGuardConfig } from '../../config.mts';
import { JUDGE_ISOLATION, JUDGE_READ_ONLY } from '../../judge/judge-isolation.mts';
import { execJudge } from '../../judge/run-judge.mts';
import { resolveReviewModel } from '../../review/reviewers.mts';
import { currentTarget, parseDecision } from '../decisions.mts';
import { git } from '../git-io.mts';
import { hasVerdict, saveVerdict, verdictKey } from '../verdict-cache.mts';

type GuardConfig = ReturnType<typeof resolveGuardConfig>;

const DEPTH_RE = { PASS: /\bPASS\b/, THIN: /\bTHIN\b/ };

// A SOFT lint on an already-recorded Target. Check 4 judges a Revisit-when's QUALITY only; its
// ABSENCE is flagged mechanically (why: decision-records-state-own-expiry, 76.5% vs 100%).
const DEPTH_PROMPT =
  'A decision-log Target block (on stdin) records an architectural decision. Judge its RATIONALE DEPTH:\n' +
  '1. Does Context state a forcing COST/failure that made the status quo untenable — NOT merely restate a prior ruling or the new mechanism (circular)?\n' +
  '2. Is each rejected alternative paired with the concrete CRITERION it loses on, not just named?\n' +
  '3. Is the Negative consequence concrete and specific, NOT a platitude?\n' +
  '4. ONLY IF the block has a Revisit-when line: does it state a concrete, checkable condition (a measurable threshold or observable event), not a platitude like "when things change"? A block with NO Revisit-when line passes this check.\n' +
  'Reply THIN if ANY check fails, else PASS. Reply with exactly one word: PASS or THIN.';

/** Bounded one-word depth verdict; ambiguity / unknown / empty → null (→ no warn). */
export function parseDepthVerdict(raw: string): 'PASS' | 'THIN' | null {
  const out = String(raw).toUpperCase();
  const hits = (['PASS', 'THIN'] as const).filter((v) => DEPTH_RE[v].test(out));
  return hits.length === 1 ? hits[0] : null;
}

/** cwd-relative decisions dir, both ends realpath'd (macOS /tmp↔/private/tmp, absolute env dirs);
 *  '' when the dir sits outside cwd. */
function decisionsDirRel(cwd: string, cfg: GuardConfig): string {
  const abs = resolveFromCwd(cfg, 'decisionsDir');
  if (abs === null) return ''; // no decisions dir configured → treat as outside cwd (no prefix filter)
  const canon = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p; // dir may not exist yet — fall back to the literal path
    }
  };
  const rel = path.relative(canon(cwd), canon(abs));
  return rel.startsWith('..') ? '' : rel;
}

/** Staged decision *.md → [{slug, block}] (the STAGED blob, so partial staging is honoured). */
function stagedDecisionTargets(
  cwd: string,
  changed: string[],
  decisionsRel: string,
): { slug: string; block: string }[] {
  const out: { slug: string; block: string }[] = [];
  for (const f of changed) {
    if (!f.endsWith('.md') || path.basename(f) === 'INDEX.md') continue;
    if (decisionsRel && !f.startsWith(`${decisionsRel}/`)) continue;
    let content: string;
    try {
      content = git(cwd, ['show', `:${f}`]);
    } catch {
      continue; // not in the index (e.g. a pure deletion) → nothing to judge
    }
    const t = currentTarget(parseDecision(content).body);
    if (t?.block) out.push({ slug: path.basename(f, '.md'), block: t.block });
  }
  return out;
}

/** One depth-judge run → raw transcript, or null on outage. Exported so eval/bench runs the gate's
 *  exact argv and can tell outage (null) from parse-null. READ_ONLY precedes ISOLATION (variadic). */
export function runDepthJudge(cwd: string, block: string, model?: string): string | null {
  return execJudge({
    label: 'decision-depth',
    args: [
      '-p',
      '--model',
      model ?? resolveReviewModel(resolveGuardConfig(cwd)),
      ...JUDGE_READ_ONLY,
      ...JUDGE_ISOLATION,
      DEPTH_PROMPT,
    ],
    input: String(block).slice(0, 12000),
    timeout: 120000,
    cwd,
  });
}

function judgeDepth(cwd: string, noLlm: boolean, block: string): 'PASS' | 'THIN' | null {
  if (noLlm || !block.trim()) return null;
  const raw = runDepthJudge(cwd, block);
  return raw === null ? null : parseDepthVerdict(raw);
}

/** Warn on THIN Targets among staged decision files; true only when GUARD_DEPTH_HARD must turn a
 *  confident THIN into a block. The author deepens the still-uncommitted block in place. */
export function depthPass(cwd: string, cfg: GuardConfig, changed: string[]): boolean {
  let block = false;
  // Staged names are cwd-relative and the dir may be absolute, so compare in cwd-relative form.
  const decisionsRel = decisionsDirRel(cwd, cfg);
  for (const d of stagedDecisionTargets(cwd, changed, decisionsRel)) {
    // A block that already judged PASS never re-runs (keyed on its exact content).
    const key = verdictKey('depth', d.block);
    if (hasVerdict(cwd, key)) continue;
    const v = judgeDepth(cwd, cfg.noLlm, d.block);
    if (v === 'PASS') saveVerdict(cwd, key);
    if (v !== 'THIN') continue;
    console.error(
      `decision-depth: target "${d.slug}" reads THIN — Context may restate the prior ruling, ` +
        'a rejected road may lack the criterion it loses on, or the Negative may be a platitude. ' +
        'Deepen the block before committing (it is still uncommitted).',
    );
    if (envFlag('DEPTH_HARD')) block = true;
  }
  return block;
}
