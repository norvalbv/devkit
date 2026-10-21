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
  links?: number[];
}

/** A `short` that serves stories from memory, applies -t / -o, and records every write. */
function fakeShort(stories: FakeStory[]) {
  const byId = new Map(stories.map((s) => [s.id, s]));
  const writes: string[][] = [];
  const run: RunShort = (args) => {
    if (args[0] === 'api') {
      const s = byId.get(Number(args[1].split('/').pop()));
      if (!s) throw new Error(`404 ${args[1]}`);
      return JSON.stringify({
        id: s.id,
        name: s.name,
        description: s.description,
        owner_ids: s.owner_ids,
        completed: s.completed ?? false,
        archived: false,
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
    if (args[3] === '-t') target.name = args[4];
    if (args[3] === '-o') target.owner_ids = [args[4]];
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

function run(args: string[], short: RunShort) {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line) => out.push(String(line)));
  vi.spyOn(console, 'error').mockImplementation((line) => err.push(String(line)));
  const code = followUp(args, '/tmp', short);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('devkit follow-up start', () => {
  it('renames then assigns the lowest qualifying follow-up to the parent owner', () => {
    const short = fakeShort([
      parentOf(7482, 7481, 7490),
      followUp7438(7481),
      followUp7438(7482),
      followUp7438(7490, 'discovery'),
    ]);

    const result = run(['start', '--parent', 'sc-7438'], short.run);

    expect(result).toMatchObject({ code: 0, out: '{"started":true,"story":7481}' });
    expect(short.writes).toEqual([
      ['story', '7481', '-q', '-t', '[auto-start] Follow-up 7481'],
      ['story', '7481', '-q', '-o', 'owner-uuid'],
    ]);
  });

  it('is a no-op on a second run for the same parent', () => {
    const short = fakeShort([parentOf(7481, 7482), followUp7438(7481), followUp7438(7482)]);
    run(['start', '--parent', '7438'], short.run);
    short.writes.length = 0;

    const again = run(['start', '--parent', '7438'], short.run);

    expect(again.out).toBe('{"started":false,"reason":"sc-7481 was already started"}');
    expect(short.writes).toEqual([]);
  });

  it('starts nothing more after the started follow-up is completed', () => {
    const short = fakeShort([parentOf(7481, 7482), followUp7438(7481), followUp7438(7482)]);
    run(['start', '--parent', '7438'], short.run);
    const first = short.byId.get(7481);
    if (first) first.completed = true;
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
    expect(run(['file', '--parent', '7438'], short.run).code).toBe(1);
    const missing = run(['start', '--parent', '7438'], short.run);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('404');
  });
});
