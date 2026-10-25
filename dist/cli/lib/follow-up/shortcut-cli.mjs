/**
 * Shortcut through the machine's `short` CLI: devkit holds no token, so whoever ran
 * `short install` on this machine is the credential.
 */
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
export const runShort = (args) => execFileSync('short', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const STORY = z.object({
    id: z.number(),
    group_id: z.string().nullish(),
    workflow_id: z.number(),
    name: z.string(),
    description: z.string(),
    owner_ids: z.array(z.string()),
    completed: z.boolean(),
    archived: z.boolean(),
    story_links: z.array(z.object({
        type: z.enum(['subject', 'object']),
        subject_id: z.number(),
        object_id: z.number(),
    })),
});
export function readStory(run, id) {
    const story = STORY.parse(JSON.parse(run(['api', `/stories/${id}`])));
    const linked = story.story_links.map((link) => link.type === 'subject' ? link.object_id : link.subject_id);
    return {
        id: story.id,
        name: story.name,
        description: story.description,
        ownerIds: story.owner_ids,
        closed: story.completed || story.archived,
        completed: story.completed,
        linkedIds: [...new Set(linked)],
        archived: story.archived,
        teamId: story.group_id ?? null,
        workflowId: story.workflow_id,
    };
}
/** The state a workflow puts new stories in. */
export function defaultStateId(run, workflowId) {
    const workflow = z.object({ default_state_id: z.number() });
    return workflow.parse(JSON.parse(run(['api', `/workflows/${workflowId}`]))).default_state_id;
}
/** Files an unowned story and returns its id. `short create` hides API errors; `short api` exits 1. */
export function createStory(run, story) {
    const fields = [
        `name=${story.name}`,
        `description=${story.description}`,
        `story_type=${story.storyType}`,
        `workflow_state_id=${story.stateId}`,
    ];
    if (story.teamId)
        fields.push(`group_id=${story.teamId}`);
    const out = run(['api', '/stories', '-X', 'POST', ...fields.flatMap((field) => ['-f', field])]);
    return z.object({ id: z.number() }).parse(JSON.parse(out)).id;
}
export function linkStories(run, subjectId, objectId) {
    run([
        'api',
        '/story-links',
        '-X',
        'POST',
        '-f',
        `subject_id=${subjectId}`,
        '-f',
        `object_id=${objectId}`,
        '-f',
        'verb=relates to',
    ]);
}
export function archiveStory(run, id) {
    run(['story', String(id), '-q', '-a']);
}
/** Adding an owner is what a story-assigned trigger fires on. */
export function assignStory(run, id, ownerId) {
    run(['story', String(id), '-q', '-o', ownerId]);
}
