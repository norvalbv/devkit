import { details, sectionBegin, sectionEnd, sectionOf, withSection } from './block.mjs';
export const QA_BEGIN = sectionBegin('qa');
export const QA_END = sectionEnd('qa');
const ATTACHMENT = /https:\/\/github\.com\/user-attachments\/assets\/[A-Za-z0-9-]+/;
const SHA_CELL = /· sha `([0-9a-f]{12})` ·/;
const MB = 1024 * 1024;
/** GitHub's free-plan video limit is 10 MB and its image limit 10 MB; the margin covers rounding. */
export const VIDEO_CAP = 9 * MB;
const IMAGE_CAP = 10 * MB;
/** Two flows of seven steps each: both videos and every still. */
const MAX_FILES = 16;
const MAX_SHOTS = 4;
export const shortSha = (entry) => entry.sha256.slice(0, 12);
const megabytes = (bytes) => (bytes / MB).toFixed(1);
/** The flows behind `entries` (in order) that `why` rules out, each with its first reason. */
function ruledOut(entries, why) {
    const out = new Map();
    for (const entry of entries) {
        const reason = entry.passed ? why(entry) : 'the flow failed';
        if (reason && !out.has(entry.flow))
            out.set(entry.flow, reason);
    }
    return out;
}
function sizeNote(entry) {
    const cap = entry.kind === 'video' ? VIDEO_CAP : IMAGE_CAP;
    return entry.bytes > cap
        ? `${megabytes(entry.bytes)} MB is over the ${megabytes(cap)} MB limit`
        : null;
}
/** One flow's apt stills: every one its video's run took, or, with no video, the first 4. */
const flowStills = (flow) => {
    const stills = flow.filter((entry) => entry.kind === 'screenshot');
    return flow.some((entry) => entry.kind === 'video') ? stills : stills.slice(0, MAX_SHOTS);
};
/** Round-robin, so the file limit trims every flow's stills evenly instead of dropping a flow's. */
const interleave = (lists) => lists
    .flatMap((list, at) => list.map((item, turn) => ({ item, turn, at })))
    .sort((a, b) => a.turn - b.turn || a.at - b.at)
    .map(({ item }) => item);
/** The apt set: each eligible flow's video and stills, videos first so the file limit never costs a
 * flow its video. A failed or ineligible flow is never uploaded; a UI change with none says so. */
export function planMedia(entries, why, uiReason) {
    const out = ruledOut(entries, why);
    const notes = [...out].map(([flow, reason]) => `\`${flow}\`: not uploaded, ${reason}`);
    const usable = entries.filter((entry) => !out.has(entry.flow));
    const flows = [...new Set(usable.map((entry) => entry.flow))];
    const perFlow = flows.map((flow) => usable.filter((entry) => entry.flow === flow));
    const videos = perFlow.flatMap((flow) => flow.filter((entry) => entry.kind === 'video'));
    const wanted = [...videos, ...interleave(perFlow.map(flowStills))];
    const fits = wanted.filter((entry) => sizeNote(entry) === null);
    for (const entry of wanted.filter((e) => sizeNote(e) !== null))
        notes.push(`\`${entry.file}\`: not uploaded, ${sizeNote(entry)}`);
    for (const entry of fits.slice(MAX_FILES))
        notes.push(`\`${entry.file}\`: not uploaded, over ${MAX_FILES} files`);
    if (fits.length === 0 && entries.length === 0 && uiReason)
        notes.push(`UI changed (${uiReason}); no QA capture recorded: run \`devkit machine up\`, \`devkit machine run <flow>\`, then \`devkit machine attach <this PR>\``);
    // Shown flow by flow: a stable sort keeps each flow's video ahead of its stills.
    const picks = fits
        .slice(0, MAX_FILES)
        .sort((a, b) => flows.indexOf(a.flow) - flows.indexOf(b.flow));
    return { picks, notes };
}
function provenanceLine(entry) {
    const head = `HEAD \`${entry.sourceHead.slice(0, 12)}\`${entry.dirty ? ' + uncommitted changes' : ''}`;
    const size = `${Math.max(1, Math.round(entry.bytes / 1024))} KB`;
    return `**${entry.flow}** · ${entry.kind} · ${size} · sha \`${shortSha(entry)}\` · ran the code this PR ships · ${head} · flow passed`;
}
/** An uploaded video is a bare URL on its own line, the form gh writes and GitHub plays inline; an
 * image, or a file gh has yet to upload, is markdown image syntax gh can rewrite in place. */
const mediaLine = (entry, ref) => entry.kind === 'video' && ATTACHMENT.test(ref) ? ref : `![${entry.flow} ${entry.kind}](${ref})`;
/** The section; `refs` maps a short sha to its uploaded URL, or to the local path gh will upload. */
export function renderQaSection(plan, refs) {
    const shown = plan.picks.filter((entry) => refs.has(shortSha(entry)));
    const media = shown.flatMap((entry) => [
        provenanceLine(entry),
        '',
        mediaLine(entry, refs.get(shortSha(entry)) ?? ''),
        '',
    ]);
    return [
        QA_BEGIN,
        ...details(qaSummary(shown), [
            ...media,
            ...plan.notes.map((note) => `- ${note}`),
            ...(plan.notes.length ? [''] : []),
            "<sub>Recorded by `devkit machine run` on the agent's own machine: a captured run, not proof of causality.</sub>",
        ]),
        QA_END,
    ].join('\n');
}
/** The section's collapsed line: what it attached, or that it attached nothing (its notes say why). */
function qaSummary(shown) {
    if (!shown.length)
        return '⚠️ <b>QA capture</b> · nothing attached';
    const flows = new Set(shown.map((entry) => entry.flow)).size;
    const kinds = [...new Set(shown.map((entry) => entry.kind))].join(' + ');
    return `🎬 <b>QA capture</b> · ${flows} flow${flows === 1 ? '' : 's'} passed · ${kinds}`;
}
export const qaSectionOf = (body) => sectionOf('qa', body);
/** Every uploaded capture in `body`, by short sha: the line after a sha cell is its media line. */
export function uploadedMedia(body) {
    const lines = (qaSectionOf(body) ?? '').split('\n');
    const found = new Map();
    lines.forEach((line, index) => {
        const sha = SHA_CELL.exec(line)?.[1];
        const media = lines.slice(index + 1).find((next) => next.trim() !== '');
        const url = media ? ATTACHMENT.exec(media)?.[0] : undefined;
        if (sha && url)
            found.set(sha, url);
    });
    return found;
}
export const withQaSection = (body, section) => withSection('qa', body, section);
