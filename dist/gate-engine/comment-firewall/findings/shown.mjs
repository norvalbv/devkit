/** Over-budget paragraphs already shown once: the first sighting blocks, a retry passes. Keyed by
 * anchor (file plus surrounding code), so rewording a shown paragraph does not block it again. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const STORE = 'devkit/comment-shown';
export const SHOWN_RETAIN_MS = 30 * 24 * 60 * 60 * 1000;
/** The common dir, so a ship's throwaway worktree and the checkout behind it share one store. */
export function shownStorePath(cwd) {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
        cwd,
        encoding: 'utf8',
    }).trim();
    return path.resolve(cwd, common, STORE);
}
function shownAt(file) {
    try {
        return statSync(file).mtimeMs;
    }
    catch (error) {
        // SAFETY: statSync follows Node's filesystem contract and reports failures as ErrnoException.
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
}
function windowFile(dir, anchor, window) {
    return path.join(dir, `${anchor}.${window}`);
}
/** The anchors a sighting in this or the previous 30-day window still covers. Read-only: the
 * caller prints the block before recording it, so a crash in between can only show it twice. */
export function shownAnchors(cwd, anchors, now = Date.now()) {
    const dir = shownStorePath(cwd);
    const window = Math.floor(now / SHOWN_RETAIN_MS);
    return new Set(anchors.filter((anchor) => {
        const at = shownAt(windowFile(dir, anchor, window)) ?? shownAt(windowFile(dir, anchor, window - 1));
        return at !== null && now - at < SHOWN_RETAIN_MS;
    }));
}
/** One empty file per anchor per window, never rewritten or deleted, so concurrent gates cannot
 * erase each other's sightings; the first writer's time stands. */
export function recordShown(cwd, anchors, now = Date.now()) {
    if (anchors.length === 0)
        return;
    const dir = shownStorePath(cwd);
    mkdirSync(dir, { recursive: true });
    const window = Math.floor(now / SHOWN_RETAIN_MS);
    for (const anchor of anchors) {
        const file = windowFile(dir, anchor, window);
        try {
            writeFileSync(file, '', { flag: 'wx' });
        }
        catch (error) {
            // SAFETY: writeFileSync follows Node's filesystem contract and reports failures as ErrnoException.
            if (error.code === 'EEXIST')
                continue;
            throw error;
        }
        utimesSync(file, now / 1000, now / 1000);
    }
}
