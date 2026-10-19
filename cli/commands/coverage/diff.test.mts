/** `devkit coverage-diff` against real git repos and real `devkit coverage-run` manifests. */
import { rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupRepos,
  gate,
  git,
  measure,
  repo,
  type Thresholds,
  write,
} from '../../../gate-engine/coverage/__tests__/_provenance-fixtures.mts';
import { snapshotSource } from '../../../gate-engine/coverage/provenance.mts';
import coverageDiff from './diff.mts';

let savedBase: string | undefined;
beforeEach(() => {
  // A host-set base would silently redirect every default-base assertion below.
  savedBase = process.env.DEVKIT_BASE_REF;
  delete process.env.DEVKIT_BASE_REF;
});
afterEach(() => {
  if (savedBase === undefined) delete process.env.DEVKIT_BASE_REF;
  else process.env.DEVKIT_BASE_REF = savedBase;
  cleanupRepos();
  vi.restoreAllMocks();
});

function run(cwd: string, ...args: string[]) {
  const lines: string[] = [];
  const capture = (...a: unknown[]) => {
    lines.push(a.join(' '));
  };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
  const code = coverageDiff(args, cwd);
  vi.restoreAllMocks();
  return { code, out: lines.join('\n') };
}

/** An istanbul artifact: repo-relative path → [startLine, hits] statements, keyed under `root`. */
function cov(root: string, files: Record<string, [number, number][]>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(files).map(([rel, stmts]) => [
        join(root, rel),
        {
          statementMap: Object.fromEntries(
            stmts.map(([l], i) => [String(i), { start: { line: l } }]),
          ),
          s: Object.fromEntries(stmts.map(([, h], i) => [String(i), h])),
          f: {},
          b: {},
        },
      ]),
    ),
  );
}

