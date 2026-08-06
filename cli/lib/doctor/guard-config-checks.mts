/**
 * The `devkit doctor` checks that read guard.config.json: is it valid, is the dup gate's index
 * actually wired to it, and does the review topology it declares match the repo it is installed in.
 * They live together because they share the one dynamic import of the engine config — resolving
 * `indexPath` or `review` a second time here would mean a second copy of the env > file > null
 * precedence, which is exactly the duplication the dup gate exists to stop.
 *
 * The index signal matters because its failure mode is silence. A null `indexPath` makes the
 * co-occurrence matcher opt out and fail open (gate-engine/config.mts DEFAULTS, matcher.mts). That
 * is the RIGHT default — most repos have no search-code index — so the matcher reports the opt-out
 * at the same visual weight as a gate that passed, and a repo can carry a fully-built index while
 * never once running semantic duplication detection because one key went missing.
 *
 * What makes that decidable rather than a guess: `.search-code/index.db` is devkit's OWN canonical
 * path (INDEX_PATH in install/install-search-code.mts, written by that module's setIndexPath at
 * init). An index sitting at the exact path devkit would have configured, with nothing pointing at
 * it, is devkit's wiring having been lost — not a preference.
 *
 * The cost of being wrong is asymmetric. A false negative loses one gate on one repo; a false
 * positive exits 1 on every `devkit doctor` in every repo that legitimately has no search-code,
 * which is most of them. So every branch defaults to silence, and DRIFT needs positive evidence.
 *
 * W-3: every path resolves from the consumer cwd, never the package dir.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REVIEWERS } from '../../../gate-engine/review/reviewers.mts';
import { detectStack, type Stack } from '../detect-stack.mts';
import { packageDir, readJson } from '../fs-helpers.mts';
import { type CheckResult, check } from './check-result.mts';

export const SEARCH_INDEX_CHECK = 'search-code index';

/** Where `devkit init --search-code` puts the index — mirrors INDEX_PATH in install-search-code.mts. */
const DEFAULT_INDEX = '.search-code/index.db';

// Devkit modules are .mts in source and .mjs when installed; runtime string paths need the live ext.
const SELF_EXT = import.meta.url.endsWith('.mts') ? '.mts' : '.mjs';

/** The review topology fields the topology check reads. */
export interface ReviewRoots {
  backendRoots: string[];
  frontendRoots: string[];
}

// The gate-engine config module, imported via a runtime path (typed here, not resolved). Only the
// fields these checks consult are declared; the resolved config is far wider.
interface GateConfigModule {
  resolveGuardConfig(cwd: string): { indexPath?: string | null; review: ReviewRoots };
}

/**
 * Does guard.config.json literally carry an `indexPath` key? An explicit `"indexPath": null` is a
 * DECLARED matcher opt-out; an absent key is only an absence. resolveGuardConfig collapses both to
 * null, so the raw file is the one place that difference survives — and it is what gives a repo a
 * way to say "no index here, on purpose" instead of carrying a permanent drift warning.
 */
function indexPathKeyPresent(cwd: string): boolean {
  try {
    const raw = readJson<Record<string, unknown>>(join(cwd, 'guard.config.json'));
    return raw !== null && 'indexPath' in raw;
  } catch {
    // Unparseable is already reported by the validity check; never read a declared opt-out from it.
    return false;
  }
}

/**
 * Is the matcher wired by an env var this process cannot see in guard.config.json?
 *
 * SEARCH_CODE_DB is read ONLY by matcher.mts and never reaches resolveGuardConfig, so a repo wired
 * that way resolves to a null indexPath here while its matcher runs perfectly. GUARD_INDEX_PATH
 * needs no check — it already folds into the resolved value — but naming both in the remediation
 * matters, because a consumer who exports either only in the hook environment sees this fire in a
 * bare shell. That residual is unavoidable: doctor can only read the env it was handed.
 */
function envWired(): boolean {
  return Boolean(process.env.SEARCH_CODE_DB);
}

/**
 * @param resolved `indexPath` after resolveGuardConfig — env > file > null.
 * @param searchCodeSelected Whether `.devkit/config.json` recorded the search-code component. Also
 *   decides `fixable`: init's `--search-code` step is the only sanctioned repair, and selectionFlags
 *   emits that flag only for a repo whose recorded selection already has it.
 */
