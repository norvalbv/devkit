/** `devkit follow-up`: file the follow-ups a story deferred, start one, and list the open ones. */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
  decideStart,
  FOLLOW_UP_TYPES,
  isDepthCapped,
  isPrUrl,
  normalisedTitle,
  type OpenFollowUp,
  openFollowUps,
  parseRecord,
  RECORD_LABEL,
  renderRecord,
} from '../../lib/follow-up/record.mts';
import {
  archiveStory,
  assignStory,
  createStory,
  defaultStateId,
  linkStories,
  readStory,
  type RunShort,
  runShort,
  type TrackerStory,
} from '../../lib/follow-up/shortcut-cli.mts';
import { errorMessage } from '../../lib/ship/review/shared/common.mts';

const USAGE = `Usage:
  devkit follow-up file --parent <story> [--pr <url>]   < items.json
  devkit follow-up start --parent <story> [--owner <member>]
  devkit follow-up status --parent <story>`;

export const meta = {
  name: 'follow-up',
  agentFacing: false,
  notRoutedBecause:
    "Called by a Flow's closing steps after a story ships: frink-work's Track Follow-ups agent pipes " +
    'the deferred items into `file` and `status` answers its Feature done line; its Start Follow-up ' +
    'node then runs `start`. `start` queues paid agent work and narrows the human gate on ' +
    'follow-ups, so it is not routed to agents by hand.',
  summary:
    'File the follow-ups a story deferred, start one builds-on follow-up of it, or list the open ones.',
  help: `devkit follow-up — file the follow-ups a story deferred, start one, and list the open ones.

${USAGE}

  --parent <story>   The story the follow-ups come from (7315 or sc-7315). status: the story whose
                     PR this is, which may itself be a follow-up.
  --pr <url>         file: the parent's pull request. Without it the record names no PR.
  --owner <member>   start: who to assign to. Default: the parent's first owner.

file reads a JSON array on stdin, one object per deferred item:
  {"title": "...", "followUpType": "builds-on", "storyType": "feature", "project": "devkit", "body": "..."}

  followUpType  blocks-done: work the parent needs that its own PR could not build (an owner
                decision, another repo, or overflow). builds-on: the parent is complete and this
                extends it. discovery: code the parent's PR did not touch.
  storyType     bug for a defect that still exists, otherwise feature or chore.
  project       The name of the repo that owns this fix, which can differ from the parent's.
  body          The problem, why it was deferred, the files involved, and acceptance criteria.
                It must not contain a record line such as **Stack on:**.

Every item is validated before anything is written. Each story is filed unowned, in the parent's
team and its workflow's default state, then linked "relates to" the parent. Its description is the
body, then a blank line, then this footer:
  **Project:** <project>
  **Follow-up of:** sc-<parent> · <pr url>
  **Follow-up type:** <followUpType>
  **Stack on:** <pr url>          (blocks-done and builds-on, with --pr only)
An item whose title matches a follow-up already linked to the parent is reported, not filed again,
so running it again after a run ends is safe. A story that cannot be linked is archived. Prints
one JSON line, also when filing stops early:
  {"followups":[{"id":7555,"status":"new","type":"builds-on"}]}

start assigns the lowest-id builds-on follow-up of the parent that is open, unowned and carries
**Stack on:** with the parent's PR when it had one; assigning fires a story-assigned trigger. Nothing
starts when the parent is itself a follow-up (it carries **Follow-up of:**), or once any follow-up of
it other than a discovery is owned or completed. Titles are never changed. Prints
{"started":true,"story":<id>} or {"started":false,"reason":"..."}.

status lists the open follow-ups that hold the story's feature back: blocks-done, builds-on and
untyped ones (type null) that are neither done nor archived; discovery ones never count. When the
story is itself a follow-up, its parent's other open follow-ups count too. Writes nothing. Prints
  {"open":[{"id":7801,"type":"blocks-done"}],"featureDone":false}

Exits 1 on bad input, or when Shortcut cannot be read or written.`,
  valueFlags: ['--parent', '--owner', '--pr'],
};

