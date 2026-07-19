/**
 * Shared read/write contract for `.co-occurrence-allowlist.json` — the single home for
 * the file's shape, its order-insensitive pair key, the corruption-refusing loader, and
 * the atomic writer. Consumed by BOTH detectors (matcher / clone-detector) and the
 * `guard-dup-allowlist` CRUD CLI, so the "refuse on a corrupt-but-present file" contract
 * that guards against silently wiping baselined entries lives in exactly one place.
 *
 * Side-effect free: importing this module runs NO CLI dispatch (unlike matcher.mts /
 * clone-detector.mts, which dispatch at top level and would `process.exit` a test worker
 * on import). That is why ALLOWLIST_CLI + MODES live here — the remedy-contract test can
 * import them without executing a bin.
 */
import { existsSync, readFileSync } from 'node:fs';
import { writeFileAtomic } from "./atomic-write.mjs";
/** The bin that owns allowlist CRUD — the exact name the gates print as their approval
 * remedy. One source of truth so the printed remedy and the `package.json` bin can't drift. */
export const ALLOWLIST_CLI = 'guard-dup-allowlist';
/** The verbs the CRUD CLI dispatches. `add` / `add-clone` are the two the gates print. */
export const MODES = [
    'add',
    'add-clone',
    'remove',
    'remove-clone',
    'check',
    'list',
    'prune',
];
/** Order-insensitive pair key: `"symbol file"` per side, the two sides sorted, so A/B
 * order never matters. Line ranges + similarity are metadata, NOT part of the key. */
export function symFileKey(p) {
    const a = `${p.symbolA} ${p.fileA}`;
    const b = `${p.symbolB} ${p.fileB}`;
    return a < b ? `${a} ${b}` : `${b} ${a}`;
}
/**
 * Load the allowlist, refusing (exit 2) on a corrupt-but-present file so a destructive
 * caller never overwrites baselined entries with `{}`. Missing file → empty (fine);
 * parseable-but-not-an-object is corruption too (else `.pairs` throws → exit 1 false-block).
 * `label` prefixes the refusal message ("co-occurrence matcher" / "clone-detector" /
 * "guard-dup-allowlist") so each caller's diagnostics read as before. Each array is
 * normalized independently so an odd-but-valid shape never discards the other.
 */
export function loadAllowlist(path, label) {
    if (!existsSync(path))
        return { pairs: [], clones: [] };
    let v;
    try {
        v = JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        console.error(`${label}: ${path} exists but is not valid JSON — refusing (restore it first).`);
        process.exit(2);
    }
    if (!v || typeof v !== 'object') {
        console.error(`${label}: ${path} is not a valid allowlist object — refusing (restore it first).`);
        process.exit(2);
    }
    return {
        pairs: Array.isArray(v.pairs) ? v.pairs : [],
        clones: Array.isArray(v.clones) ? v.clones : [],
    };
}
/** Atomically write the full `{ pairs, clones }` union (trailing newline). BOTH arrays are
 * always round-tripped so a pair rewrite never wipes clone approvals, and vice-versa.
 * ponytail: each write is atomic (temp + rename), but callers do read-modify-write with NO
 * cross-process lock — two concurrent CLI/matcher writes to the same allowlist are
 * last-writer-wins (the shared checkout's approval loses). Same ceiling as the matcher's
 * existing baseline/reconcile writes; add a per-file lock if parallel approval becomes real. */
export function saveAllowlist(path, data) {
    writeFileAtomic(path, `${JSON.stringify(data, null, 2)}\n`);
}
