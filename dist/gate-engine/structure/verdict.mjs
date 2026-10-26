// guard-structure's verdict trichotomy (0 clean, 1 violations, 2 could-not-run) and how per-leg
// verdicts fold into one gate result.
import { z } from 'zod';
import { CONFIG_FILENAME, resolveGuardConfig } from '../config.mjs';
import { loadSourceParser } from './source-parser.mjs';
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
    const advisories = results.filter((result) => result.code === 0);
    if (blocked.length) {
        const errorCount = blocked.reduce((n, result) => n + result.errorCount, 0);
        return violations(errorCount, texts([...blocked, ...skipped, ...advisories]));
    }
    if (skipped.length)
        return { code: 2, errorCount: 0, text: texts([...skipped, ...advisories]) };
    const text = texts(advisories);
    return text ? { code: 0, errorCount: 0, text } : clean();
}
/** Violations already present at HEAD in files the change only edits: reported, never blocking. */
export function preExisting(result, sha) {
    if (result.code !== 1)
        return result;
    const head = `⚠ ${result.errorCount} pre-existing structure violation(s) at ${sha}, not caused by this change (advisory; CI lints the whole tree):`;
    return { code: 0, errorCount: 0, text: [head, result.text].filter(Boolean).join('\n') };
}
// A present-but-malformed block resolves to empty lists; name it, never read it as "none declared".
// A top-level null stays absent, as the resolver treats it; a non-object tree entry has no root.
const structureConfigSchema = z
    .object({ trees: z.array(z.looseObject({})).optional(), walls: z.array(z.unknown()).optional() })
    .nullish();
function malformedStructure(cfg) {
    const parsed = structureConfigSchema.safeParse(cfg.structureRaw);
    if (parsed.success)
        return [];
    return parsed.error.issues.map((issue) => `${CONFIG_FILENAME} ${['structure', ...issue.path].join('.')}: ${issue.message} — nothing in it is checked`);
}
// Nothing compiles structure.walls yet, so a declared wall is could-not-run, never a clean 0.
function uncompiledWalls(cfg, loadParser) {
    const count = cfg.structure.walls.length;
    if (!count)
        return [];
    const reasons = [`structure.walls declares ${count} import wall(s) that are NOT enforced`];
    // A parser that cannot load would leave the walls blind even once they compile, so name it too.
    const source = loadParser();
    if ('reason' in source)
        reasons.push(source.reason);
    return reasons;
}
/** Fold every structure-config gap into a gate result — preset leg, grammar leg or neither — as
 * could-not-run, so a config the gate could not honour never reads as a clean 0. */
export function withStructureConfigGaps(cwd, result, loadParser = loadSourceParser) {
    let reasons;
    try {
        const cfg = resolveGuardConfig(cwd);
        reasons = [...malformedStructure(cfg), ...uncompiledWalls(cfg, loadParser)];
    }
    catch (e) {
        // A config that turned unreadable after the legs ran must not erase a violation they found.
        reasons = [e instanceof Error ? e.message : String(e)];
    }
    if (!reasons.length)
        return result;
    return combineStructureResults([result, ...reasons.map(couldNotRun)]);
}