export function checkSearchIndex(
  cwd: string,
  resolved: string | null,
  searchCodeSelected: boolean,
): CheckResult {
  if (resolved) return check(SEARCH_INDEX_CHECK, 'OK', `matcher reads ${resolved}`);
  if (envWired()) return check(SEARCH_INDEX_CHECK, 'OK', 'matcher wired via SEARCH_CODE_DB');
  if (indexPathKeyPresent(cwd)) {
    return check(SEARCH_INDEX_CHECK, 'OK', 'matcher opted out by explicit `"indexPath": null`');
  }
  const onDisk = existsSync(join(cwd, DEFAULT_INDEX));
  // The common case, and the one that must stay silent: no index, never opted in, no key. Nothing
  // is broken — this repo simply does not use search-code.
  if (!(onDisk || searchCodeSelected)) {
    return check(SEARCH_INDEX_CHECK, 'OK', 'no search-code index (matcher opted out)');
  }
  const detail = `${onDisk ? `${DEFAULT_INDEX} exists` : 'search-code is selected'} but guard.config.json has no \`indexPath\` — the duplication gate is silently opted out`;
  // Only a repo devkit itself opted in can be healed by re-running init: selectionFlags omits
  // --search-code otherwise, so promising a repair there would be a warning that never clears.
  const remediation = searchCodeSelected
    ? 'run `devkit doctor --fix` (re-runs init --search-code, which also writes search-code.config.json and a .gitignore line)'
    : `run \`devkit init --search-code\`, or set "indexPath": "${DEFAULT_INDEX}" in guard.config.json (or GUARD_INDEX_PATH / SEARCH_CODE_DB). Deliberate? Write "indexPath": null to declare it.`;
  return check(SEARCH_INDEX_CHECK, 'DRIFT', detail, remediation, searchCodeSelected);
}

/**
 * Validity of guard.config.json, followed by the index-wiring check when the `dup` guard is
 * selected — dup is the only gate that reads the index, so a repo running just size+fanout must
 * never be told its dup wiring drifted.
 *
 * The index check is skipped whenever the config is MISSING or unparseable: that is already
 * reported by the first result, and a second line about a key missing from a file that does not
 * parse names the same root cause twice.
 */
export async function checkGuardConfig(
  cwd: string,
  dupSelected: boolean,
  searchCodeSelected: boolean,
): Promise<CheckResult[]> {
  const path = join(cwd, 'guard.config.json');
  if (!existsSync(path)) {
    return [check('guard.config.json', 'MISSING', 'absent', 'run `devkit init`', true)];
  }
  // Two failures live here, owned by different people, so they are caught separately. Loading the
  // engine module can fail for reasons that have nothing to do with the consumer — a SELF_EXT that
  // does not match the install layout, a missing dist build, a throw at engine top level. Reporting
  // those as "fix the config JSON" sends the reader at a file that is perfectly valid, and no edit
  // to it can ever clear the message.
  let mod: GateConfigModule;
  try {
    mod = (await import(
      pathToFileURL(join(packageDir(), 'gate-engine', `config${SELF_EXT}`)).href
    )) as GateConfigModule;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return [
      check(
        'guard.config.json',
        'DRIFT',
        `cannot load the gate-engine config module: ${msg}`,
        'reinstall @norvalbv/devkit — a devkit install fault, not a problem with your config',
      ),
    ];
  }
  // resolveGuardConfig throws on a corrupt file — THAT is the config-validity signal.
  let resolved: string | null;
  try {
    resolved = mod.resolveGuardConfig(cwd).indexPath ?? null;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return [check('guard.config.json', 'DRIFT', msg, 'fix the config JSON')];
  }
  const results = [check('guard.config.json', 'OK', 'valid (resolveGuardConfig parsed it)')];
  if (dupSelected) results.push(checkSearchIndex(cwd, resolved, searchCodeSelected));
  const topology = reviewTopology(cwd, mod);
  if (topology) results.push(topology);
  return results;
}

/**
 * Print the index-wiring signal for the doctor modes that never build a CheckResult[] — overlay and
 * self-host both short-circuit before collectResults. Without this the check would be unreachable in
 * the devkit repo itself, which is self-hosted: the one repo whose own index is most likely to drift
 * out of guard.config.json would be the one repo that could not detect it.
 *
 * Advisory by construction. Those modes gate their exit code on the hook being in sync, and an
 * unwired index is a real finding but not a reason to call an overlay unhealthy — the same tier
 * printQavisAdvisoryHealth occupies.
 */
export async function adviseSearchIndex(
  cwd: string,
  sel: { guards?: string[]; searchCode?: boolean },
): Promise<void> {
  if (!sel.guards?.includes('dup')) return;
  const results = await checkGuardConfig(cwd, true, sel.searchCode === true);
  const index = results.find((r) => r.name === SEARCH_INDEX_CHECK);
  if (!index) return;
  console.log(`  ${index.status === 'OK' ? '✓' : '⚠'} ${index.name}: ${index.detail}`);
  if (index.status !== 'OK' && index.remediation) console.log(`      → ${index.remediation}`);
}