const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i + 1}`).join('\n') + '\n';

const commitAll = (root: string, msg = 'c') => {
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', msg);
};

/** repo() on main, its src/a.mts seeded with `l1`, an origin/main tracking ref, then a feature
 * branch cut from it. */
function featureRepo(pkg = '', coverage: Thresholds = {}) {
  const r = repo(pkg, coverage);
  write(r.root, pkg ? `${pkg}/src/a.mts` : 'src/a.mts', lines(1));
  commitAll(r.root, 'seed');
  git(r.root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(r.root, 'switch', '-q', '-c', 'feature');
  return r;
}

describe('devkit coverage-diff — what counts as added', () => {
  it('counts committed, staged and unstaged additions since the default merge-base, and only those', () => {
    const { root } = featureRepo();
    write(root, 'src/a.mts', lines(4)); // line 1 pre-existing; 2-4 committed on the branch
    commitAll(root);
    write(root, 'src/a.mts', lines(5));
    git(root, 'add', '-A'); // line 5 staged
    write(root, 'src/a.mts', lines(6)); // line 6 unstaged
    // line 1: pre-existing and uncovered — must not dilute. line 4: comment, no statement.
    measure(
      root,
      snapshotSource(root),
      cov(root, {
        'src/a.mts': [
          [1, 0],
          [2, 1],
          [3, 0],
          [5, 1],
          [6, 1],
        ],
      }),
    );

    const { code, out } = run(root);
    expect(code).toBe(0);
    expect(out).toMatch(/since main \(merge-base [0-9a-f]{12}\)/);
    expect(out).toMatch(/3\/4\s+75\.0%\s+src\/a\.mts\s+uncovered: 3/);
    expect(out).toContain('Total: 3/4 added executable lines covered (75.0%).');
    expect(out).not.toMatch(/stale|provenance unknown/);
  });

  it('reports NEW-side line numbers when deletions above shift the file', () => {
    const { root } = featureRepo();
    write(root, 'src/b.mts', lines(6));
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'b');
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    // drop old lines 1-3, append two: new file is l4 l5 l6 x y → added lines 4-5
    write(root, 'src/b.mts', 'l4\nl5\nl6\nx\ny\n');
    measure(
      root,
      snapshotSource(root),
      cov(root, {
        'src/b.mts': [
          [1, 0],
          [4, 0],
          [5, 1],
        ],
      }),
    );

    const { out } = run(root);
    expect(out).toMatch(/1\/2\s+50\.0%\s+src\/b\.mts\s+uncovered: 4$/m);
  });

  it('counts every executable line of an untracked source file, and handles a path with spaces', () => {
    const { root } = featureRepo();
    write(root, 'src/my file.mts', lines(3));
    measure(
      root,
      snapshotSource(root),
      cov(root, {
        'src/my file.mts': [
          [1, 1],
          [3, 0],
        ],
      }),
    );

    const { out } = run(root);
    expect(out).toMatch(/1\/2\s+50\.0%\s+src\/my file\.mts\s+uncovered: 3/);
  });

  it('lists changed source the artifact never measured, outside the totals; tests and non-source are not listed', () => {
    const { root } = featureRepo();
    write(root, 'src/a.mts', lines(2));
    write(root, 'src/unmeasured.mts', lines(2));
    write(root, 'src/a.test.mts', lines(3));
    write(root, 'notes.txt', 'x\n');
    measure(root, snapshotSource(root), cov(root, { 'src/a.mts': [[2, 1]] }));

    const { out } = run(root);
    expect(out).toContain('Total: 1/1');
    expect(out).toMatch(/Not measured[^\n]*\n\s+src\/unmeasured\.mts$/m);
    expect(out).not.toContain('a.test.mts');
    expect(out).not.toContain('notes.txt');
  });

  it('counts a measured file whatever sourceExtensions says (a .mjs in an mts-only repo)', () => {
    const { root } = featureRepo();
    write(root, 'tool/run.mjs', lines(2));
    measure(
      root,
      snapshotSource(root),
      cov(root, {
        'tool/run.mjs': [
          [1, 1],
          [2, 1],
        ],
      }),
    );
    expect(run(root).out).toMatch(/2\/2\s+100\.0%\s+tool\/run\.mjs/);
  });

  it('works from a package subdirectory of a monorepo', () => {
    const { root, cwd } = featureRepo('pkg');
    write(root, 'pkg/src/a.mts', lines(2));
    measure(cwd, snapshotSource(cwd), cov(root, { 'pkg/src/a.mts': [[2, 0]] }));
    expect(run(cwd).out).toMatch(/0\/1\s+0\.0%\s+pkg\/src\/a\.mts\s+uncovered: 2/);
  });

  it('only comments added: says so instead of reporting 100%, and --min passes', () => {
    const { root } = featureRepo();
    write(root, 'src/a.mts', lines(2));
    measure(root, snapshotSource(root), cov(root, { 'src/a.mts': [[1, 1]] }));
    const { code, out } = run(root, '--min', '80');
    expect(code).toBe(0);
    expect(out).toContain('no executable added lines');
    expect(out).not.toContain('Total:');
    expect(out).not.toContain('not applied'); // total 0 alone is not "unmeasured"
  });
});

describe('devkit coverage-diff — base resolution', () => {
  it('--base accepts a raw SHA, not just an origin branch', () => {
    const { root } = featureRepo();
    const base = git(root, 'rev-parse', 'HEAD');
    write(root, 'src/a.mts', lines(2));
    measure(root, snapshotSource(root), cov(root, { 'src/a.mts': [[2, 1]] }));
    const { code, out } = run(root, '--base', base);
    expect(code).toBe(0);
    expect(out).toContain(`since ${base}`);
    expect(out).toContain('Total: 1/1');
  });

  it('exits 2 naming --base when no origin base exists', () => {
    const { root } = repo();
    measure(root, snapshotSource(root), cov(root, {}));
    const { code, out } = run(root);
    expect(code).toBe(2);
    expect(out).toContain('pass --base <ref>');
  });

  it('exits 2 on a --base that is not a commit', () => {
    const { root } = featureRepo();
    measure(root, snapshotSource(root), cov(root, {}));
    expect(run(root, '--base', 'no-such-ref').code).toBe(2);
  });
});

describe('devkit coverage-diff — --min and arguments', () => {
  const half = () => {
    const { root } = featureRepo();
    write(root, 'src/a.mts', lines(3));
    measure(
      root,
      snapshotSource(root),
      cov(root, {
        'src/a.mts': [
          [2, 1],
          [3, 0],
        ],
      }),
    );
    return root;
  };

  it('exits 1 below --min and 0 at or above it', () => {
    const root = half();
    const below = run(root, '--min', '50.1');
    expect(below.code).toBe(1);
    expect(below.out).toContain('below --min 50.1%');
    expect(below.out).not.toMatch(/not applied|measured lines only/);
    expect(run(root, '--min', '50').code).toBe(0);
    expect(run(root, '--min', '0').code).toBe(0);
  });

  it.each([['-1'], ['101'], ['abc'], ['']])('rejects --min %j with exit 2', (v) => {
    expect(run(half(), '--min', v).code).toBe(2);
  });

  it('rejects a flag missing its value and an unknown flag with exit 2', () => {
    const root = half();
    expect(run(root, '--base').code).toBe(2);
    expect(run(root, '--from', 'x').code).toBe(2);
  });
});

describe('devkit coverage-diff — --min over unmeasured files', () => {
  it('exits 1 when source changed and the artifact measured no files, naming the include', () => {
    const { root } = featureRepo();
    write(root, 'src/a.mts', lines(2));
    measure(root, snapshotSource(root), cov(root, {}));
    const { code, out } = run(root, '--min', '80');
    expect(code).toBe(1);
    expect(out).toContain('--min 80% not applied — coverage/coverage-final.json measured no files');
    expect(out).toContain("Check the runner's coverage include");
    expect(run(root).code).toBe(0); // without --min the command only reports
  });

  it('exits 0 over an empty artifact when no source line changed', () => {
    const { root } = featureRepo();
    write(root, 'README.md', '# changed\n');
    measure(root, snapshotSource(root), cov(root, {}));
    const { code, out } = run(root, '--min', '80');
    expect(code).toBe(0);
    expect(out).not.toContain('not applied');
  });

  it('exits 0 but says --min was not applied when no changed file was measured', () => {
    const { root } = featureRepo();
    write(root, 'src/b.mts', lines(2));
    measure(root, snapshotSource(root), cov(root, { 'src/a.mts': [[1, 1]] }));
    const { code, out } = run(root, '--min', '80');
    expect(code).toBe(0);
    expect(out).toContain(
      '--min 80% not applied: no measured added lines (1 unmeasured files listed above).',
    );
  });

  it('says --min judged measured lines only when some changed files were unmeasured', () => {
    const { root } = featureRepo();
    write(root, 'src/a.mts', lines(2));
    write(root, 'src/b.mts', lines(2));
    measure(root, snapshotSource(root), cov(root, { 'src/a.mts': [[2, 1]] }));
    const { code, out } = run(root, '--min', '80');
    expect(code).toBe(0);
    expect(out).toContain('--min 80% judged on measured lines only (1 unmeasured files');
  });
});

describe('devkit coverage-diff — the artifact', () => {
  it('exits 1 naming coverage-run when the artifact is absent', () => {
    const { root } = featureRepo();
    const { code, out } = run(root);
    expect(code).toBe(1);
    expect(out).toMatch(/absent.*devkit coverage-run/);
  });

  it('exits 1 on a malformed artifact rather than reading garbage as coverage', () => {
    const { root } = featureRepo();
    write(root, 'coverage/coverage-final.json', '{"/x/a.mts": null}');
    expect(run(root).code).toBe(1);
    write(root, 'coverage/coverage-final.json', '{not json');
    expect(run(root).code).toBe(1);
  });

  it('warns that a file edited after the coverage run may have stale line numbers', () => {
    const { root } = featureRepo();
    write(root, 'src/a.mts', lines(2));
    measure(root, snapshotSource(root), cov(root, { 'src/a.mts': [[2, 1]] }));
    write(root, 'src/a.mts', lines(3));
    expect(run(root).out).toMatch(/line numbers may be stale[^\n]*\n\s+src\/a\.mts/);
  });

  it('warns provenance unknown for an artifact with no coverage-run manifest', () => {
    const { root } = featureRepo();
    write(root, 'src/a.mts', lines(2));
    write(root, 'coverage/coverage-final.json', cov(root, { 'src/a.mts': [[2, 1]] }));
    const { code, out } = run(root);
    expect(code).toBe(0);
    expect(out).toContain('Total: 1/1');
    expect(out).toContain('provenance unknown');
  });

  it('treats an artifact rewritten after its manifest (a racing run) as unknown, not fresh', () => {
    const { root } = featureRepo();
    write(root, 'src/a.mts', lines(2));
    const bytes = cov(root, { 'src/a.mts': [[2, 1]] });
    measure(root, snapshotSource(root), bytes);
    const file = join(root, 'coverage', 'coverage-final.json');
    rmSync(file);
    writeFileSync(file, bytes); // byte-identical, but a different file than the manifest bound
    expect(run(root).out).toContain('provenance unknown');
  });
});

/** Staged edits on a branch with no commits of its own: the merge-base is HEAD, so the commit gate
 * and coverage-diff read the same added lines and must reach the same verdict. */
describe('devkit coverage-diff — agrees with the scope "diff" gate', () => {
  beforeEach(() => {
    vi.stubEnv('GUARD_COVERAGE_OK', '');
    vi.stubEnv('GUARD_NO_COVERAGE', '');
    vi.stubEnv('DEVKIT_RUN_MODE', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  const diffRepo = (addedLines = 70) => featureRepo('', { scope: 'diff', addedLines }).root;
  const both = (root: string) => {
    git(root, 'add', '-A');
    const g = gate(root);
    const d = run(root);
    expect(d.code).toBe(g.code);
    return { g, d };
  };
  /** src/b.mts (3 lines) on the base too, so later edits to it are modifications. */
  const withB = (root: string) => {
    write(root, 'src/b.mts', lines(3));
    commitAll(root, 'b');
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  };

  it("fails on an added line in a file no measured test loaded, with the gate's reason", () => {
    const root = diffRepo();
    write(root, 'src/b.mts', lines(2));
    git(root, 'add', '-A');
    measure(root, snapshotSource(root), cov(root, { 'src/a.mts': [[1, 1]] }));
    const { g, d } = both(root);
    const reason = '1 source file with added lines never measured';
    expect(g.code).toBe(1);
    expect(g.out).toContain(`Coverage gate FAILED — ${reason}`);
    expect(d.out).toContain(`would FAIL if this ships — ${reason}`);
    expect(d.out).toContain('--dry-gates');
  });

  it('passes at the threshold and fails below it with the same summary', () => {
    for (const [hit, code, summary] of [
      [1, 0, '2/2 added executable lines covered (100.0%, min 70%)'],
      [0, 1, '1/2 added executable lines covered (50.0%, min 70%)'],
    ] as const) {
      const root = diffRepo();
      write(root, 'src/a.mts', lines(3));
      git(root, 'add', '-A');
      measure(
        root,
        snapshotSource(root),
        cov(root, {
          'src/a.mts': [
            [2, 1],
            [3, hit],
          ],
        }),
      );
      const { g, d } = both(root);
      expect(g.code).toBe(code);
      expect(g.out).toContain(summary);
      expect(d.out).toContain(summary);
    }
  });

  it('fails when a measured file loses lines, or is deleted, after the coverage run', () => {
    for (const edit of [
      (root: string) => write(root, 'src/b.mts', lines(2)),
      (root: string) => git(root, 'rm', '-q', 'src/b.mts'),
    ]) {
      const root = diffRepo();
      withB(root);
      write(root, 'src/a.mts', lines(2));
      git(root, 'add', '-A');
      measure(
        root,
        snapshotSource(root),
        cov(root, { 'src/a.mts': [[2, 1]], 'src/b.mts': [[1, 1]] }),
      );
      edit(root);
      const { g, d } = both(root);
      expect(g.code).toBe(1);
      expect(d.out).toContain('the artifact predates 1 changed file(s)');
      expect(d.out).toMatch(/stale[^\n]*\n\s+src\/b\.mts$/m);
    }
  });

  it('passes a change that adds no production lines, even with an unbound artifact', () => {
    const root = diffRepo();
    write(root, 'src/a.test.mts', lines(3));
    write(root, 'coverage/coverage-final.json', cov(root, { 'src/a.mts': [[1, 1]] }));
    const { d } = both(root);
    expect(d.code).toBe(0);
    expect(d.out).toContain('would pass — no added lines in production source');
  });

  it('does not list a deletion-only or a renamed unmeasured file', () => {
    for (const edit of [
      (root: string) => write(root, 'src/b.mts', lines(2)),
      (root: string) => git(root, 'mv', 'src/b.mts', 'src/c.mts'),
    ]) {
      const root = diffRepo();
      withB(root);
      edit(root);
      git(root, 'add', '-A');
      measure(root, snapshotSource(root), cov(root, { 'src/a.mts': [[1, 1]] }));
      const { d } = both(root);
      expect(d.code).toBe(0);
      expect(d.out).not.toContain('Not measured');
    }
  });

  it('keeps a measured file outside sourceExtensions out of the verdict totals', () => {
    const root = diffRepo();
    write(root, 'src/a.mts', lines(4));
    write(root, 'src/x.mjs', lines(10));
    git(root, 'add', '-A');
    const mjs: [number, number][] = Array.from({ length: 10 }, (_, i) => [i + 1, 1]);
    measure(
      root,
      snapshotSource(root),
      cov(root, {
        'src/a.mts': [
          [2, 1],
          [3, 0],
          [4, 0],
        ],
        'src/x.mjs': mjs,
      }),
    );
    const { d } = both(root);
    expect(d.code).toBe(1);
    expect(d.out).toContain('1/3 added executable lines covered (33.3%, min 70%)');
    expect(d.out).toContain('src/x.mjs');
  });

  it('fails an unbound artifact when production lines were added', () => {
    const root = diffRepo();
    write(root, 'src/a.mts', lines(2));
    write(root, 'coverage/coverage-final.json', cov(root, { 'src/a.mts': [[2, 1]] }));
    const { d } = both(root);
    expect(d.code).toBe(1);
    expect(d.out).toContain('would FAIL if this ships — artifact provenance unknown');
  });

  it('reports an empty artifact as the gate does, before its unknown provenance', () => {
    const root = diffRepo();
    write(root, 'src/a.mts', lines(2));
    write(root, 'coverage/coverage-final.json', '{}');
    const { g, d } = both(root);
    expect(g.code).toBe(1);
    expect(g.out).toContain('measured no files');
    expect(d.out).toContain(
      'would FAIL if this ships — coverage/coverage-final.json measured no files',
    );
  });

  it('passes an empty artifact when no production line was added, as the gate does', () => {
    const root = diffRepo();
    write(root, 'src/a.test.mts', lines(3));
    write(root, 'coverage/coverage-final.json', '{}');
    const { d } = both(root);
    expect(d.code).toBe(0);
    expect(d.out).toContain('would pass — no added lines in production source');
  });

  it('judges the whole branch, as ship does: a committed unmeasured file still fails', () => {
    const root = diffRepo();
    write(root, 'src/b.mts', lines(2));
    commitAll(root, 'b'); // the commit gate now sees nothing staged; ship sees the branch
    measure(root, snapshotSource(root), cov(root, { 'src/a.mts': [[1, 1]] }));
    const { code, out } = run(root);
    expect(code).toBe(1);
    expect(out).toContain('1 source file with added lines never measured');
  });

  it('fails a misconfigured scope "diff" as the gate does', () => {
    const { root } = featureRepo('', { scope: 'diff' });
    write(root, 'src/a.mts', lines(2));
    git(root, 'add', '-A');
    measure(root, snapshotSource(root), cov(root, { 'src/a.mts': [[2, 1]] }));
    const { d } = both(root);
    expect(d.code).toBe(1);
    expect(d.out).toContain('coverage.scope "diff" needs coverage.addedLines');
  });

  it('a package gate ignores an unmeasured file in a sibling package', () => {
    const { root, cwd } = featureRepo('pkg', { scope: 'diff', addedLines: 70 });
    write(root, 'pkg/src/a.mts', lines(2));
    write(root, 'other/src/z.mts', lines(2));
    git(root, 'add', '-A');
    measure(cwd, snapshotSource(cwd), cov(root, { 'pkg/src/a.mts': [[2, 1]] }));
    git(root, 'add', '-A');
    const g = gate(cwd);
    const d = run(cwd);
    expect([g.code, d.code]).toEqual([0, 0]);
    expect(d.out).toContain('would pass — 1/1 added executable lines covered');
  });

  it('a source symlink committed before the run is not stale', () => {
    const root = diffRepo();
    write(root, 'src/a.mts', lines(2));
    symlinkSync('a.mts', join(root, 'src/link.mts'));
    commitAll(root, 'link');
    measure(root, snapshotSource(root), cov(root, { 'src/a.mts': [[2, 1]] }));
    const { code, out } = run(root);
    expect(out).not.toContain('predates');
    expect(code).toBe(0);
  });

  it('prints no verdict and exits 0 without a scope "diff" config', () => {
    const { root } = featureRepo();
    write(root, 'src/b.mts', lines(2));
    measure(root, snapshotSource(root), cov(root, { 'src/a.mts': [[1, 1]] }));
    const { code, out } = run(root);
    expect(code).toBe(0);
    expect(out).toContain('Not measured');
    expect(out).not.toContain('Coverage gate');
  });
});
