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
var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { inspectIndexFreshness, missingIndexMessage, staleIndexMessage, } from '../../../gate-engine/co-occurrence/index-refresh.mjs';
import { parseModelSpec } from '../../../gate-engine/judge/codex/result.mjs';
import { correctnessModel, resolveEscalationModel, resolveReviewModel, REVIEWERS, } from '../../../gate-engine/review/reviewers.mjs';
import { detectStack } from '../detect-stack.mjs';
import { packageDir, readJson } from '../fs-helpers.mjs';
import { check } from './check-result.mjs';
import { JUDGE_AUTH_CHECK, judgeAuthResult } from './judge/judge-auth.mjs';
import { CLAUDE_RUNTIME_CHECK, claudeBindable, claudeRuntimeResult, explicitFamilyKeys, FAMILY_STALE_CHECK, familyStaleResult, } from './judge/judge-family.mjs';
export const SEARCH_INDEX_CHECK = 'search-code index';
/** Where `devkit init --search-code` puts the index — mirrors INDEX_PATH in install-search-code.mts. */
const DEFAULT_INDEX = '.search-code/index.db';
// Devkit modules are .mts in source and .mjs when installed; runtime string paths need the live ext.
const SELF_EXT = import.meta.url.endsWith('.mts') ? '.mts' : '.mjs';
/**
 * Does guard.config.json literally carry an `indexPath` key? An explicit `"indexPath": null` is a
 * DECLARED matcher opt-out; an absent key is only an absence. resolveGuardConfig collapses both to
 * null, so the raw file is the one place that difference survives — and it is what gives a repo a
 * way to say "no index here, on purpose" instead of carrying a permanent drift warning.
 */
