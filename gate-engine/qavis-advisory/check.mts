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
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { envFlag } from '../config.mts';
import { emitGateBypass } from '../judge/gate-events.mts';

/**
 * Is the qavis CLI resolvable on PATH? `devkit doctor` asks this to report a dead advisory gate
 * OUTSIDE commit time — a plain filesystem scan, never a `route` call, so it costs no model spend.
 * `env` is a parameter purely so tests can drive a synthetic PATH.
 */
export function qavisOnPath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): boolean {
  return (env.PATH ?? '').split(path.delimiter).some((dir) => {
    if (!dir) return false;
    // Relative PATH entries resolve against the cwd the SPAWN would use — the hook shells the
    // gate from the git root, so doctor must judge from there, not from its own process cwd.
    const candidate = path.resolve(cwd, dir, 'qavis');
    try {
      // Same bar the spawn applies: an executable regular file — a directory or a chmod-x-less
      // file named `qavis` would report healthy and then fail every launch.
      accessSync(candidate, constants.X_OK);
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * Does the installed qavis register a `publish` subcommand? `devkit doctor` asks this so the OTHER
 * inert qavis path — ship's post-push evidence hand-off (cli/lib/ship/publish-qavis.sh) — is visible
 * outside a post-push stderr line that a headless shipping agent may never read. sc-2161 owns the
 * qavis half; until it lands, a qavis we can read answers `false`.
 *
 * Matches the WHOLE command word in the `--help` Commands block: "publish" also appears in qavis's
 * prose, and `qavis publish --help` exits 0 on a qavis WITHOUT publish (commander answers `--help`
 * before rejecting the unknown operand), so neither a substring nor an exit status can be trusted.
 * A trailing `|` counts as a word end because commander renders an aliased subcommand as
 * `publish|pub`. Must stay in lockstep with publish-qavis.sh's probe — ship and doctor answering
 * this question differently is how an operator gets told two things about one binary.
 * `--help` only — never a `route`/`qa` call, so this costs no model spend.
 *
 * `null` is a THIRD state, not a synonym for false: the probe could not ask (spawn failed, `--help`
 * timed out, output had no readable Commands block), which is not evidence that publish is absent.
 * Collapsing it would have doctor assert "this qavis has no publication subcommand" about a binary
 * it never managed to interrogate — the same defect the 2026-07-22 ruling on this axis fixed for the
 * advisory gate, where a bare null read exactly like a healthy verdict. Ship treats null and false
 * alike (decline to invoke) because for ship they mean the same thing; doctor must not.
 */
/** Exported so a hang-regression test can bound its own wait without hard-coding this number. */
export const QAVIS_HELP_TIMEOUT_MS = 5_000;

export function qavisSupportsPublish(cwd = process.cwd()): boolean | null {
  let help: string;
  try {
    help = execFileSync('qavis', ['--help'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      // Same cwd `qavisOnPath` judges from: a RELATIVE PATH entry resolves against the spawn's
      // directory, so probing from doctor's own cwd could answer for a different binary than the one
      // reported present — or none at all.
      cwd,
      // Explicit `env` so the lookup uses the LIVE PATH. Bun's execFileSync resolves the executable
      // against the PATH it started with and ignores a later `process.env.PATH` write, so without
      // this the probe can answer for a different binary than the shell probe found — measured, and
      // the exact divergence this pair exists to prevent. Node honours the mutation either way.
      env: process.env,
      // execFileSync waits forever by default, so a qavis whose --help never returns would hang
      // `devkit doctor` outright rather than degrade. A health report may not become the outage it
      // is meant to describe; on timeout the throw lands in the catch and answers "could not ask"
      // rather than "absent". `--help` measures in tenths of a second.
      timeout: QAVIS_HELP_TIMEOUT_MS,
    });
  } catch {
    return null; // never ran, or was killed at the timeout — no evidence either way
  }
  const lines = help.split('\n');
  const commands = lines.findIndex((line) => line.startsWith('Commands:'));
  // No Commands block ⇒ not a help output we can read ⇒ unknown, never "scan the whole text".
  if (commands === -1) return null;
  // Stop at the next unindented line: that is a new section header (`Examples:`, anything an
  // `addHelpText('after', …)` appends), and its indented body is prose, not registered commands.
  // Scanning to end-of-help would read `Examples:\n  publish --pr 1` as a capability and put ship
  // straight back to invoking a subcommand that does not exist.
  const block: string[] = [];
  for (const line of lines.slice(commands + 1)) {
    if (/^\S/.test(line)) break;
    block.push(line);
  }
  return block.some((line) => {
    // Take the whole rendered term and split it, rather than anchoring `publish` to the start:
    // commander renders `name|alias`, so `publish` can sit on EITHER side of the pipe and the CLI
    // dispatches on both. The `[a-z]` start mirrors the shell probe's awk exactly.
    const term = /^ {2}([a-z]\S*)/.exec(line);
    return term !== null && term[1].split('|').includes('publish');
  });
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
  const hasRecipe = deps.hasRecipe ?? ((c) => existsSync(path.join(c, QAVIS_RECIPE)));
  // Not a qavis repo (or qavis not installed by this committer) → nothing to advise. This is also the
  // zero-weight path for every non-qavis consumer: the gate returns before shelling anything —
  // checked BEFORE the flags, or a globally exported GUARD_QAVIS_OK would record a phantom bypass
  // of a gate that had nothing to run here.
  if (!hasRecipe(cwd)) return 0;
  // GUARD_QAVIS_OK is a per-run bypass, NO_QAVIS_ADVISORY a standing disable — recorded under
  // their own flag names because before this the advisory's bypasses emitted nothing at all.
  if (envFlag('QAVIS_OK')) {
    emitGateBypass('qavis-advisory', 'GUARD_QAVIS_OK');
    return 0;
  }
  if (envFlag('NO_QAVIS_ADVISORY')) {
    emitGateBypass('qavis-advisory', 'GUARD_NO_QAVIS_ADVISORY');
    return 0;
  }
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
    '   Run:  qavis qa --staged --route vision --repo .    (a pass writes a receipt that clears this)',
  );
  console.error('   Skip: export GUARD_QAVIS_OK=1, or disable with GUARD_NO_QAVIS_ADVISORY=1.');
  return envFlag('AI_STRICT') ? 3 : 0; // ship blocks; a normal commit is advisory-only
}
