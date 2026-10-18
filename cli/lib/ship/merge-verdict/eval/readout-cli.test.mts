import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { renderEvidenceBlock } from '../../evidence/block.mts';
import { inconclusive } from '../../evidence/outcome.mts';

const CLI = fileURLToPath(new URL('./readout-cli.mts', import.meta.url));
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

// Answers each gh call from <dir>/<key>.json and logs it; an unanswered call fails like gh does.
const FAKE_GH = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2).join(' ');
const dir = process.env.FAKE_GH_DIR;
fs.appendFileSync(path.join(dir, 'calls.log'), args + '\\n');
const sha = /commits\\/(\\w+)\\/check-runs/.exec(args)?.[1];
const key = args.startsWith('api graphql') ? (args.includes('after=c1') ? 'page2' : 'page1')
  : args.startsWith('pr list') ? 'merged' : args.startsWith('repo view') ? 'repo'
  : sha ? 'checks-' + sha : 'unknown';
const file = path.join(dir, key + '.json');
if (!fs.existsSync(file)) { process.stderr.write('fake gh: no answer for ' + key + '\\n'); process.exit(1); }
process.stdout.write(fs.readFileSync(file, 'utf8'));
`;

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const body = (head: string) =>
  renderEvidenceBlock(inconclusive('x', head, null), null, {
    line: 'auto-merge-eligible',
    verdict: { verdict: 'auto-merge-eligible', reasons: [{ code: 'captured-proof' }] },
  });

const node = (number: number, state: string, head: string) => ({
  number,
  state,
  title: `fix: pr ${number}`,
  body: body(head),
  headRefName: `me/sc-${number}/x`,
  headRefOid: head,
  mergedAt: state === 'MERGED' ? '2026-10-12T00:00:00Z' : null,
  mergeCommit: null,
  files: { nodes: [{ path: 'cli/a.mts' }] },
  userContentEdits: { totalCount: 0, nodes: [] },
});

const page = (nodes: unknown[], hasNextPage: boolean) => ({
  data: { search: { issueCount: 2, pageInfo: { hasNextPage, endCursor: 'c1' }, nodes } },
});

/** Each answer is gh's stdout for one call key. */
function fakeGh(answers: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'verdict-readout-'));
  roots.push(dir);
  writeFileSync(join(dir, 'gh'), FAKE_GH);
  chmodSync(join(dir, 'gh'), 0o755);
  for (const [key, value] of Object.entries(answers)) {
    writeFileSync(join(dir, `${key}.json`), value);
  }
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, FAKE_GH_DIR: dir, PATH: `${dir}:${process.env.PATH}` },
    });
  const calls = () => readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n');
  return { run, calls };
}

const ANSWERS = {
  repo: 'owner/repo\n',
  page1: JSON.stringify(page([node(1, 'MERGED', A)], true)),
  page2: JSON.stringify(page([node(2, 'OPEN', B)], false)),
  merged: JSON.stringify([
    {
      number: 3,
      title: 'fix: again',
      body: 'after #1',
      mergedAt: '2026-10-13T00:00:00Z',
      files: [{ path: 'cli/a.mts' }],
    },
  ]),
  [`checks-${A}`]: JSON.stringify({
    check_runs: [
      {
        name: 'required',
        status: 'completed',
        conclusion: 'success',
        completed_at: '2026-10-12T00:00:00Z',
      },
    ],
  }),
} satisfies Record<string, string>;

describe('readout-cli', () => {
  it('pages the search, reads CI only for decided PRs and prints the readout', () => {
    const gh = fakeGh(ANSWERS);
    const result = gh.run();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('| auto-merge-eligible | 1 | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 1 |');
    expect(result.stdout).toContain('- #1 → #3 fix: again');
    const calls = gh.calls();
    expect(calls.filter((call) => call.startsWith('api graphql'))).toHaveLength(2);
    expect(calls.filter((call) => call.includes('/check-runs'))).toEqual([
      `api repos/owner/repo/commits/${A}/check-runs?per_page=100`,
    ]);
    expect(calls).toContainEqual(expect.stringContaining('--search merged:>=2026-10-12'));
  });

  it('scores a PR once when two search pages both return it', () => {
    const twice = JSON.stringify(page([node(1, 'MERGED', A), node(2, 'OPEN', B)], false));
    const result = fakeGh({ ...ANSWERS, page2: twice }).run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('first printed verdict: 2 PRs;');
  });

  it('ends non-zero naming the failure when a gh call fails', () => {
    const { [`checks-${A}`]: _missing, ...rest } = ANSWERS;
    const result = fakeGh(rest).run('--repo', 'owner/repo');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('fake gh: no answer for checks-');
    expect(result.stderr).toContain('verdict readout:');
    expect(result.stdout).toBe('');
  });

  it('refuses a window that is not a positive whole number of days', () => {
    const result = fakeGh(ANSWERS).run('--repo', 'owner/repo', '--days', '0');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--days must be a positive integer');
  });
});
