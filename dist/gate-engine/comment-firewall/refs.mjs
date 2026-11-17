const WHITESPACE = /\s+/g;
const squash = (text) => text.replace(WHITESPACE, ' ').trim();
function matches(fragment, refs) {
    const found = new Set();
    for (const ref of refs)
        for (const match of fragment.matchAll(ref))
            found.add(match[0]);
    return [...found];
}
/** A removed comment fragment with identical text (up to whitespace) excuses one added fragment: a
 * code-only edit keeps its trailing reference, while a reworded, shortened or pasted one blocks. */
function excused(fragment, run, head, used) {
    const needle = squash(fragment);
    for (const line of run?.removed ?? []) {
        const index = (head.get(line) ?? []).findIndex((old, i) => !used.has(`${line}:${i}`) && squash(old) === needle);
        if (index < 0)
            continue;
        used.add(`${line}:${index}`);
        return true;
    }
    return false;
}
export function refFindings(change, refs) {
    if (refs.length === 0)
        return [];
    const added = new Set(change.hunks.flatMap((hunk) => [...hunk.addedLines]));
    const runs = change.hunks.flatMap((hunk) => hunk.runs);
    const used = new Set();
    const findings = [];
    for (const token of change.tokens) {
        token.text.split('\n').forEach((fragment, offset) => {
            const line = token.startLine + offset;
            if (!added.has(line))
                return;
            const cited = matches(fragment, refs);
            if (cited.length === 0)
                return;
            const run = runs.find((candidate) => candidate.added.has(line));
            if (excused(fragment, run, change.headFragments, used))
                return;
            const comment = squash(fragment).slice(0, 140);
            findings.push({ path: change.file, line, refs: cited, comment });
        });
    }
    return findings;
}
