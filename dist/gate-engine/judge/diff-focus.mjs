// Shared diff-evidence primitives for the diff-fed judge gates. Every gate that hands its `claude -p`
// judge a slice of the staged diff (sentry's focusDiff, the decisions `detect` judge, the domain
// reviewers) first splits the diff into per-file segments — three near-identical copies of the same
// `diff --git` split regex. This is the one shared primitive. `focusHunks` additionally selects the
// RELEVANT hunks per file (sentry's pattern, generalized) so any gate can send the judge just the
// signal, keyed on its own per-hunk predicate.
//
// Deterministic EVIDENCE selection only — the LLM still decides the verdict.
// Real `git diff --cached` prefixes each file with `diff --git`; a hand-authored / preamble-free diff
// (some eval fixtures) starts each file at `--- `. Split on whichever the diff uses so a next file's
// header can never leak into the previous file's segment (a path like `catch-utils.ts` must not trip a
// content predicate on the prior file).
const GIT_HEADER_RE = /^diff --git /m;
const GIT_SPLIT_RE = /^(?=diff --git )/m;
const OLD_FILE_SPLIT_RE = /^(?=--- )/m;
const POST_PATH_RE = /^\+\+\+ (?:b\/)?(\S+)/m;
const GIT_PATH_RE = /^diff --git (?:a\/)?(\S+)/m;
const HUNK_SPLIT_RE = /\n(?=@@ )/;
/** Split a unified diff into per-file segments (each = one file's header + its hunks). Empty leading
 * segments (git's `^`-anchored boundary) are dropped. Behaviour-identical to the three call sites it
 * replaces. */
export function splitDiffByFile(diff) {
    const text = String(diff);
    if (!text.trim())
        return [];
    const boundary = GIT_HEADER_RE.test(text) ? GIT_SPLIT_RE : OLD_FILE_SPLIT_RE;
    return text.split(boundary).filter((s) => s.trim());
}
/** The post-image path of a diff segment (`+++ b/<path>`, else the `diff --git` path), or null. */
export function filePathOf(segment) {
    const post = segment.match(POST_PATH_RE)?.[1];
    if (post && post !== '/dev/null')
        return post;
    return segment.match(GIT_PATH_RE)?.[1] ?? null;
}
/**
 * Focus a diff to its RELEVANT hunks: a header listing every changed file, then only the hunks for
 * which `isRelevant(hunk)` holds, then a count of what was dropped. A file with no relevant hunk stays
 * in the header (so the judge still knows the commit's shape). `omitNoun` labels the dropped hunks in
 * the omission line (e.g. sentry uses 'non-error').
 */
