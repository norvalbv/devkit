import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  lintFamilies,
  loadFamilies,
  type Span,
  verdictReachable,
} from '../eval/workflow/families.mts';
import { materializeWorkspace, snapshotDir } from '../eval/workflow/materialize.mts';
import { member, type PinnedRepo, pinnedRepo, snapshot as snap } from './workflow-fixtures.mts';

// Spawned below, so vitest's related-tests must see the edge.
void (() => import('../eval/bench.mts'));

describe('workflow family lint', () => {
  it('the committed families pass, with every family carrying a natural member', () => {
    const members = loadFamilies();
    expect(members.length).toBe(5);
    expect(new Set(members.map((m) => m.caseId)).size).toBe(3);
  });

  it('bench.mts coverage prints the workflow plan with no LLM call and no network', () => {
    const bench = path.join(import.meta.dirname, '../eval/bench.mts');
    for (const args of [['coverage'], ['workflow', 'coverage']]) {
      const run = spawnSync(process.execPath, [bench, ...args], { encoding: 'utf8' });
      expect(run.status).toBe(0);
      expect(run.stdout).toMatch(
        /prior-art workflow: 3 families · 5 tasks · 2 conditions · K=1 → 10 sessions/,
      );
    }
  });

  it('refuses an expectation the response contract cannot accept for the layout', () => {
    // GENUINE_NEW_WORK needs a reached local leg; an empty refs/ resolves nothing.
    expect(verdictReachable(member({ refs: [] }), 'GENUINE_NEW_WORK')).toBe(false);
    expect(verdictReachable(member(), 'GENUINE_NEW_WORK')).toBe(true);
    const errors = lintFamilies([member({ refs: [] })]);
    expect(errors.join()).toMatch(/GENUINE_NEW_WORK is contract-unreachable/);
  });

  it('holds a broken-tool member to INSUFFICIENT_EVIDENCE with no gold-bearing external content', () => {
    const base = { kind: 'artificial' as const, refs: [], expectFraming: [] };
    const twin = member({ ...base, id: 'm2', expectVerdict: ['INSUFFICIENT_EVIDENCE'] });
    expect(lintFamilies([member(), twin])).toEqual([]);
    const leaky = member({
      ...twin,
      external: [
        { leg: 'github', source: 'https://example.test/pr/1', text: 'the fix', gold: true },
      ],
    });
    expect(lintFamilies([member(), leaky]).join()).toMatch(/gold-bearing external content/);
    const solved = member({ ...twin, expectVerdict: ['SOLVED_ELSEWHERE'] });
    expect(lintFamilies([member(), solved]).join()).toMatch(/expects only INSUFFICIENT_EVIDENCE/);
  });

  it('refuses abbreviated pins, a span on an absent root, and a family with no natural member', () => {
    const short = JSON.stringify(member({ consumer: { ...snap('c'), sha: 'abc1234' } }));
    expect(() => loadFamilies(short)).toThrow(/full 40-hex object id/);
    const span: Span = { root: 'nowhere', path: 'a.ts', lines: [1, 2] };
    const absent = member({ gold: [{ id: 'g', desc: 'd', spans: [span] }] });
    expect(lintFamilies([absent]).join()).toMatch(/span root "nowhere" absent/);
    const orphan = member({
      kind: 'artificial',
      refs: [],
      expectVerdict: ['INSUFFICIENT_EVIDENCE'],
    });
    expect(lintFamilies([orphan]).join()).toMatch(/family fam: needs a natural member/);
  });
});

describe('snapshot materialisation', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function repoWithCommit(): PinnedRepo {
    const pinned = pinnedRepo({
      'guard.config.json': '{"maxLines": 500}\n',
      'a.ts': 'export const a = 1;\n',
    });
    dirs.push(pinned.repo);
    return pinned;
  }

  const cache = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wf-cache-'));
    dirs.push(dir);
    return dir;
  };

  it('archives the pinned commit and builds a workspace that declares ../refs/*', () => {
    const { repo, pin: pinned } = repoWithCommit();
    const opts = { cacheRoot: cache(), sourceRepo: repo };
    expect(readFileSync(path.join(snapshotDir(pinned, opts), 'a.ts'), 'utf8')).toContain('a = 1');
    const ws = materializeWorkspace(member({ consumer: pinned, refs: [] }), opts);
    dirs.push(ws.root);
    const config = JSON.parse(readFileSync(path.join(ws.consumer, 'guard.config.json'), 'utf8'));
    expect(config).toEqual({ maxLines: 500, research: { referenceCheckouts: ['../refs/*'] } });
    expect(existsSync(ws.refs)).toBe(true);
  });

  it('keeps a relative symlink relative, so it never points out of the workspace at the shared cache', () => {
    // t3code's CLAUDE.md is a symlink to AGENTS.md; a copy that resolved it would leak the cache path.
    const pinned = pinnedRepo({ 'AGENTS.md': 'rules\n' }, { 'CLAUDE.md': 'AGENTS.md' });
    dirs.push(pinned.repo);
    const opts = { cacheRoot: cache(), sourceRepo: pinned.repo };
    const ws = materializeWorkspace(member({ consumer: pinned.pin, refs: [pinned.pin] }), opts);
    dirs.push(ws.root);
    expect(readlinkSync(path.join(ws.consumer, 'CLAUDE.md'))).toBe('AGENTS.md');
    expect(readlinkSync(path.join(ws.refs, 'src', 'CLAUDE.md'))).toBe('AGENTS.md');
  });

  it('aborts on a tree mismatch and on an unreachable commit, never falling back to a head', () => {
    const { repo, pin } = repoWithCommit();
    const opts = { cacheRoot: cache(), sourceRepo: repo };
    expect(() => snapshotDir({ ...pin, tree: 'c'.repeat(40) }, opts)).toThrow(
      /has tree .* pinned c{40}/,
    );
    expect(() =>
      snapshotDir(
        { name: 'gone', url: `file://${repo}`, sha: 'd'.repeat(40), tree: 'c'.repeat(40) },
        opts,
      ),
    ).toThrow(/unreachable/);
  });
});
