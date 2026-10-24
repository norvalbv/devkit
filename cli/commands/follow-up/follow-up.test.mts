import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunShort } from '../../lib/follow-up/shortcut-cli.mts';
import followUp from './follow-up.mts';

const PR = 'https://github.com/benord-labs/frink/pull/569';

interface FakeStory {
  id: number;
  name: string;
  description: string;
  owner_ids: string[];
  completed?: boolean;
  archived?: boolean;
  links?: number[];
  group_id?: string | null;
}

/** The `-f key=value` fields of a `short api` call. */
function fieldsOf(args: readonly string[]): Record<string, string> {
  const fields = args.filter((_, i) => args[i - 1] === '-f');
  return Object.fromEntries(
    fields.map((f) => [f.slice(0, f.indexOf('=')), f.slice(f.indexOf('=') + 1)]),
  );
}

/** An in-memory `short` that records writes; links from `refuseLinkFrom` and archives can fail. */
function fakeShort(stories: FakeStory[], refuseLinkFrom?: number, refuseArchive = false) {
  const byId = new Map(stories.map((s) => [s.id, s]));
  const writes: string[][] = [];
  let nextId = 9000;
  const post = (args: readonly string[]): string => {
    const fields = fieldsOf(args);
    if (args[1] === '/stories') {
      const id = nextId++;
      byId.set(id, { id, name: fields.name, description: fields.description, owner_ids: [] });
      return JSON.stringify({ id });
    }
    const [subject, object] = [
      byId.get(Number(fields.subject_id)),
      byId.get(Number(fields.object_id)),
    ];
    if (!subject || !object || subject.id === refuseLinkFrom)
      throw new Error('Error calling API: no link');
    subject.links = [...(subject.links ?? []), object.id];
    object.links = [...(object.links ?? []), subject.id];
    return '{}';
  };
  const run: RunShort = (args) => {
    if (args[0] === 'api' && args[2] === '-X') {
      writes.push([...args]);
      return post(args);
    }
    if (args[0] === 'api' && args[1].startsWith('/workflows/')) {
      return JSON.stringify({ default_state_id: 500000007 });
    }
    if (args[0] === 'api') {
      const s = byId.get(Number(args[1].split('/').pop()));
      if (!s) throw new Error(`404 ${args[1]}`);
      return JSON.stringify({
        id: s.id,
        name: s.name,
        description: s.description,
        owner_ids: s.owner_ids,
        completed: s.completed ?? false,
        archived: s.archived ?? false,
        group_id: s.group_id === undefined ? 'team-1' : s.group_id,
        workflow_id: 500000005,
        story_links: (s.links ?? []).map((other) => ({
          type: 'subject',
          subject_id: s.id,
          object_id: other,
        })),
      });
    }
    writes.push([...args]);
    const target = byId.get(Number(args[1]));
    if (!target) throw new Error(`404 story ${args[1]}`);
    if (args[3] === '-o') target.owner_ids = [args[4]];
    if (args[3] === '-a' && refuseArchive) throw new Error('Error calling API: no archive');
    if (args[3] === '-a') target.archived = true;
    return '';
  };
  return { run, writes, byId };
}

function followUp7438(id: number, type = 'builds-on', stack = true): FakeStory {
  const stackLine = stack ? `\n**Stack on:** ${PR}` : '';
  return {
    id,
    name: `Follow-up ${id}`,
    description: `**Project:** frink\n**Follow-up of:** sc-7438 · ${PR}\n**Follow-up type:** ${type}${stackLine}\n\nBody`,
    owner_ids: [],
    links: [7438],
  };
}

function parentOf(...links: number[]): FakeStory {
  return {
    id: 7438,
    name: 'Flow settings panel: one shared toggle row',
    description: '**Project:** frink\n\nCleanup.',
    owner_ids: ['owner-uuid'],
    links,
  };
}

