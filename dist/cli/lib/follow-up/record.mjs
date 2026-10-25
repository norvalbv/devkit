/**
 * Follow-up records: the description lines a follow-up story carries, and the pure decision of
 * which follow-up `devkit follow-up start` may assign. The tracker is only where the lines live.
 */
/** Title prefix older versions of `start` wrote; only deduplication still strips it. */
const LEGACY_START_PREFIX = '[auto-start]';
export const FOLLOW_UP_TYPES = ['blocks-done', 'builds-on', 'discovery'];
const PR_URL = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/;
const WHOLE_PR_URL = new RegExp(`^${PR_URL.source}$`);
/** Any record label. Readers take the first match anywhere, so free text must never carry one. */
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
/** A title compared for duplicates: case, spacing and the legacy start marker do not make it new. */
export function normalisedTitle(name) {
    const unmarked = name.startsWith(LEGACY_START_PREFIX)
        ? name.slice(LEGACY_START_PREFIX.length)
        : name;
    return unmarked.replace(/\s+/g, ' ').trim().toLowerCase();
}
/** Depth is capped at one hop: a story that is itself a follow-up never starts follow-ups. */
export function isDepthCapped(story) {
    return parseRecord(story.description) !== null;
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
/** Open follow-ups holding the parent's feature back: any type but discovery, untyped included. */
export function openFollowUps(parentId, children, excludeId) {
    return children.flatMap((child) => {
        const record = parseRecord(child.description);
        if (record?.parent !== parentId || child.closed || child.id === excludeId)
            return [];
        return record.type === 'discovery' ? [] : [{ id: child.id, type: record.type }];
    });
}
/**
 * A non-discovery follow-up that is owned or completed means one already started, by `start`, a
 * consumer's agent or a human, so a rerun assigns nothing. An archived, uncompleted one is ignored.
 */
export function decideStart(parentId, children) {
    const ofParent = children.filter((child) => parseRecord(child.description)?.parent === parentId);
    const started = ofParent.find((child) => parseRecord(child.description)?.type !== 'discovery' &&
        ((child.ownerIds.length > 0 && !child.closed) || child.completed));
    if (started)
        return { action: 'none', reason: `sc-${started.id} was already started` };
    const fresh = ofParent
        .filter((child) => ineligibleReason(child, parentId) === null)
        .sort((a, b) => a.id - b.id)[0];
    return fresh
        ? { action: 'assign', story: fresh }
        : { action: 'none', reason: 'no unowned builds-on follow-up qualifies' };
}
