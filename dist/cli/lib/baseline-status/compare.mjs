/** A PR run's failing tests split into NEW (not failing at the base run) and inherited. */
// Narration only: nothing feeds a verdict. A file lacking names on either side never reads NEW.
import { appendFileSync } from 'node:fs';
/** A file's recorded failed names; empty means the producer recorded none (names unknown). */
function namesOf(map, file) {
    return map && Object.hasOwn(map, file) ? (map[file]?.failed ?? []) : [];
}
/** One entry per named test, or a file-level entry when no names were recorded. */
function entriesFor(file, names) {
    return names.length ? names.map((test) => ({ file, test })) : [{ file }];
}
/** Split `pr`'s failures against the base run that `base` answered from. */
export function compareFailures(pr, base) {
    const baseFailing = new Set(base.failingFiles);
    const result = { fresh: [], inherited: [], fixed: [], namesKnown: true };
    const prFailing = Object.keys(pr.files)
        .filter((file) => pr.files[file] === 'failed')
        .sort();
    for (const file of prFailing) {
        const prNames = namesOf(pr.tests, file);
        if (!baseFailing.has(file)) {
            result.fresh.push(...entriesFor(file, prNames));
            continue;
        }
        const baseNames = namesOf(base.tests, file);
        // A truncated base list cannot prove a name absent, so it compares by file like a missing one.
        const baseTruncated = Object.hasOwn(base.tests ?? {}, file) && base.tests?.[file]?.truncated;
        if (!prNames.length || !baseNames.length || baseTruncated) {
            result.namesKnown = false;
            result.inherited.push({ file });
            continue;
        }
        for (const test of prNames) {
            (baseNames.includes(test) ? result.inherited : result.fresh).push({ file, test });
        }
    }
    result.fixed = base.failingFiles.filter((file) => Object.hasOwn(pr.files, file) && pr.files[file] === 'passed');
    return result;
}
const label = (entry) => entry.test ? `${entry.file} > ${entry.test}` : entry.file;
/** One titled list, or nothing when it is empty. */
function section(title, mark, items) {
    return items.length ? [`${title} (${items.length}):`, ...items.map((i) => `  ${mark} ${i}`)] : [];
}
/** The comparison as log lines, naming the sha that actually answered rather than the one asked. */
export function renderComparison(c, base) {
    const sha = base.sha?.slice(0, 8) ?? 'unknown';
    const behind = base.commitsBehindHead
        ? `, ${base.commitsBehindHead} commit(s) before the PR base`
        : '';
    const lines = [`compared with ${base.ref} @ ${sha} (run ${base.runId}${behind})`];
    if (!c.fresh.length) {
        lines.push(c.inherited.length
            ? `inherited only — every failure here also fails at ${sha}`
            : 'no failing tests in this run');
    }
    lines.push(...section(`NEW — not failing at ${sha}`, '✗', c.fresh.map(label)), ...section(`inherited — also failing at ${sha}`, '·', c.inherited.map(label)), ...section(`fixed here — failing at ${sha}, passing here`, '✓', c.fixed));
    if (!c.namesKnown)
        lines.push('some files compared by file only: a run recorded no test names');
    return lines;
}
/** Append the rendered comparison to the GitHub step summary, when the runner provides one. */
export function writeStepSummary(lines, env = process.env) {
    const path = env.GITHUB_STEP_SUMMARY;
    if (!path)
        return;
    appendFileSync(path, ['### Test failures: new vs inherited', '', '```text', ...lines, '```', ''].join('\n'));
}
