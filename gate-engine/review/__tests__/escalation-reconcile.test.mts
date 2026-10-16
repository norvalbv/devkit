/** The escalation re-judges the first pass's failed checklist rows: what it overturns is gone from the
 * findings, what it confirms or adds stays, and what it never touches keeps the first pass's issues. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveGuardConfig } from '../../config.mts';
import { escalatePrompt, reopenFailedItems, restoreUnjudgedItems } from '../cascade/escalation.mts';
import { runCascade } from '../cascade/reviewer.mts';
import { REVIEWERS } from '../reviewers.mts';
import type { ChecklistState } from '../runtime.mts';
import { cleanupReviewFixtures, consumerRepo, mkExec } from './run-review-fixtures.mts';

const reviewer = REVIEWERS.find((r) => r.name === 'backend-performance-reviewer')!;
const commitGuard = REVIEWERS.find((r) => r.name === 'commit-guard')!;
afterEach(() => cleanupReviewFixtures());

type Row = { name: string; status: string; issues: string[] };
const row = (name: string, status: string, issues: string[] = []): Row => ({
  name,
  status,
  issues,
});
const read = (repo: string): { items: Row[] } =>
  JSON.parse(readFileSync(join(repo, reviewer.stateFile!), 'utf8'));
const write = (repo: string, items: Row[]): void =>
  writeFileSync(join(repo, reviewer.stateFile!), JSON.stringify({ items }));

/** Mirrors checklist-store's checkItem: --pass clears the issues, --fail appends one. */
function mark(repo: string, name: string, issue: string | null): void {
  const state = read(repo);
  const item = state.items.find((i) => i.name === name)!;
  item.status = issue === null ? 'pass' : 'fail';
  if (issue === null) item.issues = [];
  else item.issues.push(issue);
  write(repo, state.items);
}

type Step = (repo: string) => string | null;
async function cascade(first: Step, escalation: Step) {
  const repo = consumerRepo({ backend: true });
  const exec = mkExec(async ({ label }: { label: string }) =>
    label.endsWith(':escalate') ? escalation(repo) : first(repo),
  );
  const res = await runCascade(
    { reviewer, files: ['src/main/db.ts'] },
    {
      cwd: repo,
      cfg: resolveGuardConfig(repo),
      exec,
      firstModel: 'sonnet',
      escalationModel: 'opus',
    },
  );
  const issues = Object.fromEntries((res.items ?? []).map((i) => [i.lens, i.issues ?? []]));
  return { res, exec, issues };
}

const firstFailsTwo: Step = (repo) => {
  write(repo, [
    row('n-plus-one', 'fail', ['src/main/db.ts:1 — query in a loop']),
    row('caching', 'fail', ['src/main/db.ts:1 — no cache']),
    row('pagination', 'pass'),
  ]);
  return 'two issues\nVERDICT: FAIL — two';
};

