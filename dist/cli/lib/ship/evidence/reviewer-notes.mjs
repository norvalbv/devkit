// The evidence block's Reviewer notes section: PASS reviewers' non-blocking advisories, read from
// this ship's gate events. An append re-ship judged only its delta, so it adds notes, never drops one.
import { homedir } from 'node:os';
import { dirname, sep } from 'node:path';
import { FINDING_SEPARATOR } from '../../../../gate-engine/judge/advisory/emit.mjs';
import { details, plain, sectionBegin, sectionEnd, sectionOf, withSection } from './block.mjs';
const NOTES = 'notes';
const REVIEW_GATE = 'review:';
const AT_SHA = / at `[0-9a-f]+`:/;
/** The home directory as a whole path prefix; a root home would rewrite every absolute path. */
const homePrefix = (home) => dirname(home) === home ? null : `${home}${sep}`;
/** One bullet per finding of the newest attempt's `review:*` advisory rows (an inherited ship id
 * spans several attempts); a row holds one finding per line. */
export function noteLines(events, sha) {
    const opened = events.map((e) => e.type).lastIndexOf('ship_attempt');
    const home = homePrefix(homedir());
    return events.slice(Math.max(opened, 0)).flatMap((e) => {
        const gate = `${e.gate ?? ''}`;
        if (e.type !== 'advisory_result' || !gate.startsWith(REVIEW_GATE))
            return [];
        const reviewer = plain(gate.slice(REVIEW_GATE.length));
        return `${e.detail ?? ''}`.split(FINDING_SEPARATOR).flatMap((finding) => {
            const text = plain(home ? finding.replaceAll(home, `~${sep}`) : finding);
            return text ? [`- **${reviewer}** at \`${sha.slice(0, 12)}\`: ${text}`] : [];
        });
    });
}
/** A cached PASS replays the same advisory under a later commit: one note, the first sha kept. */
const noteKey = (line) => line.replace(AT_SHA, ':');
const bulletsOf = (section) => (section ?? '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith('- '));
/** Add `lines` to the PR's current notes, or replace them on a history rewrite; none is a no-op. */
export function upsertNotes(body, lines, replace) {
    const seen = new Set();
    const merged = [...(replace ? [] : bulletsOf(sectionOf(NOTES, body))), ...lines].filter((line) => !seen.has(noteKey(line)) && Boolean(seen.add(noteKey(line))));
    if (!merged.length)
        return body;
    const count = `${merged.length} non-blocking advisor${merged.length === 1 ? 'y' : 'ies'}`;
    const section = [
        sectionBegin(NOTES),
        ...details(`💬 <b>Reviewer notes</b> · ${count}`, merged),
        sectionEnd(NOTES),
    ].join('\n');
    return withSection(NOTES, body, section);
}
