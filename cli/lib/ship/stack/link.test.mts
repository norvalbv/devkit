import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type GhResult, linkStack, recordStackEvent } from './link.mts';

const REPO = { full_name: 'Acme/App', default_branch: 'main', owner: { login: 'Acme' } };

interface StackPos {
  number: number;
  position: number;
  size: number;
}

/** A PR as the REST API returns it, trimmed to the fields linkStack reads. */
const pull = (number: number, base: string, stack: StackPos | null = null) => ({
  number,
  stack,
  base: { ref: base, repo: REPO },
});

type Pull = ReturnType<typeof pull>;
type ApiBody = Pull | Pull[] | { number: number };

const ok = (body: ApiBody): GhResult => ({ status: 0, stdout: JSON.stringify(body) });

interface Call {
  args: string[];
  input?: string;
}

/** A fake GitHub answering by route; every call is logged for assertions. */
function fakeGh(routes: Record<string, GhResult>) {
  const calls: Call[] = [];
  const gh = (args: string[], input?: string): GhResult => {
    calls.push({ args, input });
    const key = args.find((a) => a.startsWith('repos/')) ?? '';
    return routes[key] ?? { status: 1, stdout: '' };
  };
  return { gh, calls };
}

const OWN = 'repos/acme/app/pulls/42';
const LIST = 'repos/Acme/App/pulls';

