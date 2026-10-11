// guard-structure's verdict trichotomy (0 clean, 1 violations, 2 could-not-run) and how per-leg
// verdicts fold into one gate result.
import { resolveGuardConfig } from '../config.mts';

// Outcome of the folder-structure gate: 0 lint ran and was clean, 1 violations, 2 could not run.
export interface StructureGateResult {
  code: 0 | 1 | 2;
  errorCount: number;
  text?: string;
}

// The trichotomy as named verdicts, so a call site states what it concluded instead of a bare
// number — `clean()` asserts a tree was read, `couldNotRun()` asserts one was not.
export const clean = (): StructureGateResult => ({ code: 0, errorCount: 0 });
export const violations = (errorCount: number, text?: string): StructureGateResult => ({
  code: 1,
  errorCount,
  text,
});
export const couldNotRun = (reason: string): StructureGateResult => ({
  code: 2,
  errorCount: 0,
  text: `guard-structure: gate did NOT run — ${reason}`,
});

/** Fold per-leg verdicts: any violation blocks, else any could-not-run fails open, else clean. A
 * blocking result still names every leg that did NOT run, so a skipped leg is never silent. */
export function combineStructureResults(results: StructureGateResult[]): StructureGateResult {
  const texts = (subset: StructureGateResult[]) =>
    subset
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
  if (skipped.length) return { code: 2, errorCount: 0, text: texts([...skipped, ...advisories]) };
  const text = texts(advisories);
  return text ? { code: 0, errorCount: 0, text } : clean();
}

/** Violations already present at HEAD in files the change only edits: reported, never blocking. */
export function preExisting(result: StructureGateResult, sha: string): StructureGateResult {
  if (result.code !== 1) return result;
  const head = `⚠ ${result.errorCount} pre-existing structure violation(s) at ${sha}, not caused by this change (advisory; CI lints the whole tree):`;
  return { code: 0, errorCount: 0, text: [head, result.text].filter(Boolean).join('\n') };
}

/** Nothing compiles structure.walls yet (sc-3148), so a declared wall rides every gate run — preset
 * leg, grammar leg or neither — as could-not-run, and can never fold into a clean 0. */
export function withUncompiledWalls(cwd: string, result: StructureGateResult): StructureGateResult {
  let count: number;
  try {
    count = resolveGuardConfig(cwd).structure?.walls?.length ?? 0;
  } catch (e: unknown) {
    // A config that turned unreadable after the legs ran must not erase a violation they found.
    return combineStructureResults([
      result,
      couldNotRun(e instanceof Error ? e.message : String(e)),
    ]);
  }
  if (!count) return result;
  const gap = couldNotRun(`structure.walls declares ${count} import wall(s) that are NOT enforced`);
  return combineStructureResults([result, gap]);
}