export interface StartResult {
  started: boolean;
  story?: number;
  reason?: string;
}

export function startFollowUp(
  parentId: number,
  owner: string | undefined,
  run: RunShort = runShort,
): StartResult {
  const parent = readStory(run, parentId);
  if (isDepthCapped(parent)) {
    return { started: false, reason: 'depth cap: this story is itself a follow-up' };
  }
  const children = parent.linkedIds.map((id) => readStory(run, id));
  const decision = decideStart(parentId, children);
  if (decision.action === 'none') return { started: false, reason: decision.reason };
  const assignee = owner ?? parent.ownerIds[0];
  if (!assignee)
    throw new Error(`sc-${parentId} has no owner to give its follow-up to; pass --owner`);
  assignStory(run, decision.story.id, assignee);
  return { started: true, story: decision.story.id };
}

export interface StatusResult {
  open: OpenFollowUp[];
  featureDone: boolean;
}

/** Open follow-ups of the story and, when it is itself a follow-up, its parent's other open ones. */
export function followUpStatus(storyId: number, run: RunShort = runShort): StatusResult {
  const story = readStory(run, storyId);
  const children = story.linkedIds.map((id) => readStory(run, id));
  const open = openFollowUps(storyId, children);
  const parentId = parseRecord(story.description)?.parent;
  if (parentId !== undefined && parentId !== storyId) {
    const parent = children.find((child) => child.id === parentId) ?? readStory(run, parentId);
    const siblings = parent.linkedIds.map((id) => readStory(run, id));
    open.push(...openFollowUps(parentId, siblings, storyId));
  }
  open.sort((a, b) => a.id - b.id);
  return { open, featureDone: open.length === 0 };
}

const ONE_LINE = /^[^\r\n\u2028\u2029]*$/;

const ITEM = z.object({
  title: z.string().trim().min(1).max(512).regex(ONE_LINE, 'must be one line'),
  followUpType: z.enum(FOLLOW_UP_TYPES),
  storyType: z.enum(['feature', 'bug', 'chore']),
  project: z
    .string()
    .trim()
    .regex(/^[\w.-]+$/, 'must be a repo name'),
  body: z.string().refine((body) => !RECORD_LABEL.test(body), 'must not contain a record line'),
});
const ITEMS = z.array(ITEM).min(1);
export type FollowUpItem = z.infer<typeof ITEM>;

export interface FiledFollowUp {
  id: number;
  status: 'new' | 'existing';
  type: string;
}

/** What was filed, and why filing stopped early when it did. */
export interface FileResult {
  followups: FiledFollowUp[];
  error?: string;
}

/** Follow-ups already linked to the parent, by normalised title. */
function linkedFollowUps(parent: TrackerStory, run: RunShort): Map<string, FiledFollowUp> {
  const known = new Map<string, FiledFollowUp>();
  for (const id of parent.linkedIds) {
    const child = readStory(run, id);
    const record = parseRecord(child.description);
    if (child.archived || record?.parent !== parent.id) continue;
    known.set(normalisedTitle(child.name), { id, status: 'existing', type: record.type ?? '' });
  }
  return known;
}

/** A story that cannot be linked is archived, so a rerun files it afresh instead of twice. */
function linkOrArchive(run: RunShort, id: number, parentId: number): void {
  try {
    linkStories(run, id, parentId);
  } catch (linkError) {
    const failure = `linking sc-${id} to sc-${parentId} failed: ${errorMessage(linkError)}`;
    try {
      archiveStory(run, id);
    } catch (archiveError) {
      throw new Error(
        `${failure}; archiving it failed too (${errorMessage(archiveError)}), so archive sc-${id} by hand before rerunning`,
      );
    }
    throw new Error(`${failure}, so sc-${id} was archived`);
  }
}

