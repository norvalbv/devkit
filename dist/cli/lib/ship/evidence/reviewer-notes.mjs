// The evidence block's Reviewer notes section: PASS reviewers' non-blocking advisories, read from
// this ship's gate events. An append re-ship judged only its delta, so it adds notes, never drops one.
import { homedir } from 'node:os';
import { dirname, sep } from 'node:path';
import { z } from 'zod';
import { FINDING_SEPARATOR } from '../../../../gate-engine/judge/advisory/emit.mjs';
import { LOCATION_RE, outsideCode } from '../../../../gate-engine/review/contracts/response.mjs';
import { commentLine, counted, details, oneLine, plain, readCommentJson, sectionBegin, sectionEnd, sectionOf, withSection, } from './block.mjs';
const NOTES = 'notes';
const REVIEW_GATE = 'review:';
// Every note as data, so a re-ship re-renders each commit's round instead of re-parsing markdown.
const DATA_OPEN = `<!-- devkit:evidence:${NOTES}:data `;
const SHORT = 12;
const FULL_SHA = /^[0-9a-f]{40}$/;
// A home, absolute or parent-relative path names no file in the repository's blob tree.
const OUTSIDE_REPO = /^[~/]|(?:^|\/)\.\.\//;
// The advisory contract's `<file:line> — <finding>` opening, through emphasis or one code span.
const LEADING_LOCATION = new RegExp(String.raw `^[\s*]*(\x60?)(~?)${LOCATION_RE.source}(?::\d+)?(?:-(\d+))?\1[*]*\s*(?:[—–:-]+\s*)?`, 'i');
const noteSchema = z.strictObject({ reviewer: z.string(), sha: z.string(), text: z.string() });
/** The home directory as a whole path prefix; a root home would rewrite every absolute path. */
const homePrefix = (home) => dirname(home) === home ? null : `${home}${sep}`;
/** One note per finding of the newest attempt's `review:*` advisory rows (an inherited ship id
 * spans several attempts); a row holds one finding per line. */
export function reviewerNotes(events, sha) {
    const opened = events.map((e) => e.type).lastIndexOf('ship_attempt');
    const home = homePrefix(homedir());
    return events.slice(Math.max(opened, 0)).flatMap((e) => {
        const gate = `${e.gate ?? ''}`;
        if (e.type !== 'advisory_result' || !gate.startsWith(REVIEW_GATE))
            return [];
        const reviewer = oneLine(gate.slice(REVIEW_GATE.length));
        return `${e.detail ?? ''}`.split(FINDING_SEPARATOR).flatMap((finding) => {
            const text = oneLine(home ? finding.replaceAll(home, `~${sep}`) : finding);
            return text ? [{ reviewer, sha, text }] : [];
        });
    });
}
function place(note) {
    const m = LEADING_LOCATION.exec(note.text);
    const finding = m ? note.text.slice(m[0].length) : '';
    return m && finding
        ? { note, file: `${m[2]}${m[3]}`, from: Number(m[4]), to: m[5], finding }
        : { note, file: null, from: 0, to: undefined, finding: note.text };
}
/** `<` escaped in prose so no tag opens, but raw in code, where an entity would print literally. */
const markdown = (text) => outsideCode(text, (prose) => prose.replaceAll('<', '&lt;'));
const said = (p) => `${markdown(p.finding)} · <sub>${plain(p.note.reviewer.replace(/-reviewer\b/, ''))}</sub>`;
/** `L12` or `L12-14`, linked to the reviewed commit when the path is the repository's own. */
function where(repo, p) {
    const label = `L${p.from}${p.to ? `-${p.to}` : ''}`;
    if (!p.file || OUTSIDE_REPO.test(p.file) || !FULL_SHA.test(p.note.sha))
        return label;
    const anchor = `#L${p.from}${p.to ? `-L${p.to}` : ''}`;
    return `[${label}](https://github.com/${repo}/blob/${p.note.sha}/${encodeURI(p.file)}${anchor})`;
}
/** One bullet per cited line, in line order; notes citing the same line share its bullet. */
function lineItems(repo, placed) {
    const lines = new Map();
    for (const p of [...placed].sort((a, b) => a.from - b.from)) {
        const key = p.file ? `${p.from}-${p.to}` : p;
        lines.set(key, [...(lines.get(key) ?? []), p]);
    }
    return [...lines.values()].flatMap(([first, ...rest]) => {
        if (!first.file)
            return [`- ${said(first)}`];
        if (!rest.length)
            return [`- ${where(repo, first)} — ${said(first)}`];
        return [`- ${where(repo, first)}`, ...[first, ...rest].map((p) => `  - ${said(p)}`)];
    });
}
/** One commit's notes grouped under the file each cites, with the uncited ones last. */
function roundLines(repo, notes) {
    const files = new Map();
    for (const p of notes.map(place))
        files.set(p.file ?? '', [...(files.get(p.file ?? '') ?? []), p]);
    return [...files.keys()]
        .sort((a, b) => Number(!a) - Number(!b))
        .flatMap((file) => [
        file ? `\`${file}\`` : 'Not tied to a line',
        ...lineItems(repo, files.get(file) ?? []),
        '',
    ]);
}
const commit = (sha) => `<code>${plain(sha.slice(0, SHORT))}</code>`;
/** The newest commit's notes open, each earlier commit's collapsed beneath them. */
function section(repo, notes) {
    const rounds = new Map();
    for (const n of notes)
        rounds.set(n.sha, [...(rounds.get(n.sha) ?? []), n]);
    const [[sha, newest], ...earlier] = [...rounds].reverse();
    const older = notes.length - newest.length;
    const summary = `💬 <b>Reviewer notes</b> · ${counted(newest.length, 'note')} at ${commit(sha)}` +
        (older ? ` · ${older} at earlier commits` : '');
    const body = [
        ...roundLines(repo, newest),
        ...earlier.flatMap(([at, round]) => details(`${counted(round.length, 'note')} at earlier commit ${commit(at)}`, roundLines(repo, round))),
    ];
    return [
        sectionBegin(NOTES),
        ...details(summary, body),
        commentLine(DATA_OPEN, notes),
        sectionEnd(NOTES),
    ].join('\n');
}
const storedNotes = z.array(noteSchema);
const key = (n) => `${n.reviewer}\n${n.text}`;
/** Add `notes` to the PR's current ones, or replace them on a history rewrite; none is a no-op. A
 * note raised again, as a cached PASS replays it, moves to the newer commit, where it still holds. */
export function upsertNotes(body, notes, replace, repo) {
    if (!notes.length)
        return body;
    const stored = readCommentJson(sectionOf(NOTES, body), DATA_OPEN, storedNotes);
    const all = [...(replace ? [] : (stored ?? [])), ...notes];
    const last = new Map(all.map((n, at) => [key(n), at]));
    const merged = all.filter((n, at) => last.get(key(n)) === at);
    return withSection(NOTES, body, section(repo, merged));
}
