// One digest row per waived finding: a PASS resting on `guard-review waive` must not read as clean.
import { oneLine, textOf } from './fields.mjs';
export const FINGERPRINT = /^[0-9a-f]{12}$/;
/** Every waiver a review_result (any status) or cache_hit names, once per gate+fingerprint. A
 * cache entry stores no rationale, so a row without one says it was replayed instead. */
export function waivedRows(events) {
    const rows = new Map();
    for (const e of events) {
        if ((e.type !== 'review_result' && e.type !== 'cache_hit') || !Array.isArray(e.waivers))
            continue;
        const gate = e.type === 'review_result'
            ? `review:${oneLine(textOf(e.reviewer)) || 'unknown'}`
            : oneLine(textOf(e.judge)) || 'unknown';
        for (const w of e.waivers) {
            const fp = textOf(w?.fingerprint);
            const why = oneLine(textOf(w?.rationale));
            if (!FINGERPRINT.test(fp) || rows.get(`${gate}:${fp}`)?.why)
                continue;
            const lens = oneLine(textOf(w?.lens)) || '(finding)';
            const detail = `${lens} waived [${fp}]${why ? `: ${why}` : ' (cached PASS)'}`;
            // findings: 0 — the header counts IDs a reader must clear, and a waived one needs nothing.
            const row = {
                gate,
                state: 'unverified',
                blocking: false,
                detail,
                fp,
                findings: 0,
            };
            rows.set(`${gate}:${fp}`, { row, why });
        }
    }
    return [...rows.values()].map((v) => v.row);
}
