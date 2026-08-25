import { createHash } from 'node:crypto';
import { diffCacheIdentity, filePathOf, splitDiffByFile } from "../../judge/diff-focus.mjs";
const QUOTED_PATH_RE = /^"[\s\S]*"$/;
const OCTAL_ESCAPE_RE = /^[0-7]{1,3}/;
/** Git's full C-quote single-character escape set (quote.c's cq_lookup): every entry must decode,
 * or a valid quoted path misdecodes to a literal-backslash name and misses its staged twin. */
const SIMPLE_ESCAPES = new Map([
    ['a', 7],
    ['b', 8],
    ['t', 9],
    ['n', 10],
    ['v', 11],
    ['f', 12],
    ['r', 13],
    ['"', 34],
    ['\\', 92],
]);
/** Decode a C-quoted git path (`core.quotePath`'s default): surrounding double quotes plus the
 * single-character escapes above and octal `\NNN` byte escapes. A path git did not need to quote
 * (the common case) is returned unchanged. Escapes decode to raw BYTES first — git escapes
 * non-ASCII as octal byte sequences, not codepoints — so a multi-byte UTF-8 character split
 * across adjacent `\NNN` escapes reassembles correctly. Literal (unescaped) runs re-encode as
 * UTF-8 bytes, NOT UTF-16 code units — under `core.quotePath=false` git emits non-ASCII like `é`
 * literally inside a still-quoted path (quoted for a tab, say), and pushing the lone code unit
 * 0xE9 forges invalid UTF-8 that mangles the name into a 0-byte-packing key. */
export function unquoteGitPath(raw) {
    if (!QUOTED_PATH_RE.test(raw))
        return raw;
    const inner = raw.slice(1, -1);
    const bytes = [];
    // Start index of the pending literal run, or -1 — batching the run through Buffer.from also
    // keeps surrogate pairs whole, where per-char charCodeAt would split them.
    let literalStart = -1;
    const flushLiteral = (end) => {
        if (literalStart === -1)
            return;
        bytes.push(...Buffer.from(inner.slice(literalStart, end), 'utf8'));
        literalStart = -1;
    };
    for (let i = 0; i < inner.length; i += 1) {
        const ch = inner[i];
        if (ch !== '\\') {
            if (literalStart === -1)
                literalStart = i;
            continue;
        }
        flushLiteral(i);
        const next = inner[i + 1];
        const simple = next !== undefined ? SIMPLE_ESCAPES.get(next) : undefined;
        if (simple !== undefined) {
            bytes.push(simple);
            i += 1;
        }
        else if (next !== undefined && next >= '0' && next <= '7') {
            const octal = inner.slice(i + 1, i + 4).match(OCTAL_ESCAPE_RE)?.[0] ?? '';
            bytes.push(parseInt(octal, 8) & 0xff);
            i += octal.length;
        }
        else {
            bytes.push(92);
        }
    }
    flushLiteral(inner.length);
    return Buffer.from(bytes).toString('utf8');
}
/** `filePathOf`'s raw match for a QUOTED path carries a synthetic prefix baked INSIDE the quotes
 * — its regexes can only strip an UNQUOTED `a/`/`b/` (their `(?:a\/)?`/`(?:b\/)?` groups never
 * match past the opening quote character). The usual `+++` match always carries a synthetic `b/`;
 * its `/dev/null` (deletion) or absent (binary diff) fallback to the `diff --git a/… b/…` header
 * always carries a synthetic `a/` instead — exactly one, never both, so stripping whichever is
 * present is unambiguous. An unquoted match never has this problem, its prefix was already
 * stripped before capture. */
function normalizePostImagePath(raw) {
    const wasQuoted = raw.startsWith('"');
    const decoded = unquoteGitPath(raw);
    if (!wasQuoted)
        return decoded;
    if (decoded.startsWith('b/'))
        return decoded.slice(2);
    if (decoded.startsWith('a/'))
        return decoded.slice(2);
    return decoded;
}
/** The resolved post-image path for one `splitDiffByFile` segment — the ONE rename-aware,
 * quote-aware resolution rule shared by `identityByPath` (chunk-packing boundaries) and
 * `verify-extras.mts`'s hunk lookup, so both close the same set of paths for a segment and never
 * disagree on a rename-only segment. A hunkless rename-only (or copy-only) segment has no '+++'
 * line, so `filePathOf` falls back to the pre-image 'a/' path — prefer the explicit
 * 'rename to'/'copy to' post-image name in that case. Either path may be C-quoted by git (tab/backslash/non-ASCII bytes in the
 * name); decode it so a quoted path lines up with the plain staged name callers pass in. */
