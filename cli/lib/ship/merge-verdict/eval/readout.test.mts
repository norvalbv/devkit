import { describe, expect, it } from 'vitest';
import { renderEvidenceBlock } from '../../evidence/block.mts';
import { inconclusive } from '../../evidence/outcome.mts';
import { parseSearchPage } from './readout-cli.mts';
import {
  ciAt,
  firstVerdict,
  renderReadout,
  scorePulls,
  type CheckRun,
  type MergedPull,
  type VerdictPull,
} from './readout.mts';
import type { MergeVerdict } from '../verdict.mts';

const REPO = 'owner/repo';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const ELIGIBLE: MergeVerdict = {
  verdict: 'auto-merge-eligible',
  reasons: [{ code: 'captured-proof' }],
};
const REVIEW: MergeVerdict = {
  verdict: 'human-review',
  reasons: [{ code: 'decision-record' }, { code: 'over-size' }],
};

const body = (head: string, verdict?: MergeVerdict): string =>
  `Summary\n\n${renderEvidenceBlock(inconclusive('x', head, null), null, verdict && { line: verdict.verdict, verdict })}\n`;

function pull(overrides: Partial<VerdictPull> = {}): VerdictPull {
  return {
    number: 10,
    state: 'MERGED',
    title: 'fix(ship): thing',
    headRefName: 'me/sc-42/thing',
    headRefOid: A,
    mergedAt: '2026-10-12T00:00:00Z',
    mergeOid: 'm'.repeat(40),
    files: ['cli/lib/a.mts', 'cli/lib/a.test.mts'],
    bodies: [body(A, ELIGIBLE)],
    ...overrides,
  };
}

function later(overrides: Partial<MergedPull> = {}): MergedPull {
  return {
    number: 20,
    title: 'fix(ship): follow-up',
    body: 'Fixes what #10 broke.',
    mergedAt: '2026-10-13T00:00:00Z',
    files: ['cli/lib/a.mts'],
    ...overrides,
  };
}

const green = () => 'green' as const;
/** Past every fixture's follow-up window, so no row reads as still open. */
const NOW = Date.parse('2026-11-01T00:00:00Z');
const score = (pulls: VerdictPull[], merged: MergedPull[] = [], now = NOW) =>
  scorePulls(pulls, merged, green, REPO, 14, now);

const run = (
  name: string,
  conclusion: string,
  completed_at = '2026-10-12T00:00:00Z',
): CheckRun => ({
  name,
  status: 'completed',
  conclusion,
  completed_at,
});

describe('firstVerdict', () => {
  it('scores the earliest body that carried a verdict, not the latest rewrite', () => {
    const first = firstVerdict(['no block yet', body(A), body(B, REVIEW), body(C, ELIGIBLE)]);
    expect(first).toEqual({
      verdict: 'human-review',
      reasons: ['decision-record', 'over-size'],
      headSha: B,
      status: 'inconclusive',
    });
  });

  it('reads an empty verdict slot as no verdict', () => {
    expect(firstVerdict([body(A)])).toBeUndefined();
  });
});

describe('ciAt', () => {
  it('reads a superseded run as cancelled although its required check failed', () => {
    expect(ciAt([run('required', 'failure'), run('gate', 'cancelled')])).toBe('cancelled');
  });

  it('reads a failed gate as red, a green required as green, and no aggregate check as absent', () => {
    expect(ciAt([run('required', 'failure'), run('gate', 'failure')])).toBe('red');
    expect(ciAt([run('gate', 'timed_out')])).toBe('red');
    expect(ciAt([run('required', 'success'), run('gate', 'success')])).toBe('green');
    expect(ciAt([run('lint', 'success')])).toBe('absent');
  });

  it('lets the latest completed run of a name decide', () => {
    const runs = [
      run('gate', 'failure', '2026-10-12T00:00:00Z'),
      run('gate', 'success', '2026-10-12T01:00:00Z'),
    ];
    expect(ciAt([...runs, run('required', 'success', '2026-10-12T01:00:00Z')])).toBe('green');
  });
});

