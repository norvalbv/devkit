import { describe, expect, it } from 'vitest';
import {
  decideStart,
  FOLLOW_UP_TYPES,
  ineligibleReason,
  isDepthCapped,
  isPrUrl,
  normalisedTitle,
  parseRecord,
  renderRecord,
  type StoryView,
} from './record.mts';

const PR = 'https://github.com/benord-labs/frink/pull/569';

function followUpOf(parent: number, type: string, stack: string | null = PR): string {
  const lines = [
    '**Project:** frink',
    `**Follow-up of:** sc-${parent} · ${PR}`,
    `**Follow-up type:** ${type}`,
  ];
  if (stack) lines.push(`**Stack on:** ${stack}`);
  return `${lines.join('\n')}\n\n## Problem\nPR #569 does two things.`;
}

function story(id: number, description: string, extra: Partial<StoryView> = {}): StoryView {
  return {
    id,
    name: `Story ${id}`,
    description,
    ownerIds: [],
    closed: false,
    completed: false,
    linkedIds: [],
    ...extra,
  };
}

describe('parseRecord', () => {
  it('reads the lines Track Follow-ups writes, with and without Stack on', () => {
    expect(parseRecord(followUpOf(7438, 'builds-on', null))).toEqual({
      parent: 7438,
      prUrl: PR,
      type: 'builds-on',
      stackOn: null,
    });
    expect(parseRecord(followUpOf(7438, 'builds-on'))?.stackOn).toBe(PR);
  });

  it('accepts a follow-up of an obsolete story, which has no PR', () => {
    const record = parseRecord(
      '**Follow-up of:** sc-12 (closed as obsolete)\n**Follow-up type:** discovery',
    );
    expect(record).toEqual({ parent: 12, prUrl: null, type: 'discovery', stackOn: null });
  });

  it('treats a story without a Follow-up of line as not a follow-up', () => {
    expect(
      parseRecord('**Project:** frink\n\nMentions **Follow-up of:** mid-sentence.'),
    ).toBeNull();
    expect(parseRecord('**Follow-up of:** someone else')).toBeNull();
  });

  it('reads the lines from a footer under the body, as file writes them', () => {
    const footer = `## Problem\nPR #569 does two things.\n\n${renderRecord('frink', 7438, 'builds-on', PR)}`;
    expect(parseRecord(footer)).toEqual(parseRecord(followUpOf(7438, 'builds-on')));
    expect(parseRecord(footer)).toMatchObject({ parent: 7438, stackOn: PR });
  });

  it('leaves an unknown type unset instead of guessing', () => {
    expect(parseRecord(followUpOf(1, 'builds on'))?.type).toBeNull();
  });
});

describe('renderRecord', () => {
  it('writes lines parseRecord reads back, with Stack on only for a stackable type with a PR', () => {
    for (const type of FOLLOW_UP_TYPES) {
      for (const prUrl of [PR, null]) {
        expect(parseRecord(`${renderRecord('devkit', 7438, type, prUrl)}\n\nBody`)).toEqual({
          parent: 7438,
          prUrl,
          type,
          stackOn: prUrl && type !== 'discovery' ? prUrl : null,
        });
      }
    }
  });
});

describe('normalisedTitle and isPrUrl', () => {
  it('ignores case, spacing and a legacy leading start marker, and accepts only a whole PR URL', () => {
    expect(normalisedTitle('[auto-start]  Split   The Row ')).toBe('split the row');
    expect(normalisedTitle('Add [auto-start] logging')).toBe('add [auto-start] logging');
    expect(isPrUrl(PR)).toBe(true);
    expect(isPrUrl(`${PR}/files`)).toBe(false);
    expect(isPrUrl(`see ${PR}`)).toBe(false);
  });
});

