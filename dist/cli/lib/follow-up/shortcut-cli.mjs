/**
 * Shortcut through the machine's `short` CLI: devkit holds no token, so whoever ran
 * `short install` on this machine is the credential.
 */
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
export const runShort = (args) => execFileSync('short', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const STORY = z.object({
    id: z.number(),
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
        linkedIds: [...new Set(linked)],
    };
}
export function renameStory(run, id, name) {
    run(['story', String(id), '-q', '-t', name]);
}
/** Adding an owner is what a story-assigned trigger fires on. */
export function assignStory(run, id, ownerId) {
    run(['story', String(id), '-q', '-o', ownerId]);
}
