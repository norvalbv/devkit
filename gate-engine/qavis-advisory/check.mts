/**
 * qavis-advisory gate — nudge to run qavis QA when a staged change is UI-affecting and hasn't been
 * QA'd yet. The "deserves QA" judgement + the pass-receipt both live in qavis (its `route` CLASSIFIER
 * and `receipt`); devkit is a THIN CHANNEL that shells `qavis route --staged --gate` and turns its
 * ADVISE/SILENT into an exit code. So a non-qavis consumer carries zero weight (fail-open, the fallow
 * precedent), and the classifier is never duplicated here.
 *
 * Contract (mirrors the other gates' trichotomy, but this one NEVER hard-fails a normal commit —
 * it's advisory):
 *   0 = continue — SILENT, advisory-only (normal commit), overridden, receipt-cleared, or qavis absent.
 *   3 = ADVISE under a strict ship (GUARD_AI_STRICT): the ship blocks until qavis runs (writing a
 *       receipt that clears it) or an override is set. A normal `git commit` only prints the nudge.
 * There is deliberately NO exit 1 and NO fail-CLOSED on outage: an advisor's own failure (qavis
 * missing / erroring) must never block a ship — unlike completeness, which blocks a dark gap-finder.
 *
 * Overrides: GUARD_NO_QAVIS_ADVISORY=1 disables · GUARD_QAVIS_OK=1 ships this change without QA.
 * (Both must be EXPORTED to survive the ship subprocess chain — an inline prefix can be stripped.)
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { envFlag } from '../config.mts';

/** A qavis repo advertises how to launch its app here; absent ⇒ nothing for qavis to QA. */
export const QAVIS_RECIPE = path.join('.qavis', 'recipe.json');

export interface AdvisoryDeps {
  /** ADVISE|SILENT from `qavis route --staged --gate`; null when qavis is absent or errored. */
  routeVerdict?: (cwd: string) => 'ADVISE' | 'SILENT' | null;
  hasRecipe?: (cwd: string) => boolean;
}

function defaultRouteVerdict(cwd: string): 'ADVISE' | 'SILENT' | null {
  try {
    const out = execFileSync('qavis', ['route', '--staged', '--gate', '--repo', cwd], {
      encoding: 'utf8',
      // stdout = the bare verdict (captured); stderr = qavis's reason/remedy, passed to the user.
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const last = out.trim().split('\n').pop() ?? '';
    return last === 'ADVISE' ? 'ADVISE' : last === 'SILENT' ? 'SILENT' : null;
  } catch {
    return null; // qavis not on PATH, or route errored → fail-open (never block on our advisor's failure)
  }
}

export function runQavisAdvisory(cwd: string = process.cwd(), deps: AdvisoryDeps = {}): number {
  if (envFlag('NO_QAVIS_ADVISORY') || envFlag('QAVIS_OK')) return 0;
  const hasRecipe = deps.hasRecipe ?? ((c) => existsSync(path.join(c, QAVIS_RECIPE)));
  // Not a qavis repo (or qavis not installed by this committer) → nothing to advise. This is also the
  // zero-weight path for every non-qavis consumer: the gate returns before shelling anything.
  if (!hasRecipe(cwd)) return 0;
  const verdict = (deps.routeVerdict ?? defaultRouteVerdict)(cwd);
  if (verdict !== 'ADVISE') return 0; // SILENT, or qavis absent/errored → continue
  // qavis printed its own reason to stderr; add the remedy + the exit-code decision.
  console.error('qavis-advisory: UI-affecting change with no qavis QA on this staged tree.');
  console.error(
    '   Run:  qavis qa --staged --repo .    (a pass writes a receipt that clears this)',
  );
  console.error('   Skip: export GUARD_QAVIS_OK=1, or disable with GUARD_NO_QAVIS_ADVISORY=1.');
  return envFlag('AI_STRICT') ? 3 : 0; // ship blocks; a normal commit is advisory-only
}
