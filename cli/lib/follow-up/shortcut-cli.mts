/**
 * Shortcut through the machine's `short` CLI: devkit holds no token, so whoever ran
 * `short install` on this machine is the credential.
 */
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import type { StoryView } from './record.mts';

/** Runs `short` with these arguments and returns its stdout. */
export type RunShort = (args: readonly string[]) => string;

export const runShort: RunShort = (args) =>
  execFileSync('short', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const STORY = z.object({
  id: z.number(),
  group_id: z.string().nullish(),
  workflow_id: z.number(),
  name: z.string(),
  description: z.string(),
  owner_ids: z.array(z.string()),
  completed: z.boolean(),
  archived: z.boolean(),
  story_links: z.array(
    z.object({
      type: z.enum(['subject', 'object']),
      subject_id: z.number(),
      object_id: z.number(),
    }),
  ),
});

/** A story as read from Shortcut: the decision's view plus where new follow-ups of it are filed. */
export interface TrackerStory extends StoryView {
  archived: boolean;
  teamId: string | null;
  workflowId: number;
}

export function readStory(run: RunShort, id: number): TrackerStory {
  const story = STORY.parse(JSON.parse(run(['api', `/stories/${id}`])));
  const linked = story.story_links.map((link) =>
    link.type === 'subject' ? link.object_id : link.subject_id,
  );
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
export function defaultStateId(run: RunShort, workflowId: number): number {
  const workflow = z.object({ default_state_id: z.number() });
  return workflow.parse(JSON.parse(run(['api', `/workflows/${workflowId}`]))).default_state_id;
}

export interface NewStory {
  name: string;
  description: string;
  storyType: 'feature' | 'bug' | 'chore';
  stateId: number;
  teamId: string | null;
}

/** Files an unowned story and returns its id. `short create` hides API errors; `short api` exits 1. */
export function createStory(run: RunShort, story: NewStory): number {
  const fields = [
    `name=${story.name}`,
    `description=${story.description}`,
    `story_type=${story.storyType}`,
    `workflow_state_id=${story.stateId}`,
  ];
  if (story.teamId) fields.push(`group_id=${story.teamId}`);
  const out = run(['api', '/stories', '-X', 'POST', ...fields.flatMap((field) => ['-f', field])]);
  return z.object({ id: z.number() }).parse(JSON.parse(out)).id;
}

export function linkStories(run: RunShort, subjectId: number, objectId: number): void {
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

export function archiveStory(run: RunShort, id: number): void {
  run(['story', String(id), '-q', '-a']);
}

/** Adding an owner is what a story-assigned trigger fires on. */
export function assignStory(run: RunShort, id: number, ownerId: string): void {
  run(['story', String(id), '-q', '-o', ownerId]);
}
