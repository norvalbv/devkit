import { DEFAULT_DECAY_DAYS } from '../decay.mjs';
export const loc = (c, side) => {
    const v = c[side];
    return typeof v === 'number' ? v : v.line;
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
