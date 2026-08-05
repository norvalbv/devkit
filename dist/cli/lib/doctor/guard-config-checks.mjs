/**
 * The `devkit doctor` checks that read guard.config.json: is it valid, and is the dup gate's index
 * actually wired to it. They live together because they share the one dynamic import of the engine
 * config — resolving `indexPath` a second time here would mean a second copy of the env > file >
 * null precedence, which is exactly the duplication the dup gate exists to stop.
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
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packageDir, readJson } from "../fs-helpers.mjs";
import { check } from "./check-result.mjs";
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
    if (resolved)
        return check(SEARCH_INDEX_CHECK, 'OK', `matcher reads ${resolved}`);
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
export async function checkGuardConfig(cwd, dupSelected, searchCodeSelected) {
    const path = join(cwd, 'guard.config.json');
    if (!existsSync(path)) {
        return [check('guard.config.json', 'MISSING', 'absent', 'run `devkit init`', true)];
    }
    // resolveGuardConfig throws on a corrupt file — that's the validity signal.
    let resolved;
    try {
        const mod = (await import(__rewriteRelativeImportExtension(pathToFileURL(join(packageDir(), 'gate-engine', `config${SELF_EXT}`)).href)));
        resolved = mod.resolveGuardConfig(cwd).indexPath ?? null;
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return [check('guard.config.json', 'DRIFT', msg, 'fix the config JSON')];
    }
    const results = [check('guard.config.json', 'OK', 'valid (resolveGuardConfig parsed it)')];
    if (dupSelected)
        results.push(checkSearchIndex(cwd, resolved, searchCodeSelected));
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
export async function adviseSearchIndex(cwd, sel) {
    if (!sel.guards?.includes('dup'))
        return;
    const results = await checkGuardConfig(cwd, true, sel.searchCode === true);
    const index = results.find((r) => r.name === SEARCH_INDEX_CHECK);
    if (!index)
        return;
    console.log(`  ${index.status === 'OK' ? '✓' : '⚠'} ${index.name}: ${index.detail}`);
    if (index.status !== 'OK' && index.remediation)
        console.log(`      → ${index.remediation}`);
}
