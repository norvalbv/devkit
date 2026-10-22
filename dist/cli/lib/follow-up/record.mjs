/**
 * Follow-up records: the description lines a follow-up story carries, and the pure decision of
 * which follow-up `devkit follow-up start` may assign. The tracker is only where the lines live.
 */
/** Title prefix on a follow-up devkit started; the queue that runs it reads it to prioritise. */
export const AUTO_START_PREFIX = '[auto-start]';
export const FOLLOW_UP_TYPES = ['blocks-done', 'builds-on', 'discovery'];
const PR_URL = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/;
const WHOLE_PR_URL = new RegExp(`^${PR_URL.source}$`);
/** Any record label; readers take the first match, so free text must never carry one. */
export const RECORD_LABEL = /\*\*(Project|Follow-up of|Follow-up type|Stack on):\*\*/;
export function isPrUrl(value) {
    return WHOLE_PR_URL.test(value);
}
function lineValue(description, label) {
    const match = description.match(new RegExp(`^\\*\\*${label}:\\*\\*[ \\t]*(.+)$`, 'm'));
    return match ? match[1].trim() : null;
}
function asFollowUpType(value) {
    return FOLLOW_UP_TYPES.find((type) => type === value) ?? null;
}
/** The record a story's description carries, or null when it is not a follow-up. */
export function parseRecord(description) {
    const of = lineValue(description, 'Follow-up of');
    const parent = of?.match(/^sc-(\d+)/);
    if (!of || !parent)
        return null;
    return {
        parent: Number(parent[1]),
        prUrl: of.match(PR_URL)?.[0] ?? null,
        type: asFollowUpType(lineValue(description, 'Follow-up type')),
        stackOn: lineValue(description, 'Stack on')?.match(PR_URL)?.[0] ?? null,
    };
}
/**
 * The lines `parseRecord` reads back. Stack on names the PR whose branch a blocks-done or builds-on
 * item starts from.
 */
export function renderRecord(project, parent, type, prUrl) {
    const lines = [
        `**Project:** ${project}`,
        `**Follow-up of:** sc-${parent}${prUrl ? ` · ${prUrl}` : ''}`,
        `**Follow-up type:** ${type}`,
    ];
    if (prUrl && type !== 'discovery')
        lines.push(`**Stack on:** ${prUrl}`);
    return lines.join('\n');
}
/** A title compared for duplicates: case, spacing and the start marker do not make it new. */
export function normalisedTitle(name) {
    const unmarked = name.startsWith(AUTO_START_PREFIX) ? name.slice(AUTO_START_PREFIX.length) : name;
    return unmarked.replace(/\s+/g, ' ').trim().toLowerCase();
}
/** Depth is capped at one hop: a story that is itself a follow-up never starts follow-ups. */
export function isDepthCapped(story) {
    return story.name.startsWith(AUTO_START_PREFIX) || parseRecord(story.description) !== null;
}
/** Why a linked story may not be auto-started, or null when it qualifies. */
export function ineligibleReason(child, parentId) {
    const record = parseRecord(child.description);
    if (record?.parent !== parentId)
        return 'not a follow-up of this story';
    if (record.type !== 'builds-on')
        return `${record.type ?? 'untyped'} follow-ups wait for a human`;
    if (child.closed)
        return 'done or archived';
    if (record.prUrl && record.stackOn !== record.prUrl)
        return 'no Stack on line for the parent PR';
    return null;
}
/**
 * At most one follow-up per parent ever starts, so a marked follow-up that is assigned or closed
 * ends it. An open, unassigned marked one (an earlier assign failed) is resumed before a new pick.
 */
export function decideStart(parentId, children) {
    const ofParent = children.filter((child) => parseRecord(child.description)?.parent === parentId);
    const started = ofParent.find((child) => child.name.startsWith(AUTO_START_PREFIX) && (child.ownerIds.length > 0 || child.closed));
    if (started)
        return { action: 'none', reason: `sc-${started.id} was already started` };
    const eligible = ofParent
        .filter((child) => ineligibleReason(child, parentId) === null)
        .sort((a, b) => a.id - b.id);
    const marked = eligible.find((child) => child.name.startsWith(AUTO_START_PREFIX));
    if (marked)
        return { action: 'assign', story: marked, rename: false };
    const fresh = eligible.find((child) => child.ownerIds.length === 0);
    return fresh
        ? { action: 'assign', story: fresh, rename: true }
        : { action: 'none', reason: 'no unowned builds-on follow-up qualifies' };
}
