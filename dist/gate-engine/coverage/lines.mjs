/** Line coverage from an istanbul/V8 coverage-final.json entry, and its intersection with the lines a
 * change added — the unit a "coverage of the new diff" target means (sc-3228). */
/** istanbul's line definition: a line is executable when a statement STARTS on it, and covered when
 * ANY statement starting on it ran. Shared with the gate's `lines` metric so the two never disagree. */
export function lineHits(file) {
    const hits = new Map();
    for (const [id, loc] of Object.entries(file.statementMap ?? {})) {
        const line = loc.start?.line;
        if (typeof line !== 'number')
            continue;
        const ran = (file.s?.[id] ?? 0) > 0;
        hits.set(line, (hits.get(line) ?? false) || ran);
    }
    return hits;
}
/** Coverage over the ADDED lines only. An added line with no statement (a comment, a brace, a type)
 * is not executable and counts for neither side. */
export function addedLineCoverage(file, added) {
    const hits = lineHits(file);
    const uncovered = [];
    let total = 0;
    for (const line of [...added].sort((a, b) => a - b)) {
        const hit = hits.get(line);
        if (hit === undefined)
            continue;
        total += 1;
        if (!hit)
            uncovered.push(line);
    }
    return { covered: total - uncovered.length, total, uncovered };
}
/** `[3,4,5,9]` → `3-5, 9`. Input must be ascending and de-duplicated. */
export function lineRanges(lines) {
    const out = [];
    for (let i = 0; i < lines.length;) {
        let j = i;
        while (j + 1 < lines.length && lines[j + 1] === lines[j] + 1)
            j += 1;
        out.push(i === j ? `${lines[i]}` : `${lines[i]}-${lines[j]}`);
        i = j + 1;
    }
    return out.join(', ');
}