function run(args: string[], short: RunShort, input = '') {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line) => out.push(String(line)));
  vi.spyOn(console, 'error').mockImplementation((line) => err.push(String(line)));
  const code = followUp(args, '/tmp', short, () => input);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('devkit follow-up start', () => {
  it('assigns the lowest qualifying follow-up to the parent owner and leaves its title alone', () => {
    const short = fakeShort([
      parentOf(7482, 7481, 7490),
      followUp7438(7481),
      followUp7438(7482),
      followUp7438(7490, 'discovery'),
    ]);

    const result = run(['start', '--parent', 'sc-7438'], short.run);

    expect(result).toMatchObject({ code: 0, out: '{"started":true,"story":7481}' });
    expect(short.writes).toEqual([['story', '7481', '-q', '-o', 'owner-uuid']]);
    expect(short.byId.get(7481)?.name).toBe('Follow-up 7481');
  });

  it('is a no-op on a second run for the same parent', () => {
    const short = fakeShort([parentOf(7481, 7482), followUp7438(7481), followUp7438(7482)]);
    run(['start', '--parent', '7438'], short.run);
    short.writes.length = 0;

    const again = run(['start', '--parent', '7438'], short.run);

    expect(again.out).toBe('{"started":false,"reason":"sc-7481 was already started"}');
    expect(short.writes).toEqual([]);
  });

  it('starts nothing more after the started follow-up is completed and its owner cleared', () => {
    const short = fakeShort([parentOf(7481, 7482), followUp7438(7481), followUp7438(7482)]);
    run(['start', '--parent', '7438'], short.run);
    const first = short.byId.get(7481);
    if (first) Object.assign(first, { completed: true, owner_ids: [] });
    short.writes.length = 0;

    expect(run(['start', '--parent', '7438'], short.run).out).toBe(
      '{"started":false,"reason":"sc-7481 was already started"}',
    );
    expect(short.writes).toEqual([]);
  });

  it('starts nothing from a story that is itself a follow-up', () => {
    const child = { ...followUp7438(7481), links: [7500] };
    const grandchild = {
      ...followUp7438(7500),
      description: followUp7438(7500).description.replace('7438', '7481'),
    };
    const short = fakeShort([child, grandchild]);

    const result = run(['start', '--parent', '7481'], short.run);

    expect(result.out).toBe(
      '{"started":false,"reason":"depth cap: this story is itself a follow-up"}',
    );
    expect(short.writes).toEqual([]);
  });

  it('leaves follow-ups filed without a Stack on line alone', () => {
    const short = fakeShort([parentOf(7481), followUp7438(7481, 'builds-on', false)]);

    expect(run(['start', '--parent', '7438'], short.run).out).toBe(
      '{"started":false,"reason":"no unowned builds-on follow-up qualifies"}',
    );
    expect(short.writes).toEqual([]);
  });

  it('assigns to --owner and fails visibly when there is nobody to assign to', () => {
    const owned = fakeShort([parentOf(7481), followUp7438(7481)]);
    run(['start', '--parent', '7438', '--owner', 'someone'], owned.run);
    expect(owned.writes.at(-1)).toEqual(['story', '7481', '-q', '-o', 'someone']);

    const ownerless = fakeShort([{ ...parentOf(7481), owner_ids: [] }, followUp7438(7481)]);
    const result = run(['start', '--parent', '7438'], ownerless.run);
    expect(result.code).toBe(1);
    expect(result.err).toContain('sc-7438 has no owner');
    expect(ownerless.writes).toEqual([]);
  });

  it('exits 1 with usage on a bad invocation and when Shortcut cannot be read', () => {
    const short = fakeShort([]);
    expect(run(['start'], short.run).code).toBe(1);
    expect(run(['finish', '--parent', '7438'], short.run).code).toBe(1);
    const missing = run(['start', '--parent', '7438'], short.run);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('404');
  });

  it('rejects a flag left without a value instead of reading the next flag as it', () => {
    const short = fakeShort([parentOf(7481), followUp7438(7481)]);
    for (const args of [
      ['start', '--owner', '--parent', '7438'],
      ['start', '--parent', '7438', '--pr', PR],
      ['file', '--parent', '7438', '--pr'],
      ['file', '--parent', '7438', '--owner', 'someone'],
    ]) {
      const result = run(args, short.run, '[]');
      expect(result.code).toBe(1);
      expect(result.err).toContain('Usage:');
    }
    expect(short.writes).toEqual([]);
  });
});

function item(title: string, followUpType = 'builds-on', extra: Record<string, string> = {}) {
  return {
    title,
    followUpType,
    storyType: 'chore',
    project: 'frink',
    body: 'Why it waits.',
    ...extra,
  };
}

