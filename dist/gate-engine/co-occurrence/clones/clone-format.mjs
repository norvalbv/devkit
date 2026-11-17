import { createHash } from 'node:crypto';
import { DEFAULT_DECAY_DAYS } from '../decay.mjs';
export const loc = (c, side) => {
    const v = c[side];
    return v instanceof Object ? v.line : v;
};
export const cloneRow = (c) => `  ${String(c.lines).padStart(3)}L  ${c.fragmentHash}  ${c.fileA}:${loc(c, 'startA')} <> ${c.fileB}:${loc(c, 'startB')}${c.kind === 'similar' ? `  (similar ${c.similarity})` : ''}`;
const filePairKey = (a, b) => [a, b].sort().join('\0');
/** Provenance of a lapsed approval, so a re-approval re-judges the original reason. */
export function lapsedNote(c, e) {
    const lifetime = e.decayDays === undefined
        ? `no lifetime recorded (${DEFAULT_DECAY_DAYS}-day default)`
        : `${e.decayDays}-day lifetime`;
    const moved = e.fileA && e.fileB && filePairKey(e.fileA, e.fileB) !== filePairKey(c.fileA, c.fileB);
    const where = moved ? ` — approved for ${e.fileA} <> ${e.fileB}` : '';
    return `approved ${e.date}, ${lifetime}${where}: "${e.description || 'no reason recorded'}"`;
}
const WHITESPACE_RE = /\s+/g;
/** Stable key: hash the fragment with whitespace collapsed so reformatting
 * doesn't change the key, but real code changes do. */
export function hashFragment(fragment) {
    const normalised = fragment.replace(WHITESPACE_RE, ' ').trim();
    return createHash('sha256').update(normalised).digest('hex').slice(0, 16);
}
/** Allowlist key: the file pair plus the fragment, so approving one copy never approves a third. */
export function cloneKey(fileA, fileB, fragment = '') {
    return hashFragment(`${[fileA, fileB].sort().join(' ')} ${fragment}`);
}