describe('scorePulls', () => {
  it('keeps PRs with no verdict out of the rows', () => {
    const { rows, noVerdict } = score([pull({ bodies: [body(A)] })]);
    expect(rows).toEqual([]);
    expect(noVerdict).toEqual([10]);
  });

  it('marks a head that moved after the first verdict, and reads CI at the verdict head', () => {
    const asked: string[] = [];
    const ci = (sha: string) => (asked.push(sha), 'red' as const);
    const merged = pull({ headRefOid: C, bodies: [body(A, ELIGIBLE), body(B, REVIEW)] });
    const [row] = scorePulls([merged], [], ci, REPO, 14, NOW).rows;
    expect(row).toMatchObject({ headMoved: true, ci: 'red', first: { headSha: A } });
    expect(asked).toEqual([A]);
  });

  it('counts an open PR as censored and asks no CI for it', () => {
    const ci = () => {
      throw new Error('no CI read for an open PR');
    };
    const [row] = scorePulls(
      [pull({ state: 'OPEN', mergedAt: null })],
      [later()],
      ci,
      REPO,
      14,
      NOW,
    ).rows;
    expect(row).toMatchObject({ outcome: 'open', ci: 'absent', followUps: [] });
  });

  it('takes a later fix that cites the PR and shares a source file as a follow-up candidate', () => {
    const [row] = score([pull()], [later()]).rows;
    expect(row.followUps).toEqual([
      { pull: 20, title: 'fix(ship): follow-up', context: expect.stringContaining('#10') },
    ]);
  });

  it('links a later fix through the story id in the original branch', () => {
    const [row] = score([pull()], [later({ body: 'Second pass on sc-42.' })]).rows;
    expect(row.followUps.map((next) => next.pull)).toEqual([20]);
  });

  it.each([
    ['a non-fix type', { title: 'feat(ship): builds on it' }],
    ['only a shared test file', { files: ['cli/lib/a.test.mts'] }],
    ['a longer number', { body: 'Overlap with #101.' }],
    ['a path segment', { body: 'see pull/10 and a#10' }],
    ['a merge past the window', { mergedAt: '2026-10-27T00:00:01Z' }],
    ['a merge before the PR', { mergedAt: '2026-10-11T00:00:00Z' }],
  ])('takes no candidate from %s', (_label, overrides) => {
    expect(score([pull()], [later(overrides)]).rows[0].followUps).toEqual([]);
  });

  it('scores a closed PR as a problem with no follow-up or revert window', () => {
    const closed = pull({ state: 'CLOSED', mergedAt: null, mergeOid: null });
    const readout = score([closed], [later(), later({ title: 'Revert "fix(ship): thing"' })]);
    expect(readout.rows[0]).toMatchObject({ outcome: 'closed', reverted: false, followUps: [] });
    expect(renderReadout(readout)).toContain(
      '| auto-merge-eligible | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 1/1 = 100% [21%, 100%] |',
    );
  });

  it('marks a merge whose follow-up window has not closed yet', () => {
    const merged = Date.parse('2026-10-12T00:00:00Z');
    const day = 24 * 60 * 60 * 1000;
    expect(score([pull()], [], merged + 13 * day).rows[0].windowOpen).toBe(true);
    expect(score([pull()], [], merged + 15 * day).rows[0].windowOpen).toBe(false);
    expect(score([pull({ state: 'OPEN', mergedAt: null })], [], merged).rows[0].windowOpen).toBe(
      false,
    );
    const text = renderReadout(score([pull()], [], merged + day));
    expect(text).toContain('1 merged PR is still inside its follow-up window');
  });

  it.each([
    ['the revert title', { title: 'Revert "fix(ship): thing"', body: '' }],
    ['the revert button body', { title: 'chore: undo', body: `Reverts ${REPO}#10` }],
    [
      'the reverted merge sha',
      { title: 'chore: undo', body: `This reverts commit ${'m'.repeat(40)}.` },
    ],
  ])('detects a revert by %s', (_label, overrides) => {
    expect(score([pull()], [later({ files: [], ...overrides })]).rows[0].reverted).toBe(true);
  });

  it('matches the revert line whatever case the repo is typed in', () => {
    const undo = later({ title: 'chore: undo', body: 'Reverts Owner/Repo#10', files: [] });
    expect(score([pull()], [undo]).rows[0].reverted).toBe(true);
  });

  it('takes no revert of a longer PR number for this one', () => {
    const other = later({ title: 'chore: undo', body: `Reverts ${REPO}#101`, files: [] });
    expect(score([pull()], [other]).rows[0].reverted).toBe(false);
  });
});

