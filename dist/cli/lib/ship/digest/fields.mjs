// Coercions for sink fields: a row is arbitrary JSON, so each helper degrades a wrong-typed value
// to '' or 0 instead of throwing — the digest's "every failure prints nothing" rule.
import { stripVTControlCharacters } from 'node:util';
export const DETAIL_CHARS = 140;
// C0/C1 controls a bare byte can carry past stripVTControlCharacters (a lone ESC, BEL, CSI).
const isControl = (ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 32 || (code >= 127 && code < 160);
};
export const oneLine = (text = '') => {
    // Template coercion: unvalidated JSON can hold a number here. Control bytes are stripped because a
    // committer controls a staged path, and printing it raw could forge or hide gate output.
    const visible = [...stripVTControlCharacters(`${text ?? ''}`)].map((ch) => isControl(ch) ? ' ' : ch);
    const flat = visible.join('').replace(/\s+/g, ' ').trim();
    return flat.length > DETAIL_CHARS ? `${flat.slice(0, DETAIL_CHARS - 1)}…` : flat;
};
/** A positive integer count, or 0. Untrusted JSON: isSafeInteger rejects a non-number WITHOUT
 * coercing it (coercing `{"toString":1,"valueOf":1}` throws), so `>` only sees a real number. */
export const count = (v) => v !== undefined && Number.isSafeInteger(v) && v > 0 ? v : 0;
/** A string field as text, or '' — via JSON.stringify, which never invokes a row-supplied
 * toString, so a non-string value degrades to '' instead of throwing. */
export const textOf = (v) => {
    const json = JSON.stringify(v ?? null);
    // SAFETY: only a string serializes to a `"…"` literal, and parsing one returns that exact string.
    return json.startsWith('"') ? JSON.parse(json) : '';
};
