/** The five states gh collapses `state` into. Ordered for stable rendering, not by severity. */
export const CHECK_BUCKETS = ['pass', 'fail', 'pending', 'skipping', 'cancel'];
/** The `--json` fields this reader dereferences, as one gh argument. */
export const CHECKS_JSON_FIELDS = 'bucket,name,state,link,workflow';
const BUCKET_NAMES = new Set(CHECK_BUCKETS);
/** Blank for non-Actions checks (CodeRabbit reports both), so presence is proven, not content. */
const TEXT_FIELDS = ['name', 'state', 'link', 'workflow'];
/** Every field this reader dereferences, compared by round-trip rather than a representation check. */
function isCheckRow(value) {
    return (!!value &&
        `${value.bucket}` === value.bucket &&
        BUCKET_NAMES.has(String(value.bucket)) &&
        TEXT_FIELDS.every((f) => `${value[f]}` === value[f]));
}
/** Parse gh's `--json` array, rejecting any row that fails the guard above. */
export function parseChecksJson(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (!Array.isArray(parsed))
        return null;
    const rows = [];
    for (const entry of parsed) {
        if (!isCheckRow(entry))
            return null;
        rows.push(entry);
    }
    return rows;
}
