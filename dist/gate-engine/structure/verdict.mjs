// guard-structure's verdict trichotomy (0 clean, 1 violations, 2 could-not-run) and how per-leg
// verdicts fold into one gate result.
import { resolveGuardConfig } from '../config.mjs';
// The trichotomy as named verdicts, so a call site states what it concluded instead of a bare
// number — `clean()` asserts a tree was read, `couldNotRun()` asserts one was not.
export const clean = () => ({ code: 0, errorCount: 0 });
export const violations = (errorCount, text) => ({
    code: 1,
    errorCount,
    text,
});
export const couldNotRun = (reason) => ({
    code: 2,
    errorCount: 0,
    text: `guard-structure: gate did NOT run — ${reason}`,
});
/** Fold per-leg verdicts: any violation blocks, else any could-not-run fails open, else clean. A
 * blocking result still names every leg that did NOT run, so a skipped leg is never silent. */
export function combineStructureResults(results) {
    const texts = (subset) => subset
        .map((result) => result.text)
        .filter(Boolean)
        .join('\n');
    const blocked = results.filter((result) => result.code === 1);
    const skipped = results.filter((result) => result.code === 2);
    if (blocked.length) {
        const errorCount = blocked.reduce((n, result) => n + result.errorCount, 0);
        return violations(errorCount, texts([...blocked, ...skipped]));
    }
    if (skipped.length)
        return { code: 2, errorCount: 0, text: texts(skipped) };
    return clean();
}
/** Nothing compiles structure.walls yet (sc-3148), so a declared wall rides every gate run — preset
 * leg, grammar leg or neither — as could-not-run, and can never fold into a clean 0. */
export function withUncompiledWalls(cwd, result) {
    let count;
    try {
        count = resolveGuardConfig(cwd).structure?.walls?.length ?? 0;
    }
    catch (e) {
        // A config that turned unreadable after the legs ran must not erase a violation they found.
        return combineStructureResults([
            result,
            couldNotRun(e instanceof Error ? e.message : String(e)),
        ]);
    }
    if (!count)
        return result;
    const gap = couldNotRun(`structure.walls declares ${count} import wall(s) that are NOT enforced`);
    return combineStructureResults([result, gap]);
}