describe('linkStack', () => {
  it('stays silent with one GET when the PR targets the default branch', () => {
    const { gh, calls } = fakeGh({ [OWN]: ok(pull(42, 'main')) });
    expect(linkStack('acme/app', 42, gh)).toEqual({ outcome: 'none', lines: [] });
    expect(calls).toHaveLength(1);
  });

  it('creates [parent, PR] when the parent is unstacked and targets the default branch', () => {
    const { gh, calls } = fakeGh({
      [OWN]: ok(pull(42, 'feat/a')),
      [LIST]: ok([pull(41, 'main')]),
      'repos/Acme/App/stacks': ok({ number: 7 }),
    });
    const r = linkStack('acme/app', 42, gh);
    expect(r).toMatchObject({ outcome: 'created', parent: 41, stack: 7 });
    expect(r.lines[0]).toContain('stacked #42 on #41 (GitHub stack #7)');
    // The canonical owner from the API, not the remote URL's spelling, scopes the head filter.
    expect(calls[1].args).toEqual([
      'api',
      '-X',
      'GET',
      LIST,
      '-f',
      'head=Acme:feat/a',
      '-f',
      'state=open',
    ]);
    expect(calls[2].args).toEqual(['api', '-X', 'POST', 'repos/Acme/App/stacks', '--input', '-']);
    expect(JSON.parse(calls[2].input ?? '')).toEqual({ pull_requests: [41, 42] });
  });

  it('appends only the new PR when the parent tops an existing stack', () => {
    const { gh, calls } = fakeGh({
      [OWN]: ok(pull(42, 'feat/b')),
      [LIST]: ok([pull(41, 'feat/a', { number: 7, position: 2, size: 2 })]),
      'repos/Acme/App/stacks/7/add': ok({ number: 7 }),
    });
    expect(linkStack('acme/app', 42, gh)).toMatchObject({ outcome: 'added', parent: 41, stack: 7 });
    expect(JSON.parse(calls[2].input ?? '')).toEqual({ pull_requests: [42] });
  });

  it('is a no-op on a re-run once the PR is already stacked', () => {
    const { gh, calls } = fakeGh({
      [OWN]: ok(pull(42, 'feat/a', { number: 7, position: 2, size: 2 })),
    });
    expect(linkStack('acme/app', 42, gh)).toMatchObject({ outcome: 'already', stack: 7 });
    expect(calls).toHaveLength(1);
  });

  it('stays silent when the base branch has no open PR', () => {
    const { gh, calls } = fakeGh({ [OWN]: ok(pull(42, 'release/1.0')), [LIST]: ok([]) });
    expect(linkStack('acme/app', 42, gh).outcome).toBe('none');
    expect(calls).toHaveLength(2);
  });

  it.each([
    [
      'a mid-stack parent',
      [pull(41, 'feat/a', { number: 7, position: 1, size: 3 })],
      /mid-stack in GitHub stack #7/,
    ],
    [
      'a parent on a non-default base',
      [pull(41, 'feat/z')],
      /targets 'feat\/z', not 'main'.*gh stack link <lower PRs…> 41 42/,
    ],
    [
      'two open PRs on the head',
      [pull(41, 'main'), pull(40, 'main')],
      /2 open PRs have head 'feat\/a'/,
    ],
  ])('skips %s without a POST', (_label, parents, line) => {
    const { gh, calls } = fakeGh({ [OWN]: ok(pull(42, 'feat/a')), [LIST]: ok(parents) });
    const r = linkStack('acme/app', 42, gh);
    expect(r.outcome).toBe('skipped');
    expect(r.lines[0]).toMatch(line);
    expect(calls.some((c) => c.args.includes('POST'))).toBe(false);
  });

  // The retry is the exact API call: `gh stack link 7 42` reads 7 as a PR on gh-stack before add mode.
  it.each([
    [
      pull(41, 'feat/a', { number: 7, position: 2, size: 2 }),
      "ship: adding to stack #7 failed; #42 is open but not stacked. Retry: gh api -X POST repos/Acme/App/stacks/7/add -F 'pull_requests[]=42'",
    ],
    [
      pull(41, 'main'),
      "ship: creating the stack failed; #42 is open but not stacked. Retry: gh api -X POST repos/Acme/App/stacks -F 'pull_requests[]=41' -F 'pull_requests[]=42'",
    ],
  ])('reports a rejected POST with the exact call to retry by hand', (parent, line) => {
    const { gh } = fakeGh({ [OWN]: ok(pull(42, 'feat/b')), [LIST]: ok([parent]) });
    expect(linkStack('acme/app', 42, gh)).toEqual({ outcome: 'failed', lines: [line] });
  });

  it('reports JSON of an unexpected shape instead of reading it as no parent', () => {
    const drift = { status: 0, stdout: '{"number":"42"}' };
    expect(linkStack('acme/app', 42, fakeGh({ [OWN]: drift }).gh).lines[0]).toMatch(
      /reading #42 failed/,
    );
  });

  it('reports a failed read, and treats empty or foreign output as nothing to do', () => {
    expect(linkStack('acme/app', 42, fakeGh({}).gh).lines[0]).toMatch(/reading #42 failed/);
    expect(linkStack('acme/app', 42, fakeGh({ [OWN]: { status: 0, stdout: '' } }).gh).outcome).toBe(
      'none',
    );
    const url = { status: 0, stdout: 'https://github.com/acme/app/pull/42\n' };
    expect(linkStack('acme/app', 42, fakeGh({ [OWN]: url }).gh).outcome).toBe('none');
  });
});

describe('recordStackEvent', () => {
  const events = () => join(mkdtempSync(join(tmpdir(), 'stack-events-')), 'events.jsonl');

  it('appends a ship_stack row joined to the ship id', () => {
    const file = events();
    const result = { outcome: 'created' as const, lines: [], parent: 41, stack: 7 };
    recordStackEvent(result, 42, { DEVKIT_GATE_EVENTS: file, DEVKIT_SHIP_ID: 'ship-1' });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      type: 'ship_stack',
      ship_id: 'ship-1',
      pr_number: 42,
      parent_pr: 41,
      stack_number: 7,
      outcome: 'created',
    });
  });

  it('writes nothing for the common no-parent case', () => {
    const file = events();
    recordStackEvent({ outcome: 'none', lines: [] }, 42, {
      DEVKIT_GATE_EVENTS: file,
      DEVKIT_SHIP_ID: 's',
    });
    expect(() => readFileSync(file, 'utf8')).toThrow();
  });
});