export function focusHunks(diff, isRelevant, omitNoun = 'unrelated') {
    const files = [];
    const kept = [];
    let omitted = 0;
    for (const seg of splitDiffByFile(diff)) {
        const file = filePathOf(seg);
        if (file)
            files.push(file);
        const hunks = seg.split(HUNK_SPLIT_RE);
        const head = hunks[0].startsWith('@@') ? '' : (hunks.shift() ?? ''); // the file header
        const relevant = [];
        for (const h of hunks) {
            if (!h.startsWith('@@'))
                continue;
            if (isRelevant(h))
                relevant.push(h);
            else
                omitted += 1;
        }
        if (relevant.length)
            kept.push(`${head.trim()}\n${relevant.join('\n')}`.trim());
    }
    const header = files.length ? `CHANGED FILES: ${files.join(', ')}\n` : '';
    const note = omitted ? `[${omitted} ${omitNoun} hunk(s) omitted]\n` : '';
    return `${header}${note}${kept.join('\n')}`.trim();
}
// A purely-additive Sentry instrumentation line — matched CONSERVATIVELY, because every match is
// erased from the cache identity and can therefore never invalidate an earned verdict:
//   - The call must be `Sentry.`-QUALIFIED. NO bare names, wrappers included: a bare
//     `captureException(...)` or `captureMainMessage(...)` from an arbitrary module may be a local
//     function carrying real logic and must invalidate — origin cannot be checked from one diff
//     line, so unqualified calls simply cost a re-review.
//   - Arguments must be inert: identifier/member chains or plain string literals, comma-separated.
//     No nested calls (`captureException(mutate(err))` is REAL logic riding along), no template
//     literals, no object payloads — a multi-line capture's opening line ends in `{`/`(` and fails
//     the whole-line match anyway.
//   - Imports ARE origin-checked, so they may name the wrapper: anything from an `@sentry/*`
//     package, or a named import of only the recognized capture names from a path naming sentry.
const SENTRY_ARG = /(?:[\w$.]+|'[^']*'|"[^"]*")/;
const SENTRY_CAPTURE_RE = new RegExp(`^(?:await\\s+)?(?:void\\s+)?Sentry\\.capture(?:Exception|Message)\\(\\s*(?:${SENTRY_ARG.source}(?:\\s*,\\s*${SENTRY_ARG.source})*\\s*)?\\);?$`);
// The named-import alternative's path must NAME sentry as its final segment's leading word
// (`./sentry`, `../lib/sentry-client`, `electron/sentry.main`) — a substring match would also strip
// e.g. `../utils/presentry-shim`, a local module whose real logic must invalidate.
const SENTRY_IMPORT_RE = /^import\s+(?:type\s+)?(?:\*\s+as\s+\w+|\w+|\{[^}]*\})\s+from\s+['"]@sentry\/[^'"]+['"];?$|^import\s+\{\s*capture(?:Exception|Message|MainMessage)(?:\s*,\s*capture(?:Exception|Message|MainMessage))*\s*\}\s+from\s+['"](?:[^'"]*\/)?[sS]entry(?:[-.][^'"]*)?['"];?$/;
const HUNK_HEADER_RE = /^@@ /;
const HUNK_FUNC_RE = /^@@ [^@]*@@ ?/;
const HUNK_OLD_START_RE = /^@@ -(\d+)/;
const INDEX_LINE_RE = /^index [0-9a-f]+\.\.[0-9a-f]+/;
function sentryAdditive(content) {
    return SENTRY_CAPTURE_RE.test(content) || SENTRY_IMPORT_RE.test(content);
}
/**
 * The diff's CACHE IDENTITY: the text hashed into a gate's verdict-cache key, normalized so that a
 * restage whose only delta is purely-additive Sentry instrumentation (the exact fix the sentry gate
 * blocks for) hashes identically to the pre-fix diff — earned reviewer PASSes survive the fix
 * commit instead of re-billing the whole fleet for one capture line.
 *
 * Why headers AND context must go: inserting one line shifts every later `@@` coordinate, can
 * extend a hunk's trailing context, materialize a brand-new hunk (~6 context lines the old diff
 * never showed), or merge adjacent hunks — so any surviving context/`@@`/`index` byte would still
 * miss. What remains per file is its header identity plus the ordered `±` content lines, with
 * sentry-additive `+` lines dropped (`-` lines NEVER dropped: removing instrumentation is a real
 * change). A file whose surviving body is empty (touched only by sentry lines) drops entirely.
 *
 * What survives per file: its header identity, plus each hunk's anchor followed by that hunk's
 * surviving `±` lines. The anchor is git's FUNCTION CONTEXT (the text after the second `@@` —
 * stable under line-number shifts); where git emits none (JSON, hunks above a file's first
 * anchor-matching line) it is the hunk's OLD-side start line, which a purely-additive restage
 * cannot move (both diffs share the pre-image). Consecutive identical anchors collapse to one, so
 * two same-function hunks merging (a capture inserted between them) keeps the identity stable,
 * while relocating a change into a different function — or, for anchorless types, a different
 * old-side position — voids the key. Deliberate residual weakening: context bytes and hunked
 * files' blob shas are excluded, so relocating a change WITHIN one anchor span (same anchor, same
 * `±` sequence) does not invalidate — a narrow residual, and every consumer still salts the key
 * with reviewer identity, Targets, lens group, and devkit version. NOT for judge evidence —
 * judges read the raw diff.
 *
 * Fixpoint guarantee: a hunk-less segment (binary / mode-only / rename-only / non-diff text)
 * passes through VERBATIM, `index` shas included — a binary blob's sha is its only content
 * identity — so unexpected input degrades to exact-bytes keying.
 */
export function diffCacheIdentity(diff) {
    const out = [];
    for (const seg of splitDiffByFile(diff)) {
        const lines = seg.split('\n');
        const firstHunk = lines.findIndex((l) => HUNK_HEADER_RE.test(l));
        if (firstHunk === -1) {
            // Hunk-less segment (binary / mode-only / rename-only / non-diff text): keep it VERBATIM,
            // `index` shas included — for a git-binary file those shas are the only content identity,
            // and they move only when the blob does. This is the exact-bytes degradation path.
            if (seg.trim())
                out.push(seg.trim());
            continue;
        }
        const header = lines.slice(0, firstHunk).filter((l) => !INDEX_LINE_RE.test(l));
        const body = [];
        let anchor = ''; // current hunk's anchor; emitted lazily, deduped consecutively
        let emitted = null;
        for (const line of lines.slice(firstHunk)) {
            if (HUNK_HEADER_RE.test(line)) {
                // Anchor on git's function context; where git emits none (JSON, top-of-file hunks, .sh
                // preambles), fall back to the OLD-side start line — stable across a purely-additive
                // restage (the pre-image is shared), yet distinct across relocations within the file.
                const func = line.replace(HUNK_FUNC_RE, '');
                anchor = func ? `@ ${func}` : `@ :${line.match(HUNK_OLD_START_RE)?.[1] ?? '?'}`;
                continue;
            }
            if (line.startsWith('-') || (line.startsWith('+') && !sentryAdditive(line.slice(1).trim()))) {
                // `+++` can't reach here — file headers all precede the first `@@`, so every `+` is an add.
                if (anchor !== emitted) {
                    body.push(anchor);
                    emitted = anchor;
                }
                body.push(line);
            }
            // everything else — ` ` context, blank context, `\ No newline` — is dropped
        }
        if (body.length)
            out.push([...header, ...body].join('\n'));
    }
    // A diff whose EVERY line normalized away (a wholly-sentry-additive commit) must not collapse to
    // the one shared empty identity — two unrelated capture-only commits would collide on a key and
    // share a verdict/waiver. There is no prior verdict such a commit could converge to anyway, so
    // degrade it to exact-bytes keying.
    return out.length ? out.join('\n') : String(diff);
}