export function postImagePathOf(seg) {
    const renamed = seg.match(/^(?:rename|copy) to (.+)$/m)?.[1];
    if (renamed !== undefined)
        return unquoteGitPath(renamed);
    // Full-line capture, NOT filePathOf: its `\S+` groups truncate any name containing a literal
    // space — which git does NOT quote (core.quotePath quotes controls/non-ASCII, never plain
    // spaces) — silently reintroducing the 0-byte packing defect for such files. The `+++` line's
    // payload is the whole rest of the line.
    const plus = seg.match(/^\+\+\+ (.+)$/m)?.[1];
    if (plus !== undefined && plus !== '/dev/null') {
        const decoded = unquoteGitPath(plus);
        return decoded.startsWith('b/') ? decoded.slice(2) : decoded;
    }
    // Rename/copy-less segment with no '+++' (binary/mode-only): fall back to the `diff --git`
    // header. Quoted sides parse exactly. For unquoted sides the a-path and b-path are IDENTICAL
    // here (a differing pair always carries a rename/copy line, handled above), so demand
    // `a/<p> b/<p>` with MATCHING halves — the backreference makes the split point unambiguous even
    // for a name that itself contains the literal substring ' b/', where a first-`indexOf(' b/')`
    // split would land inside the a-path and key the file under a wrong (0-byte-packing) name.
    const header = seg.match(/^diff --git (.+)$/m)?.[1];
    if (header === undefined)
        return null;
    if (header.startsWith('"')) {
        const quoted = header.match(/^"(?:[^"\\]|\\.)*"/)?.[0];
        if (quoted) {
            const rest = header.slice(quoted.length).trimStart();
            const second = rest.startsWith('"') ? (rest.match(/^"(?:[^"\\]|\\.)*"/)?.[0] ?? rest) : rest;
            const decoded = unquoteGitPath(second);
            return decoded.startsWith('b/') ? decoded.slice(2) : decoded;
        }
    }
    const symmetric = header.match(/^a\/(.+) b\/\1$/)?.[1];
    if (symmetric !== undefined)
        return symmetric;
    const raw = filePathOf(seg);
    return raw ? normalizePostImagePath(raw) : null;
}
/** Per-file normalized diff identity, keyed by postImagePathOf's resolved path (renames land
 * under the new name — the staged name callers pass in). Chunk boundaries inherit
 * diffCacheIdentity's normalization rules; a change there re-homes files, which the boundary test
 * pins. */
export function identityByPath(diffText) {
    const out = new Map();
    for (const seg of splitDiffByFile(diffText)) {
        const path = postImagePathOf(seg);
        if (!path)
            continue;
        out.set(path, (out.get(path) ?? '') + diffCacheIdentity(seg));
    }
    return out;
}
/** Per-file identity bytes of a unified diff — the same normalized unit the verdict cache keys on. */
export function identityBytesByPath(diffText) {
    const out = new Map();
    for (const [path, identity] of identityByPath(diffText))
        out.set(path, Buffer.byteLength(identity, 'utf8'));
    return out;
}
/**
 * Next-fit pack in sorted-path order (siblings stay together; a closed chunk is never revisited): each chunk holds whole files up to
 * `capBytes` of identity bytes; a single file over the cap gets its own chunk. Deterministic for a
 * given (files, diff) pair, so re-runs and checkpoints agree on chunk indexes.
 */
export function packDiffIntoChunks(files, diffText, capBytes) {
    const bytesByPath = identityBytesByPath(diffText);
    const chunks = [];
    let current = [];
    let used = 0;
    for (const file of [...files].sort()) {
        // `files` carries the staged names `git diff --cached --name-only` printed, which quotes the
        // same way the diff body does — decode before lookup so a quoted staged name still finds its
        // identityByPath entry instead of silently packing as 0 bytes.
        const size = bytesByPath.get(file) ?? bytesByPath.get(unquoteGitPath(file)) ?? 0;
        if (current.length > 0 && used + size > capBytes) {
            chunks.push(current);
            current = [];
            used = 0;
        }
        current.push(file);
        used += size;
    }
    if (current.length > 0)
        chunks.push(current);
    return { chunks, bytesByPath };
}
/** sha256-12 of a chunk's file membership (paths joined on '\0'): the identity half of every
 * chunk key and telemetry row — a bare index is unstable across packing changes (see
 * ChunkAssignment). */
export function chunkFilesSha(files) {
    return createHash('sha256').update(files.join('\0')).digest('hex').slice(0, 12);
}
/** sha256-12 over the ordered per-chunk membership hashes — the whole plan's identity: any
 * re-homing of files across chunks reads as a different plan. */
export function chunkPlanHash(chunks) {
    return createHash('sha256')
        .update(chunks.map((c) => chunkFilesSha(c)).join('\0'))
        .digest('hex')
        .slice(0, 12);
}
/** The sub-diff a chunk's judges receive: only the segments whose post-image path is in the
 * chunk. Resolution MUST be postImagePathOf — the same rule that packed the chunk — or a
 * renamed/quoted file would pack into a chunk whose sub-diff then omits it, judging silence. */
export function chunkDiffText(diffText, files) {
    const wanted = new Set(files.map((f) => unquoteGitPath(f)));
    return splitDiffByFile(diffText)
        .filter((seg) => {
        const path = postImagePathOf(seg);
        return path !== null && wanted.has(path);
    })
        .join('');
}