describe('escalation reconciles the first pass', () => {
  it('drops an overturned issue and keeps the confirmed one', async () => {
    const { res, exec, issues } = await cascade(firstFailsTwo, (repo) => {
      mark(repo, 'n-plus-one', 'src/main/db.ts:1 — query in a loop (confirmed)');
      mark(repo, 'caching', null);
      return 'VERDICT: FAIL — n-plus-one holds';
    });
    expect(res.status).toBe('fail');
    expect(issues['n-plus-one']).toEqual(['src/main/db.ts:1 — query in a loop (confirmed)']);
    expect(issues.caching).toEqual([]);
    expect(res.items?.find((i) => i.lens === 'caching')?.status).toBe('pass');
    const prompt = exec.mock.calls[1][0].args[1];
    expect(prompt).toContain('(n-plus-one, caching) were reset to pending');
  });

  it('keeps an issue the escalation adds on a row the first pass passed', async () => {
    const { res, issues } = await cascade(
      (repo) => {
        write(repo, [row('n-plus-one', 'fail', ['loop query']), row('pagination', 'pass')]);
        return 'VERDICT: FAIL — one';
      },
      (repo) => {
        mark(repo, 'n-plus-one', 'loop query');
        mark(repo, 'pagination', 'unbounded list');
        return 'VERDICT: FAIL — two';
      },
    );
    expect(res.status).toBe('fail');
    expect(issues).toEqual({ 'n-plus-one': ['loop query'], pagination: ['unbounded list'] });
  });

  it('restores the first pass rows when the escalation goes dark', async () => {
    const { res, issues } = await cascade(firstFailsTwo, () => null);
    expect(res.status).toBe('inconclusive');
    expect(issues['n-plus-one']).toEqual(['src/main/db.ts:1 — query in a loop']);
    expect(issues.caching).toEqual(['src/main/db.ts:1 — no cache']);
  });

  it('a FAIL whose check commands were all refused keeps the first pass issues, once each', async () => {
    const { res, issues } = await cascade(firstFailsTwo, () => 'VERDICT: FAIL — holds');
    expect(res.status).toBe('fail');
    expect(issues).toEqual({
      'n-plus-one': ['src/main/db.ts:1 — query in a loop'],
      caching: ['src/main/db.ts:1 — no cache'],
      pagination: [],
    });
  });

  it('a PASS that overturns every reopened row clears the block', async () => {
    const { res } = await cascade(firstFailsTwo, (repo) => {
      mark(repo, 'n-plus-one', null);
      mark(repo, 'caching', null);
      return 'VERDICT: PASS — both were false alarms';
    });
    expect(res.status).toBe('pass');
    expect(res.items?.every((i) => i.status === 'pass' && !i.issues?.length)).toBe(true);
  });

  it('a first pass that left no artifact gets the plain prompt and no fabricated artifact', async () => {
    let artifactDuringEscalation: boolean | null = null;
    const { res, exec } = await cascade(
      () => 'VERDICT: FAIL — no checklist written',
      (repo) => {
        artifactDuringEscalation = existsSync(join(repo, reviewer.stateFile!));
        return 'VERDICT: FAIL — holds';
      },
    );
    expect(artifactDuringEscalation).toBe(false);
    expect(exec.mock.calls[1][0].args[1]).not.toContain('reset to pending');
    expect(res.status).toBe('fail');
  });

  it('a PASS that never re-judges a reopened row still hits the failed-items hole', async () => {
    const { res, issues } = await cascade(firstFailsTwo, (repo) => {
      mark(repo, 'caching', null);
      return 'VERDICT: PASS — fine';
    });
    expect(res.status).toBe('inconclusive');
    expect(res.reason).toContain('FAILED item(s) but the verdict says PASS: n-plus-one');
    expect(issues['n-plus-one']).toEqual(['src/main/db.ts:1 — query in a loop']);
  });

  it('archives both passes under their models and keeps the escalation as the transcript', async () => {
    const { res } = await cascade(firstFailsTwo, (repo) => {
      mark(repo, 'n-plus-one', 'confirmed');
      mark(repo, 'caching', null);
      return 'escalation notes\nVERDICT: FAIL — holds';
    });
    expect(res.transcript).toBe('escalation notes\nVERDICT: FAIL — holds');
    expect(res.fullTranscript).toBe(
      '─── first pass · sonnet ───\ntwo issues\nVERDICT: FAIL — two\n\n' +
        '─── escalation · opus ───\nescalation notes\nVERDICT: FAIL — holds',
    );
  });
});

describe('reopen / restore on a commit-guard files[] artifact', () => {
  it('reopens failed files and restores only the ones left pending', () => {
    const repo = consumerRepo();
    const file = join(repo, commitGuard.stateFile!);
    const files = [
      { path: 'src/a.ts', status: 'fail', issues: ['dup of x', 'dup of y'] },
      { path: 'src/b.ts', status: 'fail', issues: ['dup of z'] },
      { path: 'src/c.ts', status: 'pass', issues: [] },
    ];
    writeFileSync(file, JSON.stringify({ files }));
    const snapshot = reopenFailedItems(repo, commitGuard);
    const state = (): ChecklistState => JSON.parse(readFileSync(file, 'utf8'));
    expect(state().files?.map((f) => f.status)).toEqual(['pending', 'pending', 'pass']);
    writeFileSync(
      file,
      JSON.stringify({
        files: [
          { ...files[0], issues: ['dup of x'] },
          { ...files[1], status: 'pending', issues: [] },
          files[2],
        ],
      }),
    );
    restoreUnjudgedItems(repo, commitGuard, snapshot);
    expect(state().files).toEqual([{ ...files[0], issues: ['dup of x'] }, files[1], files[2]]);
  });
});

it('escalatePrompt says nothing about reset rows when none were reopened', () => {
  expect(escalatePrompt('brief', 'notes')).not.toContain('reset to pending');
});
