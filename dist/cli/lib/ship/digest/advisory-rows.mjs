// The digest keeps one advisory row per gate so advisories never crowd out findings. A gate holding
// several must therefore name every location it cites up front, ahead of the one-line cut.
import { issueLocations } from '../../../../gate-engine/review/contracts/response.mjs';
import { oneLine } from './fields.mjs';
/** A cached lens part reports as `<reviewer> [<group>]`; its findings belong to the reviewer. */
const LENS_SUFFIX = / \[[^\]]*\]$/;
/** One row per state+reviewer gate, counting distinct whole details; a lone one renders as before. */
export function groupAdvisories(rows) {
    const groups = new Map();
    for (const r of rows) {
        const gate = r.gate.replace(LENS_SUFFIX, '');
        const group = groups.get(`${r.state}:${gate}`) ?? [];
        // Exact repeats are one finding: pre-commit and commit-msg can both replay one cached PASS.
        if (!group.some((g) => g.detail === r.detail))
            group.push({ ...r, gate });
        groups.set(`${r.state}:${gate}`, group);
    }
    return [...groups.values()].map(merged);
}
function merged(group) {
    const [first] = group;
    if (group.length === 1)
        return { ...first, detail: oneLine(first.detail) };
    const at = citedLocations(group.map((r) => r.detail));
    const detail = `${group.length} advisories${at ? ` at ${at}` : ''} — ${first.detail}`;
    return { ...first, findings: group.length, detail: oneLine(detail) };
}
/** Each cited file once, with its distinct lines in order: `a.ts:3,9; b.ts:1`. */
function citedLocations(details) {
    const byFile = new Map();
    for (const { file, line } of details.flatMap(issueLocations)) {
        const lines = byFile.get(file) ?? [];
        if (!lines.includes(line))
            lines.push(line);
        byFile.set(file, lines);
    }
    return [...byFile].map(([file, lines]) => `${file}:${lines.join(',')}`).join('; ');
}