describe('isDepthCapped', () => {
  it('caps a story that carries a Follow-up of line, wherever it sits, and ignores the title', () => {
    expect(isDepthCapped(story(1, followUpOf(9, 'builds-on')))).toBe(true);
    expect(
      isDepthCapped(story(1, `Body.\n\n${renderRecord('devkit', 9, 'discovery', null)}`)),
    ).toBe(true);
    expect(isDepthCapped(story(1, '**Project:** frink\n\nNew feature.'))).toBe(false);
    expect(isDepthCapped(story(1, 'New feature.', { name: '[auto-start] Fix it' }))).toBe(false);
  });
});

describe('ineligibleReason', () => {
  it('admits only an open builds-on follow-up of this parent stacked on its PR', () => {
    expect(ineligibleReason(story(2, followUpOf(1, 'builds-on')), 1)).toBeNull();
    expect(ineligibleReason(story(2, followUpOf(5, 'builds-on')), 1)).toBe(
      'not a follow-up of this story',
    );
    expect(ineligibleReason(story(2, followUpOf(1, 'blocks-done')), 1)).toBe(
      'blocks-done follow-ups wait for a human',
    );
    expect(ineligibleReason(story(2, followUpOf(1, 'builds-on'), { closed: true }), 1)).toBe(
      'done or archived',
    );
    expect(ineligibleReason(story(2, followUpOf(1, 'builds-on', null)), 1)).toBe(
      'no Stack on line for the parent PR',
    );
  });

  it('rejects a Stack on line that names a different PR', () => {
    const other = 'https://github.com/benord-labs/frink/pull/1';
    expect(ineligibleReason(story(2, followUpOf(1, 'builds-on', other)), 1)).toBe(
      'no Stack on line for the parent PR',
    );
  });
});

describe('decideStart', () => {
  const ok = (id: number, extra: Partial<StoryView> = {}) =>
    story(id, followUpOf(1, 'builds-on'), extra);
  const started = (id: number) => ({ action: 'none', reason: `sc-${id} was already started` });

  it('assigns the lowest-id unowned eligible follow-up without touching its title', () => {
    const decision = decideStart(1, [ok(30), ok(20), story(10, followUpOf(1, 'discovery'))]);
    expect(decision).toEqual({ action: 'assign', story: ok(20) });
  });

  it('starts nothing once a follow-up is owned, so a rerun or a guard-assigned one stops it', () => {
    expect(decideStart(1, [ok(30, { ownerIds: ['u1'] }), ok(20)])).toEqual(started(30));
  });

  it('counts a completed follow-up as started even after its owner was cleared', () => {
    const done = ok(20, { closed: true, completed: true });
    expect(decideStart(1, [done, ok(30)])).toEqual(started(20));
  });

  it('does not count an archived follow-up, owned or not, so its sibling can still start', () => {
    for (const archived of [ok(20, { closed: true }), ok(20, { closed: true, ownerIds: ['u1'] })]) {
      expect(decideStart(1, [archived, ok(30)])).toEqual({ action: 'assign', story: ok(30) });
    }
  });

  it('counts an owned blocks-done or untyped follow-up as started, but not an owned discovery', () => {
    const blocksDone = story(20, followUpOf(1, 'blocks-done'), { ownerIds: ['u1'] });
    const discovery = story(20, followUpOf(1, 'discovery'), { ownerIds: ['u1'] });
    const untyped = story(20, followUpOf(1, 'builds on'), { ownerIds: ['u1'] });
    expect(decideStart(1, [blocksDone, ok(30)])).toEqual(started(20));
    expect(decideStart(1, [untyped, ok(30)])).toEqual(started(20));
    expect(decideStart(1, [discovery, ok(30)])).toEqual({ action: 'assign', story: ok(30) });
  });

  it('ignores owned stories that are not follow-ups of this parent', () => {
    const other = story(20, followUpOf(5, 'builds-on'), { ownerIds: ['u1'] });
    expect(decideStart(1, [other, ok(30)])).toEqual({ action: 'assign', story: ok(30) });
  });

  it('starts nothing when no follow-up qualifies', () => {
    expect(decideStart(1, [story(20, followUpOf(1, 'blocks-done'))])).toEqual({
      action: 'none',
      reason: 'no unowned builds-on follow-up qualifies',
    });
  });
});
