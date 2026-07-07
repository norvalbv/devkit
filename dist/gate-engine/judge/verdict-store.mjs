/**
 * Shared keyed pass-cache store for gate verdicts (review PASSes, decisions ROUTINE/ALIGN,
 * the deterministic-prefix all-green key). One JSON file per CONSUMER repo under `.devkit/`
 * (never shipped — per-repo data). Lives in the judge domain because it is a shared service
 * the verdict-producing engines already depend on (run-judge, judge-isolation): one store
 * here instead of a vendored copy per engine.
 *
 * Path anchors to the MAIN checkout's `.devkit/` via `git rev-parse --git-common-dir`: a
 * linked worktree (devkit ship) resolves to the same file as the main tree, so a verdict
 * earned before shipping costs nothing inside the ship worktree. Fallback (not a repo /
 * git absent) is the cwd — degraded but functional.
 *
 * Writes are atomic (same-directory temp + rename) so a reader never sees a torn file —
 * concurrent ships in sibling worktrees share these files, and a torn read would make
 * `loadEntries` return {} and the next writer silently drop every prior entry. No lock:
 * the cross-process lost-UPDATE race (two read-merge-write callers, last rename wins)
 * remains and costs at most a lost entry — re-review, never a false PASS.
 *
 * Failure direction: corrupt/unreadable store reads as EMPTY (re-run the gate, never skip);
 * a failed write is swallowed (the verdict stands for this run, it just isn't remembered).
 */
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const MAX_ENTRIES = 100;
/** Absolute path of a `.devkit/<relName>` data file, anchored to the main checkout. */
export function devkitDataFile(cwd, relName) {
    let root = cwd;
    try {
        const common = execSync('git rev-parse --git-common-dir', { cwd, encoding: 'utf8' }).trim();
        root = path.dirname(path.isAbsolute(common) ? common : path.resolve(cwd, common));
    }
    catch {
        // not a repo / git absent → per-cwd store (degraded but functional)
    }
    return path.join(root, '.devkit', relName);
}
/** entries map (key → meta); corrupt/absent/foreign-version → {} (fails toward re-run). */
export function loadEntries(file) {
    try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (parsed?.version !== 1 || typeof parsed.entries !== 'object' || !parsed.entries)
            return {};
        return parsed.entries;
    }
    catch {
        return {};
    }
}
/** Merge entries in and prune to the newest MAX_ENTRIES (by meta.at). Atomic, best-effort. */
export function saveEntries(file, keyToMeta) {
    const merged = { ...loadEntries(file), ...keyToMeta };
    const newest = Object.entries(merged)
        .sort((a, b) => String(b[1]?.at ?? '').localeCompare(String(a[1]?.at ?? '')))
        .slice(0, MAX_ENTRIES);
    writeStore(file, Object.fromEntries(newest));
}
/** Drop every entry (the engines' `clear-cache` escape hatch). Best-effort. */
export function clearEntries(file) {
    writeStore(file, {});
}
function writeStore(file, entries) {
    const tmp = `${file}.${process.pid}.tmp`;
    try {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(tmp, `${JSON.stringify({ version: 1, entries })}\n`, 'utf8');
        renameSync(tmp, file);
    }
    catch {
        try {
            unlinkSync(tmp);
        }
        catch {
            // temp never created, or already renamed — nothing to clean
        }
        // unwritable store = slower next run, never a gate failure
    }
}