function indexPathKeyPresent(cwd) {
    try {
        const raw = readJson(join(cwd, 'guard.config.json'));
        return raw !== null && 'indexPath' in raw;
    }
    catch {
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
function envWired() {
    return Boolean(process.env.SEARCH_CODE_DB);
}
/**
 * @param resolved `indexPath` after resolveGuardConfig — env > file > null.
 * @param searchCodeSelected Whether `.devkit/config.json` recorded the search-code component. Also
 *   decides `fixable`: init's `--search-code` step is the only sanctioned repair, and selectionFlags
 *   emits that flag only for a repo whose recorded selection already has it.
 */
export function checkSearchIndex(cwd, resolved, searchCodeSelected) {
    if (resolved) {
        const indexPath = resolve(cwd, resolved);
        if (!existsSync(indexPath)) {
            return check(SEARCH_INDEX_CHECK, 'MISSING', missingIndexMessage(indexPath, { cwd, indexPath: resolved }), 'build the configured index, or link the primary checkout index as shown above', false, true);
        }
        let db = null;
        try {
            db = new DatabaseSync(indexPath, { readOnly: true });
            const freshness = inspectIndexFreshness(db, indexPath, { cwd, indexPath: resolved });
            if (freshness.status === 'stale') {
                return check(SEARCH_INDEX_CHECK, 'DRIFT', staleIndexMessage(freshness), 'run `touch <files> && search-code index --seed-files "<files>"` and retry', false, true);
            }
            if (freshness.status === 'unverifiable') {
                return check(SEARCH_INDEX_CHECK, 'OK', `matcher reads ${resolved}; freshness unavailable (${freshness.reason ?? 'unknown index schema'}), so scan-time body verification remains the fallback`);
            }
            return check(SEARCH_INDEX_CHECK, 'OK', `matcher reads ${resolved}; ${freshness.checkedFiles} indexed file(s) match the source checkout`);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return check(SEARCH_INDEX_CHECK, 'DRIFT', `matcher reads ${resolved}, but the index cannot be inspected: ${msg}`, 'rebuild the search-code index and retry', false, true);
        }
        finally {
            db?.close();
        }
    }
    if (envWired())
        return check(SEARCH_INDEX_CHECK, 'OK', 'matcher wired via SEARCH_CODE_DB');
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
export async function checkGuardConfig(cwd, dupSelected, searchCodeSelected, 
// Required, never defaulted: a silent false here retires the codex check for a caller that
// wanted it. Only the `review` guard reads review.model / review.correctnessModel.
reviewSelected) {
    const path = join(cwd, 'guard.config.json');
    if (!existsSync(path)) {
        return [check('guard.config.json', 'MISSING', 'absent', 'run `devkit init`', true)];
    }
    // Two failures live here, owned by different people, so they are caught separately. Loading the
    // engine module can fail for reasons that have nothing to do with the consumer — a SELF_EXT that
    // does not match the install layout, a missing dist build, a throw at engine top level. Reporting
    // those as "fix the config JSON" sends the reader at a file that is perfectly valid, and no edit
    // to it can ever clear the message.
    let mod;
    try {
        mod = (await import(__rewriteRelativeImportExtension(pathToFileURL(join(packageDir(), 'gate-engine', `config${SELF_EXT}`)).href)));
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return [
            check('guard.config.json', 'DRIFT', `cannot load the gate-engine config module: ${msg}`, 'reinstall @norvalbv/devkit — a devkit install fault, not a problem with your config'),
        ];
    }
    // resolveGuardConfig throws on a corrupt file — THAT is the config-validity signal. Resolved
    // ONCE and reused below: a second read could throw unguarded if the file changes under us.
    let cfg;
    try {
        cfg = mod.resolveGuardConfig(cwd);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return [check('guard.config.json', 'DRIFT', msg, 'fix the config JSON')];
    }
    const resolved = cfg.indexPath ?? null;
    const results = [check('guard.config.json', 'OK', 'valid (resolveGuardConfig parsed it)')];
    if (dupSelected)
        results.push(checkSearchIndex(cwd, resolved, searchCodeSelected));
    const topology = reviewTopology(cwd, cfg.review);
    if (topology)
        results.push(topology);
    const codex = reviewSelected ? codexRuntimeResult(cfg, cwd) : null;
    if (codex)
        results.push(codex);
    if (codex && claudeBindable(cwd)) {
        codex.fixable = true;
        codex.remediation +=
            ' — or `devkit doctor --fix` binds the claude family (haiku/opus/sonnet, chunking off) into guard.config.json';
    }
    else if (codex) {
        const explicit = explicitFamilyKeys(cwd);
        if (explicit.length)
            codex.remediation += ` — automatic binding is blocked by your explicit review.${explicit.join(' / review.')}`;
    }
    const claude = reviewSelected ? claudeRuntimeResult(cwd) : null;
    if (claude)
        results.push(claude);
    const stale = reviewSelected ? familyStaleResult(cwd) : null;
    if (stale)
        results.push(stale);
    const auth = reviewSelected ? judgeAuthResult(cfg) : null;
    if (auth)
        results.push(auth);
    return results;
}
export const CODEX_RUNTIME_CHECK = 'codex judge runtime';
/**
 * DRIFT when the RESOLVED judge models (env > guard.config.json > defaults — the same resolvers
 * the gate uses, so no second copy of the precedence) route judges to the codex CLI but no codex
 * binary is resolvable. That combination is an undetected fail-open: every reviewer returns
 * inconclusive and the gate exits 2 while reviewing nothing (sc-2107/sc-2054). Silent when no
 * gpt-* model is configured — most installs — per this file's DRIFT-needs-positive-evidence rule.
 */
export function codexRuntimeResult(cfg, 
// Relative pins / PATH entries resolve against the CONSUMER repo (where the judge spawns),
// never the doctor's own process cwd.
cwd = process.cwd()) {
    const models = [resolveReviewModel(cfg), resolveEscalationModel(cfg), correctnessModel(cfg)];
    const gpt = [...new Set(models.filter((m) => m.startsWith('gpt-')))];
    // A model spec the spawn layer would mishandle is a config defect the doctor should name now —
    // otherwise every affected judge fails at the next commit. The @effort suffix is codex-only:
    // the claude path passes `--model` verbatim, so `sonnet@high` would reach claude untranslated.
    for (const spec of new Set(models)) {
        try {
            if (spec.includes('@') && !spec.startsWith('gpt-'))
                throw new Error(`judge model ${JSON.stringify(spec)} carries a reasoning-effort suffix, but only codex (gpt-*) models support one — the claude CLI would receive it verbatim`);
            parseModelSpec(spec);
        }
        catch (e) {
            return check(CODEX_RUNTIME_CHECK, 'DRIFT', e instanceof Error ? e.message : String(e), 'fix the spec in guard.config.json review.model / review.escalationModel / review.correctnessModel (or the GUARD_* env override)');
        }
    }
    if (gpt.length === 0)
        return null;
    // An existing DIRECTORY or non-executable file at the path still cannot judge anything —
    // resolvable means an executable regular file, the same bar the spawn will apply.
    const executable = (path) => {
        const abs = resolve(cwd, path);
        try {
            accessSync(abs, constants.X_OK);
            return statSync(abs).isFile();
        }
        catch {
            return false;
        }
    };
    const pinned = process.env.GUARD_CODEX_BIN;
    const resolvable = pinned
        ? executable(pinned)
        : // An UNSET PATH is not an empty one: execvp falls back to the system default search path.
            (process.env.PATH ?? '/usr/bin:/bin')
                .split(':')
                // POSIX: an EMPTY path entry means the current directory — spawn would honor it, so the
                // doctor must too, or a valid (if odd) PATH reads as DRIFT.
                .some((d) => executable(join(d === '' ? '.' : d, 'codex')));
    if (resolvable)
        return null;
    return check(CODEX_RUNTIME_CHECK, 'DRIFT', `judge model ${gpt.join(', ')} routes reviewers through the codex CLI, but no codex binary resolves (PATH${pinned ? `, GUARD_CODEX_BIN=${pinned}` : ''}) — every reviewer would go inconclusive and the review gate fails open`, 'install codex-cli (or set GUARD_CODEX_BIN), or override review.model / review.escalationModel / review.correctnessModel in guard.config.json');
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
export async function adviseSearchIndex(cwd, sel) {
    if (!sel.guards?.includes('dup'))
        return;
    const results = await checkGuardConfig(cwd, true, sel.searchCode === true, false);
    const index = results.find((r) => r.name === SEARCH_INDEX_CHECK);
    if (!index)
        return;
    console.log(`  ${index.status === 'OK' ? '✓' : '⚠'} ${index.name}: ${index.detail}`);
    if (index.status !== 'OK' && index.remediation)
        console.log(`      → ${index.remediation}`);
}
/**
 * Codex-runtime advisory for the doctor modes that short-circuit before collectResults (self-host
 * and overlay) — the same reachability hole adviseSearchIndex exists for, and the repo that MOST
 * needs this one is devkit itself: the sole install whose committed config selects gpt judges.
 */
export async function adviseCodexRuntime(cwd, sel) {
    const results = await checkGuardConfig(cwd, false, false, sel.guards?.includes('review') === true);
    const ADVISED = new Set([
        CODEX_RUNTIME_CHECK,
        CLAUDE_RUNTIME_CHECK,
        FAMILY_STALE_CHECK,
        JUDGE_AUTH_CHECK,
    ]);
    for (const row of results.filter((r) => ADVISED.has(r.name))) {
        console.log(`  ⚠ ${row.name}: ${row.detail}`);
        if (row.remediation)
            console.log(`      → ${row.remediation}`);
        if (row.name === CODEX_RUNTIME_CHECK && row.fixable)
            console.log('      → automatic family binding is package-mode only — in this mode, set the four review.* keys by hand');
    }
}
export const REVIEW_TOPOLOGY_CHECK = 'review topology';
/**
 * Which domains a detected stack MUST declare roots for.
 *
 * `generic` is deliberately absent: with no framework signal devkit cannot tell a genuinely
 * backend-only repo from a misconfigured frontend one, and a false positive here would fire on the
 * majority of repos. Silence needs no evidence; an assertion does.
 */
const REQUIRED_DOMAINS = {
    'react-app': ['frontend'],
    next: ['frontend'],
    'component-lib': ['frontend'],
    'node-service': ['backend'],
    electron: ['backend', 'frontend'],
};
/** The gate reviewers a domain triggers — derived from the registry, so a reviewer added later
 * joins this advisory automatically instead of drifting from a hardcoded pair. */
const reviewersFor = (domain) => REVIEWERS.filter((r) => r.domain === domain).map((r) => r.name);
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
export function reviewTopologyResult(stack, review) {
    const required = REQUIRED_DOMAINS[stack];
    if (!required)
        return null;
    // An explicit declaration outranks an inferred stack. `node-service` is detectStack's residual
    // bucket (type:"module" with no frontend dep), so a repo that went out of its way to declare
    // frontendRoots is CONTRADICTING that classification, not drifting from it.
    if (stack === 'node-service' && review.frontendRoots.length > 0)
        return null;
    const roots = {
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
    return check(REVIEW_TOPOLOGY_CHECK, 'DRIFT', `stack "${stack}" detected but ${keys} ${missing.length > 1 ? 'are' : 'is'} empty — ${names} never run`, 'declare the roots in guard.config.json (e.g. "frontendRoots": ["src"])', false, true);
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
// Takes the caller's already-resolved review snapshot — a second resolveGuardConfig read here
// could disagree with the index/codex checks if the file changes between reads.
function reviewTopology(cwd, review) {
    try {
        return reviewTopologyResult(detectStack(cwd), review);
    }
    catch {
        return null;
    }
}