export const REVIEW_TOPOLOGY_CHECK = 'review topology';

type Domain = 'backend' | 'frontend';

/**
 * Which domains a detected stack MUST declare roots for.
 *
 * `generic` is deliberately absent: with no framework signal devkit cannot tell a genuinely
 * backend-only repo from a misconfigured frontend one, and a false positive here would fire on the
 * majority of repos. Silence needs no evidence; an assertion does.
 */
const REQUIRED_DOMAINS: Partial<Record<Stack, Domain[]>> = {
  'react-app': ['frontend'],
  next: ['frontend'],
  'component-lib': ['frontend'],
  'node-service': ['backend'],
  electron: ['backend', 'frontend'],
};

/** The gate reviewers a domain triggers — derived from the registry, so a reviewer added later
 * joins this advisory automatically instead of drifting from a hardcoded pair. */
const reviewersFor = (domain: Domain): string[] =>
  REVIEWERS.filter((r) => r.domain === domain).map((r) => r.name);

/**
 * Pure rule table: does this stack's declared topology leave a domain's reviewers switched off?
 *
 * ADVISORY, not drift — see CheckResult.advisory. It is a true finding (an empty `frontendRoots`
 * really does make selectReviewers drop both frontend reviewers, silently), but devkit itself still
 * SHIPS the inverted default: there is no `templates/next`, and installConfigs hardcodes
 * templates/generic. Blocking on it would exit 1 on a repo devkit's own init just produced, with a
 * `--fix` that cannot repair it. Promote it once init picks the stack template.
 *
 * Returns null when nothing can be asserted — never a reassuring OK for a repo that was not checked.
 */
export function reviewTopologyResult(stack: Stack, review: ReviewRoots): CheckResult | null {
  const required = REQUIRED_DOMAINS[stack];
  if (!required) return null;
  // An explicit declaration outranks an inferred stack. `node-service` is detectStack's residual
  // bucket (type:"module" with no frontend dep), so a repo that went out of its way to declare
  // frontendRoots is CONTRADICTING that classification, not drifting from it.
  if (stack === 'node-service' && review.frontendRoots.length > 0) return null;
  const roots: Record<Domain, string[]> = {
    backend: review.backendRoots,
    frontend: review.frontendRoots,
  };
  const missing = required.filter((d) => roots[d].length === 0);
  const declared = required.map((d) => `${d}Roots`).join(' + ');
  if (missing.length === 0) {
    return check(REVIEW_TOPOLOGY_CHECK, 'OK', `stack "${stack}" — ${declared} declared`);
  }
  const keys = missing.map((d) => `review.${d}Roots`).join(' + ');
  const names = missing.flatMap(reviewersFor).join(' + ');
  return check(
    REVIEW_TOPOLOGY_CHECK,
    'DRIFT',
    `stack "${stack}" detected but ${keys} ${missing.length > 1 ? 'are' : 'is'} empty — ${names} never run`,
    'declare the roots in guard.config.json (e.g. "frontendRoots": ["src"])',
    false,
    true, // advisory: reported, but never flips the exit code
  );
}

/**
 * Does the repo's CURRENT dependency set contradict its DECLARED review topology?
 *
 * The gate's own stderr warning (gate-engine/review/evidence/scope.mts) is the other half of this
 * signal. The gate judges the DIFF; doctor judges the REPO — which is what lets doctor carry the
 * BACKEND case at all, since `.ts` gives no diff-decidable falsifier but `react` in a manifest does.
 *
 * Deliberately reads detectStack rather than the `stack` recorded in .devkit/config.json, which is
 * what every other doctor check consults. They answer different questions: `cfg.stack` is "what did
 * init wire" (and can be forced by `--stack`), this is "what is this repo NOW" — so it also catches
 * a service that grew a frontend after init.
 *
 * NOT REACHED in overlay or self-host mode: doctor short-circuits before collectResults. Benign for
 * devkit itself (a node-service with backendRoots declared passes anyway), but an overlay consumer
 * with a genuinely inverted topology gets no signal — recorded so that stays a decision.
 */
function reviewTopology(cwd: string, mod: GateConfigModule): CheckResult | null {
  try {
    return reviewTopologyResult(detectStack(cwd), mod.resolveGuardConfig(cwd).review);
  } catch {
    return null;
  }
}
