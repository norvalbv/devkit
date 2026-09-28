// Exact-string signals (sc-3404): shapes marking a multi-word pattern as copied output, not a
// description. A leaf module so search-tool-lib.mts imports it without a cycle.
export const RE_LEADING_CAP = /^[A-Z]/;
export const RE_QUESTION_WORD = /^(where|how|what|which|who|why|when)\b/i;
export const RE_DESCRIPTIVE = /^(function|code|logic|handler|component|hook)\s+(that|which|for|to)\b/i;
export const RE_QUOTE_OR_COLON = /['"`:]/;
export const RE_LEADING_NONWORD = /^[^\w]+/;
// Declaration modifiers: a pattern of them + one identifier is a verbatim code snippet
// (looksLikeCodeSnippet in search-tool-lib.mts), and never counts as copied output.
export const CODE_KEYWORDS = new Set([
    'export',
    'import',
    'async',
    'function',
    'const',
    'let',
    'var',
    'class',
    'interface',
    'type',
    'def',
    'return',
    'public',
    'private',
    'protected',
    'static',
    'struct',
    'fn',
    'impl',
    'enum',
    'namespace',
    'pub',
    'func',
]);
// CODE_KEYWORDS plus other languages' declaration words: the fixed list that marks a pattern as code.
const DECLARATION_WORDS = new Set([
    ...CODE_KEYWORDS,
    ...[
        'trait',
        'module',
        'mod',
        'protocol',
        'val',
        'macro',
        'union',
        'typedef',
        'sealed',
        'abstract',
    ],
    ...['override', 'virtual', 'extern', 'unsafe', 'extends', 'implements', 'void', 'sub', 'proc'],
    ...['defn', 'lambda', 'yield', 'await', 'throw', 'raise'],
]);
// RE_META_OR_PUNCT minus ? : = (English queries carry those). The tokenizer strips the `\` of a
// double-quoted `\(`, so the bare `(` is what arrives.
const RE_EXACT_PUNCT = /[\\^$|(){}[\]+*]/;
// A constant name with an underscore (MAX_RETRY) — NOT a bare acronym, which
// concept queries lead with ("API rate limiting", "HTTP2 server config").
const RE_CONSTANT_TOKEN = /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/;
const RE_EDGE_PUNCT = /^[^\w]+|[^\w]+$/g;
const RE_WHITESPACE = /\s+/;
// A word, not code: lowercase, Capitalized, or ALL-CAPS (a sentinel, constant or acronym).
const RE_WORD_LIKE = /^(?:[a-z]{2,}|[A-Z][a-z]+|[A-Z][A-Z0-9_]+)$/;
// All-caps status words that log and gate output print verbatim.
const LOG_SENTINELS = new Set([
    'NONE',
    'TODO',
    'FIXME',
    'XXX',
    'WARN',
    'WARNING',
    'ERROR',
    'FAIL',
    'FAILED',
    'NULL',
    'PASS',
]);
// Does any word, stripped of edge punctuation ("NONE," / "[WARN]"), read as
// a log sentinel or an underscore constant?
function hasSentinelToken(words) {
    return words.some((w) => {
        const bare = w.replace(RE_EDGE_PUNCT, '');
        return LOG_SENTINELS.has(bare) || RE_CONSTANT_TOKEN.test(bare);
    });
}
// Why a 3-word pattern reads as copied output, or null (classify()'s 3-word tier).
export function exactSignalReason(trimmed, words) {
    if (RE_EXACT_PUNCT.test(trimmed))
        return 'exact-string punctuation';
    return hasSentinelToken(words) ? 'log sentinel / constant token' : null;
}
// Copied output reads as words with code in it: no declaration keyword anywhere (`function: getUser()`)
// and at least two word-like tokens (`ERROR TIMEOUT`, `MAX_RETRY exceeded`), so `getUser(id, opts)` is not.
export function looksLikeCopiedOutput(trimmed) {
    const lead = trimmed.replace(RE_LEADING_NONWORD, '');
    if (RE_QUESTION_WORD.test(lead) || RE_DESCRIPTIVE.test(lead))
        return false;
    const words = trimmed.split(RE_WHITESPACE).filter(Boolean);
    const bare = words.map((w) => w.replace(RE_EDGE_PUNCT, ''));
    if (bare.some((w) => DECLARATION_WORDS.has(w.toLowerCase())))
        return false;
    if (bare.filter((w) => RE_WORD_LIKE.test(w)).length < 2)
        return false;
    return (RE_EXACT_PUNCT.test(trimmed) ||
        hasSentinelToken(words) ||
        (RE_LEADING_CAP.test(trimmed) && RE_QUOTE_OR_COLON.test(trimmed)));
}