function fileOne(
  run: RunShort,
  parent: TrackerStory,
  stateId: number,
  prUrl: string | null,
  item: FollowUpItem,
): FiledFollowUp {
  const record = renderRecord(item.project, parent.id, item.followUpType, prUrl);
  const id = createStory(run, {
    name: item.title,
    description: [item.body.trimEnd(), record].filter(Boolean).join('\n\n'),
    storyType: item.storyType,
    stateId,
    teamId: parent.teamId,
  });
  linkOrArchive(run, id, parent.id);
  return { id, status: 'new', type: item.followUpType };
}

/** Files each item not already linked to the parent; stops at the first failure, keeping the rest. */
export function fileFollowUps(
  parentId: number,
  prUrl: string | null,
  items: readonly FollowUpItem[],
  run: RunShort = runShort,
): FileResult {
  const parent = readStory(run, parentId);
  const known = linkedFollowUps(parent, run);
  const stateId = defaultStateId(run, parent.workflowId);
  const followups: FiledFollowUp[] = [];
  for (const [index, item] of items.entries()) {
    const key = normalisedTitle(item.title);
    let entry = known.get(key);
    if (!entry) {
      try {
        entry = fileOne(run, parent, stateId, prUrl, item);
      } catch (error) {
        return { followups, error: `${errorMessage(error)} (${items.length - index} not filed)` };
      }
      known.set(key, entry);
    }
    if (!followups.includes(entry)) followups.push(entry);
  }
  return { followups };
}

function fileCommand(parentId: number, pr: string | undefined, input: string, run: RunShort) {
  if (pr !== undefined && !isPrUrl(pr)) {
    console.error(`devkit follow-up file: --pr must be a pull request URL, got "${pr}"`);
    return 1;
  }
  const items = ITEMS.safeParse(JSON.parse(input));
  if (!items.success) {
    console.error(`devkit follow-up file: nothing filed.\n${z.prettifyError(items.error)}`);
    return 1;
  }
  const { followups, error } = fileFollowUps(parentId, pr ?? null, items.data, run);
  console.log(JSON.stringify({ followups }));
  if (!error) return 0;
  console.error(`devkit follow-up file: ${error}`);
  return 1;
}

const OPTIONS = {
  parent: { type: 'string' },
  owner: { type: 'string' },
  pr: { type: 'string' },
} as const;

/** Strict, so a flag left without a value fails instead of swallowing the next flag. */
function strictArgs(args: string[]) {
  try {
    return parseArgs({ args, options: OPTIONS, allowPositionals: true, strict: true });
  } catch {
    return null;
  }
}

type Invocation =
  | { verb: 'file'; parentId: number; pr?: string }
  | { verb: 'start'; parentId: number; owner?: string }
  | { verb: 'status'; parentId: number };

function parseInvocation(args: string[]): Invocation | null {
  const parsed = strictArgs(args);
  if (!parsed || parsed.positionals.length !== 1) return null;
  const { values } = parsed;
  const parentId = Number(values.parent?.replace(/^sc-/, ''));
  if (!Number.isInteger(parentId) || parentId <= 0) return null;
  const [verb] = parsed.positionals;
  if (verb === 'file' && values.owner === undefined) return { verb, parentId, pr: values.pr };
  if (verb === 'start' && values.pr === undefined) return { verb, parentId, owner: values.owner };
  if (verb === 'status' && values.pr === undefined && values.owner === undefined) {
    return { verb, parentId };
  }
  return null;
}

export default function followUp(
  args: string[],
  _cwd: string,
  run: RunShort = runShort,
  readInput: () => string = () => readFileSync(0, 'utf8'),
): number {
  const invocation = parseInvocation(args);
  if (!invocation) {
    console.error(USAGE);
    return 1;
  }
  try {
    if (invocation.verb === 'file') {
      return fileCommand(invocation.parentId, invocation.pr, readInput(), run);
    }
    if (invocation.verb === 'status') {
      console.log(JSON.stringify(followUpStatus(invocation.parentId, run)));
      return 0;
    }
    console.log(JSON.stringify(startFollowUp(invocation.parentId, invocation.owner, run)));
    return 0;
  } catch (error) {
    console.error(`devkit follow-up: ${errorMessage(error)}`);
    return 1;
  }
}