describe('renderReadout', () => {
  it('prints counts and a Wilson interval per class, reason and candidate', () => {
    const readout = score(
      [
        pull(),
        pull({ number: 11, headRefOid: B }),
        pull({ number: 12, state: 'OPEN', mergedAt: null }),
        pull({ number: 13, state: 'OPEN', mergedAt: null, bodies: [body(A, REVIEW)] }),
      ],
      [later()],
    );
    const text = renderReadout({ ...readout, noVerdict: [9] });
    expect(text).toContain('first printed verdict: 4 PRs; 1 carry no verdict.');
    expect(text).not.toContain('still inside');
    expect(text).toContain(
      '| auto-merge-eligible | 2 | 1 | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 1/2 = 50% [9%, 91%] |',
    );
    expect(text).toContain('| captured-proof | 2 | 1 |');
    expect(text).toContain('| human-review | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a |');
    expect(text).not.toContain('| policy |');
    expect(text).toContain(
      '- #10 → #20 fix(ship): follow-up: …fix(ship): follow-up Fixes what #10 broke.…',
    );
  });
});

describe('parseSearchPage', () => {
  const node = {
    number: 7,
    state: 'MERGED',
    title: 't',
    body: 'current',
    headRefName: 'b',
    headRefOid: A,
    mergedAt: '2026-10-12T00:00:00Z',
    mergeCommit: { oid: B },
    files: { nodes: [{ path: 'x.mts' }] },
    userContentEdits: {
      totalCount: 2,
      nodes: [
        { diff: 'newest', deletedAt: null },
        { diff: 'oldest', deletedAt: null },
      ],
    },
  };
  const page = (nodes: unknown[], hasNextPage = true, issueCount = 336) =>
    JSON.stringify({
      data: { search: { issueCount, pageInfo: { hasNextPage, endCursor: 'c1' }, nodes } },
    });

  it('orders edits oldest first, skips non-PR nodes, and returns the next cursor', () => {
    const { pulls, next } = parseSearchPage(page([node, {}]));
    expect(next).toBe('c1');
    expect(pulls).toEqual([
      expect.objectContaining({
        number: 7,
        mergeOid: B,
        files: ['x.mts'],
        bodies: ['oldest', 'newest', 'current'],
      }),
    ]);
  });

  it('uses the current body for an unedited PR and stops on the last page', () => {
    const unedited = { ...node, userContentEdits: { totalCount: 0, nodes: [] } };
    const { pulls, next } = parseSearchPage(page([unedited], false));
    expect(pulls[0].bodies).toEqual(['current']);
    expect(next).toBeNull();
  });

  it("refuses a search past GitHub's 1000-result cap instead of scoring a silent subset", () => {
    expect(() => parseSearchPage(page([node], true, 1001))).toThrow('1001 PRs match');
  });

  it('refuses a PR with a deleted body revision instead of scoring a later one', () => {
    const edits = [
      { diff: 'newest', deletedAt: null },
      { diff: null, deletedAt: '2026-10-13T00:00:00Z' },
    ];
    const deleted = { ...node, userContentEdits: { totalCount: 2, nodes: edits } };
    expect(() => parseSearchPage(page([deleted]))).toThrow('#7 has a deleted body revision');
  });

  it('skips an edit that emptied the body, as on PR #998', () => {
    const edits = [
      { diff: 'newest', deletedAt: null },
      { diff: null, deletedAt: null },
    ];
    const emptied = { ...node, userContentEdits: { totalCount: 2, nodes: edits } };
    expect(parseSearchPage(page([emptied])).pulls[0].bodies).toEqual(['newest', 'current']);
  });

  it('refuses a malformed pull request node instead of dropping it', () => {
    const { headRefOid: _dropped, ...broken } = node;
    expect(() => parseSearchPage(page([broken]))).toThrow();
  });

  it('refuses a PR whose earliest edits fall past the first page', () => {
    const many = { ...node, userContentEdits: { ...node.userContentEdits, totalCount: 101 } };
    expect(() => parseSearchPage(page([many]))).toThrow('more than 100 body edits');
  });
});