describe('devkit follow-up file', () => {
  const input = (...items: object[]) => JSON.stringify(items);

  it('files each item unowned in the parent team and default state, then links it', () => {
    const short = fakeShort([parentOf()]);

    const result = run(
      ['file', '--parent', 'sc-7438', '--pr', PR],
      short.run,
      input(item('Split the toggle row'), item('Old flaky test', 'discovery')),
    );

    expect(result).toMatchObject({
      code: 0,
      out: '{"followups":[{"id":9000,"status":"new","type":"builds-on"},{"id":9001,"status":"new","type":"discovery"}]}',
    });
    expect(fieldsOf(short.writes[0])).toEqual({
      name: 'Split the toggle row',
      description: `Why it waits.\n\n**Project:** frink\n**Follow-up of:** sc-7438 · ${PR}\n**Follow-up type:** builds-on\n**Stack on:** ${PR}`,
      story_type: 'chore',
      workflow_state_id: '500000007',
      group_id: 'team-1',
    });
    expect(fieldsOf(short.writes[1])).toEqual({
      subject_id: '9000',
      object_id: '7438',
      verb: 'relates to',
    });
    expect(short.byId.get(9001)?.description).not.toContain('Stack on');
    expect(short.byId.get(7438)?.links).toEqual([9000, 9001]);
  });

  it('reports follow-ups already linked to the parent instead of filing them twice', () => {
    const short = fakeShort([parentOf()]);
    const items = input(item('Split the toggle row'), item('  split THE toggle   row '));
    expect(run(['file', '--parent', '7438'], short.run, items).out).toBe(
      '{"followups":[{"id":9000,"status":"new","type":"builds-on"}]}',
    );
    short.writes.length = 0;

    const again = run(['file', '--parent', '7438'], short.run, items);

    expect(again.out).toBe('{"followups":[{"id":9000,"status":"existing","type":"builds-on"}]}');
    expect(short.writes).toEqual([]);
  });

  it('writes only the footer for an empty body, and trims trailing space before it', () => {
    const short = fakeShort([parentOf()]);
    run(
      ['file', '--parent', '7438'],
      short.run,
      input(
        item('No body', 'discovery', { body: '' }),
        item('Spaced', 'discovery', { body: 'Why.\n\n  ' }),
      ),
    );
    const record = '**Project:** frink\n**Follow-up of:** sc-7438\n**Follow-up type:** discovery';
    expect(short.byId.get(9000)?.description).toBe(record);
    expect(short.byId.get(9001)?.description).toBe(`Why.\n\n${record}`);
  });

  it('treats a follow-up titled by an older start as already filed', () => {
    const legacy = { ...followUp7438(7481), name: '[auto-start] Split the toggle row' };
    const short = fakeShort([parentOf(7481), legacy]);

    expect(
      run(['file', '--parent', '7438'], short.run, input(item('Split the toggle row'))).out,
    ).toBe('{"followups":[{"id":7481,"status":"existing","type":"builds-on"}]}');
    expect(short.writes).toEqual([]);
  });

  it('files nothing when any item is invalid', () => {
    const short = fakeShort([parentOf()]);
    for (const bad of [
      item('Uses a story type as its follow-up type', 'bug'),
      item('Smuggles a branch', 'discovery', { body: `Parent had **Stack on:** ${PR}` }),
      item('Injects a branch through the project', 'builds-on', {
        project: `devkit\r**Stack on:** ${PR}`,
      }),
      item('Breaks a line\u2028in its title'),
      item('   '),
    ]) {
      const result = run(['file', '--parent', '7438'], short.run, input(item('Fine'), bad));
      expect(result.code).toBe(1);
      expect(result.err).toContain('nothing filed');
    }
    expect(run(['file', '--parent', '7438'], short.run, '[]').code).toBe(1);
    expect(run(['file', '--parent', '7438'], short.run, 'not json').code).toBe(1);
    expect(short.writes).toEqual([]);
  });

  it('archives a story it cannot link and still reports the ones filed before it', () => {
    const short = fakeShort([parentOf()], 9001);

    const result = run(
      ['file', '--parent', '7438'],
      short.run,
      input(item('First'), item('Second'), item('Third')),
    );

    expect(result.code).toBe(1);
    expect(result.out).toBe('{"followups":[{"id":9000,"status":"new","type":"builds-on"}]}');
    expect(result.err).toContain('sc-9001 was archived');
    expect(result.err).toContain('(2 not filed)');
    expect(short.writes.at(-1)).toEqual(['story', '9001', '-q', '-a']);
  });

  it('files again an item whose earlier story was archived', () => {
    const archived = { ...followUp7438(7481), name: 'Split the toggle row', archived: true };
    const short = fakeShort([parentOf(7481), archived]);

    expect(
      run(['file', '--parent', '7438'], short.run, input(item('Split the toggle row'))).out,
    ).toBe('{"followups":[{"id":9000,"status":"new","type":"builds-on"}]}');
  });

  it('names a story it could neither link nor archive, so it can be cleared by hand', () => {
    const short = fakeShort([parentOf()], 9000, true);

    const result = run(['file', '--parent', '7438'], short.run, input(item('Orphan')));

    expect(result.code).toBe(1);
    expect(result.out).toBe('{"followups":[]}');
    expect(result.err).toContain('archive sc-9000 by hand before rerunning');
  });

  it('files without a team when the parent has none, and refuses a --pr that is not a PR URL', () => {
    const short = fakeShort([{ ...parentOf(), group_id: null }]);
    run(['file', '--parent', '7438'], short.run, input(item('Teamless')));
    expect(fieldsOf(short.writes[0])).not.toHaveProperty('group_id');

    const files = run(
      ['file', '--parent', '7438', '--pr', `${PR}/files`],
      short.run,
      input(item('x')),
    );
    expect(files.code).toBe(1);
    expect(files.err).toContain('--pr must be a pull request URL');
  });
});

