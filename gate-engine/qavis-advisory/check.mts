/**
 * qavis-advisory gate — nudge to run qavis QA when a staged change is UI-affecting and hasn't been
 * QA'd yet. The "deserves QA" judgement + the pass-receipt both live in qavis (its `route` CLASSIFIER
 * and `receipt`); devkit is a THIN CHANNEL that shells `qavis route --staged --gate` and turns its
 * ADVISE/SILENT into an exit code. So a non-qavis consumer carries zero weight (fail-open, the fallow
 * precedent), and the classifier is never duplicated here.
 *
 * Contract (mirrors the other gates' trichotomy, but this one NEVER hard-fails a normal commit —
 * it's advisory):
 *   0 = continue — SILENT, advisory-only (normal commit), overridden, receipt-cleared, or the
 *       advisory couldn't run at all (qavis absent/erroring — reported, see below).
 *   3 = ADVISE under a strict ship (GUARD_AI_STRICT): the ship blocks until qavis runs (writing a
 *       receipt that clears it) or an override is set. A normal `git commit` only prints the nudge.
 * There is deliberately NO exit 1 and NO fail-CLOSED on outage: an advisor's own failure (qavis
 * missing / erroring) must never block a ship — unlike completeness, which blocks a dark gap-finder.
 *
 * Fail-open, but LOUD. A skipped advisory prints one stderr line naming WHY (qavis not on PATH /
 * route failed / no verdict). Silence there made three states indistinguishable — "nothing to QA",
 * "qavis missing", "route blew up" — so the gate could sit dead for months and look healthy. It
 * still exits 0 in every one of those cases; it just says so. A repo WITHOUT `.qavis/recipe.json`
 * stays entirely silent: devkit never asserted qavis was expected there.
 *
 * Overrides: GUARD_NO_QAVIS_ADVISORY=1 disables · GUARD_QAVIS_OK=1 ships this change without QA.
 * (Both must be EXPORTED to survive the ship subprocess chain — an inline prefix can be stripped.)
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { envFlag } from '../config.mts';

/**
 * Is the qavis CLI resolvable on PATH? `devkit doctor` asks this to report a dead advisory gate
 * OUTSIDE commit time — a plain filesystem scan, never a `route` call, so it costs no model spend.
 * `env` is a parameter purely so tests can drive a synthetic PATH.
 */
export function qavisOnPath(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.PATH ?? '')
    .split(path.delimiter)
    .some((dir) => dir && existsSync(path.join(dir, 'qavis')));
}

/** A qavis repo advertises how to launch its app here; absent ⇒ nothing for qavis to QA. */
export const QAVIS_RECIPE = path.join('.qavis', 'recipe.json');

/**
 * The outcome of asking qavis to route the staged tree. The null arm carries `skip` — the human
 * phrase for why the advisory didn't run — so the ONE printer (runQavisAdvisory) can report it
 * instead of discarding it. A bare null is what made a dead gate look like a quiet one.
 */
export type RouteResult = { verdict: 'ADVISE' | 'SILENT' } | { verdict: null; skip: string };

export interface AdvisoryDeps {
  /** `qavis route --staged --gate` → its verdict, or why the advisory couldn't run. */
  route?: (cwd: string) => RouteResult;
  hasRecipe?: (cwd: string) => boolean;
}

function defaultRoute(cwd: string): RouteResult {
  let out: string;
  try {
    out = execFileSync('qavis', ['route', '--staged', '--gate', '--repo', cwd], {
      encoding: 'utf8',
      // stdout = the bare verdict (captured); stderr = qavis's reason/remedy, passed to the user.
      stdio: ['ignore', 'pipe', 'inherit'],
    });
  } catch (e) {
    // ENOENT = no such binary. A qavis that RAN and exited non-zero throws with `status` set
    // instead, so this cleanly separates "never installed" from "installed but broken".
    const err = e as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') return { verdict: null, skip: 'qavis not on PATH' };
    return { verdict: null, skip: `qavis route failed: ${err?.message ?? err}` };
  }
  const last = out.trim().split('\n').pop() ?? '';
  if (last === 'ADVISE' || last === 'SILENT') return { verdict: last };
  // Exited 0 but said nothing we understand — a version skew or a swallowed error, not a SILENT.
  return { verdict: null, skip: `qavis route printed no verdict (${JSON.stringify(last)})` };
}

export function runQavisAdvisory(cwd: string = process.cwd(), deps: AdvisoryDeps = {}): number {
  if (envFlag('NO_QAVIS_ADVISORY') || envFlag('QAVIS_OK')) return 0;
  const hasRecipe = deps.hasRecipe ?? ((c) => existsSync(path.join(c, QAVIS_RECIPE)));
  // Not a qavis repo (or qavis not installed by this committer) → nothing to advise. This is also the
  // zero-weight path for every non-qavis consumer: the gate returns before shelling anything.
  if (!hasRecipe(cwd)) return 0;
  const result = (deps.route ?? defaultRoute)(cwd);
  if (result.verdict === null) {
    // Fail-open, but never silently: this repo ships a recipe, so it EXPECTS qavis. Printed on a
    // plain commit and under a strict ship alike — the advisory's own failure never costs an exit
    // code, so the line is the only signal there is. The mute is the remedy for every skip reason.
    console.error(`qavis-advisory: skipped — ${result.skip}.`);
    console.error(
      `   (${QAVIS_RECIPE} is present, so this repo expects it; mute with GUARD_NO_QAVIS_ADVISORY=1.)`,
    );
    return 0;
  }
  if (result.verdict !== 'ADVISE') return 0; // SILENT → continue
  // qavis printed its own reason to stderr; add the remedy + the exit-code decision.
  console.error('qavis-advisory: UI-affecting change with no qavis QA on this staged tree.');
  console.error(
    '   Run:  qavis qa --staged --repo .    (a pass writes a receipt that clears this)',
  );
  console.error('   Skip: export GUARD_QAVIS_OK=1, or disable with GUARD_NO_QAVIS_ADVISORY=1.');
  return envFlag('AI_STRICT') ? 3 : 0; // ship blocks; a normal commit is advisory-only
}
