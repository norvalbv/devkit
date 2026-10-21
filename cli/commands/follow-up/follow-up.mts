/** `devkit follow-up start`: start one builds-on follow-up of a shipped story (see `help`). */
import { AUTO_START_PREFIX, decideStart, isDepthCapped } from '../../lib/follow-up/record.mts';
import {
  assignStory,
  readStory,
  type RunShort,
  renameStory,
  runShort,
} from '../../lib/follow-up/shortcut-cli.mts';

export const meta = {
  name: 'follow-up',
  agentFacing: false,
  notRoutedBecause:
    "Run by a Flow's last step after a story ships (frink-work's Start Follow-up node). Starting " +
    'a follow-up queues paid agent work and narrows the human gate on follow-ups, so an agent never ' +
    'invokes it by hand.',
  summary:
    'Start one builds-on follow-up of a shipped story: prefix it [auto-start], then assign it.',
  help: `devkit follow-up start — start at most one builds-on follow-up of a shipped story.

Usage:
  devkit follow-up start --parent <story> [--owner <member>]

  --parent <story>   The story that just shipped (7315 or sc-7315).
  --owner <member>   Who to assign the follow-up to. Default: the parent's first owner.

Reads the parent and every story linked to it through the machine's \`short\` CLI. A linked story
qualifies when its description says **Follow-up of:** sc-<parent>, **Follow-up type:** builds-on,
it is open, and, when the parent had a PR, it carries **Stack on:** with that PR's URL. The lowest
qualifying id is renamed "${AUTO_START_PREFIX} <title>" and then assigned; assigning is what fires a
story-assigned trigger. blocks-done and discovery follow-ups are left for a human.

Depth is capped at one hop: when the parent is itself a follow-up (its title starts with
${AUTO_START_PREFIX} or it carries **Follow-up of:**), nothing starts. At most one follow-up per
parent ever starts, so running it again is safe: an assigned ${AUTO_START_PREFIX} follow-up means
done, and an unassigned one is assigned without a second rename.

Prints one JSON line: {"started":true,"story":<id>} or {"started":false,"reason":"..."}.
Exits 1 when Shortcut cannot be read or written, or the parent has no owner and no --owner.`,
  valueFlags: ['--parent', '--owner'],
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
  const { story } = decision;
  if (decision.rename) renameStory(run, story.id, `${AUTO_START_PREFIX} ${story.name}`);
  assignStory(run, story.id, assignee);
  return { started: true, story: story.id };
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export default function followUp(args: string[], _cwd: string, run: RunShort = runShort): number {
  const parentId = Number(flag(args, '--parent')?.replace(/^sc-/, ''));
  if (args[0] !== 'start' || !Number.isInteger(parentId) || parentId <= 0) {
    console.error('Usage: devkit follow-up start --parent <story> [--owner <member>]');
    return 1;
  }
  try {
    console.log(JSON.stringify(startFollowUp(parentId, flag(args, '--owner'), run)));
    return 0;
  } catch (error) {
    console.error(`devkit follow-up: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
