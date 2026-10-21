import { describe, expect, it } from 'vitest';
import {
  AUTO_START_PREFIX,
  decideStart,
  ineligibleReason,
  isDepthCapped,
  parseRecord,
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

  it('leaves an unknown type unset instead of guessing', () => {
    expect(parseRecord(followUpOf(1, 'builds on'))?.type).toBeNull();
  });
});

describe('isDepthCapped', () => {
  it('caps a story devkit started and a story that is itself a follow-up', () => {
    expect(isDepthCapped(story(1, '', { name: `${AUTO_START_PREFIX} Fix it` }))).toBe(true);
    expect(isDepthCapped(story(1, followUpOf(9, 'builds-on')))).toBe(true);
    expect(isDepthCapped(story(1, '**Project:** frink\n\nNew feature.'))).toBe(false);
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

  it('renames and assigns the lowest-id unowned eligible follow-up', () => {
    const decision = decideStart(1, [ok(30), ok(20), story(10, followUpOf(1, 'discovery'))]);
    expect(decision).toMatchObject({ action: 'assign', rename: true, story: { id: 20 } });
  });

  it('starts nothing once a marked follow-up is owned, so a rerun is a no-op', () => {
    const decision = decideStart(1, [
      ok(30, { name: `${AUTO_START_PREFIX} Story 30`, ownerIds: ['u1'] }),
      ok(20),
    ]);
    expect(decision).toEqual({ action: 'none', reason: 'sc-30 was already started' });
  });

  it('still counts a started follow-up once it is closed, so a sibling never starts', () => {
    const done = ok(20, { name: `${AUTO_START_PREFIX} Story 20`, ownerIds: ['u1'], closed: true });
    expect(decideStart(1, [done, ok(30)])).toEqual({
      action: 'none',
      reason: 'sc-20 was already started',
    });
  });

  it('resumes a marked follow-up whose assign failed before picking a new one', () => {
    const decision = decideStart(1, [ok(20), ok(30, { name: `${AUTO_START_PREFIX} Story 30` })]);
    expect(decision).toMatchObject({ action: 'assign', rename: false, story: { id: 30 } });
  });

  it('skips a follow-up a human already took', () => {
    expect(decideStart(1, [ok(20, { ownerIds: ['u1'] })])).toEqual({
      action: 'none',
      reason: 'no unowned builds-on follow-up qualifies',
    });
  });
});
