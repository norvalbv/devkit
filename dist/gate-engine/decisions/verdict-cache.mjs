/**
 * Non-blocking-verdict cache for the decisions judges (detect ROUTINE, alignment ALIGN,
 * depth PASS): a judge that already cleared this exact evidence never re-runs. This is what
 * makes a ship RETRY converge — after a timeout kill, the re-run pays ~0s here instead of
 * re-spending the haiku/opus budget on an unchanged diff.
 *
 * Only CONFIDENT non-blocking verdicts are cached. Blocks are never cached (the author fixes
 * and the evidence changes), UNCLEAR/outage/null are never cached (not earned). Keys hash the
 * exact judge evidence bytes, so any staged change misses — sound for ship and ad-hoc commits
 * alike. Storage/atomicity/failure direction: shared judge/verdict-store
 * (`.devkit/decisions-verdict-cache.json`, main-checkout anchored, corrupt → re-judge).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { devkitDataFile, loadEntries, saveEntries } from '../judge/verdict-store.mjs';
const STORE_FILE = 'decisions-verdict-cache.json';
// Version salt (same rationale as prefix-cache): a devkit upgrade can change a judge's prompt
// or parsing, so verdicts earned by an older judge must not be honoured by a newer one.
function devkitVersion() {
    try {
        const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
        return pkg.version;
    }
    catch {
        return 'unknown';
    }
}
/** Stable cache key: `<judgeId>:<sha256 of devkit version + the evidence parts>`. */
export function verdictKey(judgeId, ...evidenceParts) {
    const h = createHash('sha256');
    h.update(devkitVersion()).update('\0');
    for (const part of evidenceParts)
        h.update(String(part)).update('\0');
    return `${judgeId}:${h.digest('hex')}`;
}
/** True when this exact evidence already earned its non-blocking verdict. */
export function hasVerdict(cwd, key) {
    return Boolean(loadEntries(devkitDataFile(cwd, STORE_FILE))[key]);
}
/** Remember an earned non-blocking verdict (best-effort). */
export function saveVerdict(cwd, key) {
    saveEntries(devkitDataFile(cwd, STORE_FILE), { [key]: { at: new Date().toISOString() } });
}