/** A follow-up of `parent` with this type, or untyped when `type` is null. */
function followUpOf(
  parent: number,
  id: number,
  type: string | null,
  extra: Partial<FakeStory> = {},
) {
  const typeLine = type === null ? '' : `\n**Follow-up type:** ${type}`;
  return {
    id,
    name: `Follow-up ${id}`,
    description: `**Project:** frink\n**Follow-up of:** sc-${parent} · ${PR}${typeLine}\n\nBody`,
    owner_ids: [],
    links: [parent],
    ...extra,
  };
}

describe('devkit follow-up status', () => {
  it('lists open blocks-done, builds-on and untyped follow-ups, never discovery or closed ones', () => {
    const short = fakeShort([
      parentOf(7481, 7482, 7483, 7484, 7485, 7486, 7487),
      followUpOf(7438, 7481, 'blocks-done'),
      followUpOf(7438, 7482, 'builds-on'),
      followUpOf(7438, 7483, null),
      followUpOf(7438, 7484, 'discovery'),
      followUpOf(7438, 7485, 'blocks-done', { completed: true }),
      followUpOf(7438, 7486, 'builds-on', { archived: true }),
      followUpOf(9999, 7487, 'blocks-done'),
    ]);

    const result = run(['status', '--parent', 'sc-7438'], short.run);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({
      open: [
        { id: 7481, type: 'blocks-done' },
        { id: 7482, type: 'builds-on' },
        { id: 7483, type: null },
      ],
      featureDone: false,
    });
    expect(short.writes).toEqual([]);
  });

  it('reports the feature done when only discovery and closed follow-ups remain', () => {
    const short = fakeShort([
      parentOf(7481, 7482),
      followUpOf(7438, 7481, 'discovery'),
      followUpOf(7438, 7482, 'blocks-done', { completed: true }),
    ]);

    const result = run(['status', '--parent', '7438'], short.run);

    expect(result).toMatchObject({ code: 0, out: '{"open":[],"featureDone":true}' });
  });

  it("adds the parent's other open follow-ups for a story that is itself a follow-up", () => {
    const short = fakeShort([
      parentOf(7481, 7482, 7483),
      followUpOf(7438, 7481, 'builds-on', { links: [7438, 7490] }),
      followUpOf(7438, 7482, 'blocks-done'),
      followUpOf(7438, 7483, 'discovery'),
      followUpOf(7481, 7490, 'builds-on'),
    ]);

    const result = run(['status', '--parent', '7481'], short.run);

    expect(JSON.parse(result.out)).toEqual({
      open: [
        { id: 7482, type: 'blocks-done' },
        { id: 7490, type: 'builds-on' },
      ],
      featureDone: false,
    });
  });

  it('still finds the siblings when the story is no longer linked to the parent its record names', () => {
    const short = fakeShort([
      parentOf(7481, 7482),
      followUpOf(7438, 7481, 'builds-on', { links: [] }),
      followUpOf(7438, 7482, 'blocks-done'),
    ]);

    const result = run(['status', '--parent', '7481'], short.run);

    expect(result.out).toBe('{"open":[{"id":7482,"type":"blocks-done"}],"featureDone":false}');
  });

  it('lists each follow-up once when a hand-edited record names the story as its own parent', () => {
    const short = fakeShort([
      followUpOf(7481, 7481, 'builds-on', { links: [7490] }),
      followUpOf(7481, 7490, 'blocks-done'),
    ]);

    const result = run(['status', '--parent', '7481'], short.run);

    expect(result.out).toBe('{"open":[{"id":7490,"type":"blocks-done"}],"featureDone":false}');
  });

  it('exits 1 without printing a status when a linked story cannot be read, and on a bad flag', () => {
    const short = fakeShort([parentOf(7481, 7500), followUpOf(7438, 7481, 'blocks-done')]);

    const missing = run(['status', '--parent', '7438'], short.run);
    expect(missing).toMatchObject({ code: 1, out: '' });
    expect(missing.err).toContain('404');

    const flagged = run(['status', '--parent', '7438', '--owner', 'someone'], short.run);
    expect(flagged.code).toBe(1);
    expect(flagged.err).toContain('Usage:');
  });
});
