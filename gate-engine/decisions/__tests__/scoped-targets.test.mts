/**
 * scoped-targets — the deterministic scope-match half (the semantic --query half needs the vector
 * index + embeddings, so it's exercised by the query tests, not here). A fixture decisions dir at
 * <root>/docs/decisions; scopedTargets(files, '', k, root) must return exactly the Targets whose
 * `**Scope:**` glob covers a changed file, shaped for the consumer's critique-prep JSON.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rankAxes } from '../decisions.mts';
import { main, scopedTargets } from '../scoped-targets.mts';

// The semantic supplement is exercised with rankAxes stubbed — the real ranker needs a vector
// index/embeddings; what THIS file pins is scoped-targets' composition contract around it.
vi.mock('../decisions.mts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../decisions.mts')>();
  return { ...mod, rankAxes: vi.fn(mod.rankAxes) };
});

let roots = [];
function repoWithDecisions(targets) {
  const root = mkdtempSync(join(tmpdir(), 'scoped-'));
  roots.push(root);
  for (const [slug, scope, ruling, date] of targets)
    writeAxis(root, slug, scope, ruling, undefined, date);
  return root;
}
function writeAxis(root, slug, scope, ruling, dir = 'docs/decisions', date = '2026-01-01') {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(
    join(root, dir, `${slug}.md`),
    `---\nslug: ${slug}\ncreated: 2026-01-01\n---\n\n## Target · ${date} — ${slug}\n\n**Ruling:** ${ruling}\n**Scope:** ${scope}\n`,
  );
}
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

describe('scopedTargets (scope-match)', () => {
  it('returns only Targets whose scope glob covers a changed file', async () => {
    const root = repoWithDecisions([
      ['foo', 'src/foo/**', 'The foo ruling'],
      ['bar', 'src/bar/**', 'The bar ruling'],
    ]);
    const blocks = await scopedTargets(['src/foo/handler.ts'], '', 6, root);
    expect(blocks.map((b) => b.slug)).toEqual(['foo']);
    expect(blocks[0]).toMatchObject({
      slug: 'foo',
      ruling: 'The foo ruling',
      scope: 'src/foo/**',
      via: 'scope-match',
    });
  });

  it('matches across multiple scoped Targets that all cover the file', async () => {
    const root = repoWithDecisions([
      ['a', 'package.json', 'A'],
      ['b', 'package.json,bun.lock', 'B'],
      ['c', 'src/**', 'C'],
    ]);
    const slugs = (await scopedTargets(['package.json'], '', 6, root)).map((x) => x.slug).sort();
    expect(slugs).toEqual(['a', 'b']);
  });

  it('keeps its content order in-process; only the CLI ranks by specificity, so reviewer prompt bytes do not move', async () => {
    const root = repoWithDecisions([
      ['aaa-broad', 'src/**', 'Broad'],
      ['zzz-exact', 'src/foo/x.ts', 'Exact'],
    ]);
    const slugs = (await scopedTargets(['src/foo/x.ts'], '', 6, root)).map((x) => x.slug);
    expect(slugs).toEqual(['aaa-broad', 'zzz-exact']);
  });

  it('returns [] when no scope matches and no query is given', async () => {
    const root = repoWithDecisions([['foo', 'src/foo/**', 'r']]);
    expect(await scopedTargets(['src/other/x.ts'], '', 6, root)).toEqual([]);
  });

  it('returns [] for no files and no query (nothing governs)', async () => {
    const root = repoWithDecisions([['foo', 'src/foo/**', 'r']]);
    expect(await scopedTargets([], '', 6, root)).toEqual([]);
  });
});

describe('scopedTargets — scope-match order', () => {
  const dated = [
    ['a-old', 'src/**', 'A', '2026-01-01'],
    ['m-mid', 'src/**', 'M', '2026-03-01'],
    ['z-new', 'src/**', 'Z', '2026-06-01'],
    ['b-new', 'src/**', 'B', '2026-06-01'],
  ];

  it('puts the newest Target date first, so a capped prompt keeps the latest ruling', async () => {
    const root = repoWithDecisions(dated);
    const slugs = (await scopedTargets(['src/x.ts'], '', 6, root)).map((b) => b.slug);
    expect(slugs).toEqual(['b-new', 'z-new', 'm-mid', 'a-old']);
  });

  it('ignores file mtimes, so a copied or re-checked-out log keeps the same order', async () => {
    const root = repoWithDecisions(dated);
    utimesSync(join(root, 'docs', 'decisions', 'a-old.md'), new Date(), new Date('2030-01-01'));
    utimesSync(join(root, 'docs', 'decisions', 'z-new.md'), new Date(), new Date('2000-01-01'));
    const slugs = (await scopedTargets(['src/x.ts'], '', 6, root)).map((b) => b.slug);
    expect(slugs).toEqual(['b-new', 'z-new', 'm-mid', 'a-old']);
  });

  it('dates a superseded axis by its CURRENT Target, not its first', async () => {
    const root = repoWithDecisions(dated);
    writeFileSync(
      join(root, 'docs', 'decisions', 'y-superseded.md'),
      '---\nslug: y-superseded\ncreated: 2025-01-01\n---\n\n## Target · 2025-01-01 — old\n\n**Ruling:** Old\n**Scope:** src/**\n\n## Target · 2026-09-01 — new\n\n**Ruling:** New\n**Scope:** src/**\n',
    );
    const blocks = await scopedTargets(['src/x.ts'], '', 6, root);
    expect(blocks[0]).toMatchObject({ slug: 'y-superseded', ruling: 'New' });
  });

  it('keeps every scope match ahead of the semantic supplement', async () => {
    const root = repoWithDecisions([...dated, ['other', 'lib/**', 'O', '2026-12-01']]);
    // SAFETY: scopedTargets reads only rows[].slug from rankAxes; the stub supplies just that.
    vi.mocked(rankAxes).mockResolvedValueOnce({ rows: [{ slug: 'other' }] } as never);
    const blocks = await scopedTargets(['src/x.ts'], 'q', 6, root);
    expect(blocks.map((b) => b.slug)).toEqual(['b-new', 'z-new', 'm-mid', 'a-old', 'other']);
    expect(blocks.at(-1)?.via).toBe('semantic');
  });
});

describe('scopedTargets — semantic supplement (sc-1442)', () => {
  afterEach(() => vi.mocked(rankAxes).mockReset());

  it('appends ranked axes as via:semantic, deduped against scope matches', async () => {
    const root = repoWithDecisions([
      ['foo', 'src/foo/**', 'The foo ruling'],
      ['bar', 'src/bar/**', 'The bar ruling'],
    ]);
    vi.mocked(rankAxes).mockResolvedValue({ rows: [{ slug: 'bar' }, { slug: 'foo' }] } as never);
    const blocks = await scopedTargets(['src/foo/handler.ts'], 'bar things', 6, root);
    expect(blocks.map((b) => [b.slug, b.via])).toEqual([
      ['foo', 'scope-match'],
      ['bar', 'semantic'], // foo NOT duplicated: already scope-matched
    ]);
  });

  it('a semantic-tier throw NEVER discards the scope matches (salt-safety, sc-1442)', async () => {
    // A caller derives its cache salt from the scope-match subset; if a query-only error collapsed
    // the whole result, supplying a commit message could move the salt — the exact violation of
    // ship-gates-converge-not-restart this partition exists to prevent.
    const root = repoWithDecisions([['foo', 'src/foo/**', 'The foo ruling']]);
    vi.mocked(rankAxes).mockRejectedValue(new Error('embed endpoint down'));
    const blocks = await scopedTargets(['src/foo/handler.ts'], 'any query', 6, root);
    expect(blocks.map((b) => [b.slug, b.via])).toEqual([['foo', 'scope-match']]);
  });
});

describe('scopedTargets — commit index for gates, worktree for the CLI brief', () => {
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  const commitAll = (root) => {
    git(root, 'add', '.');
    git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
  };
  const committedRepo = (dir = 'docs/decisions') => {
    const root = mkdtempSync(join(tmpdir(), 'scoped-git-'));
    roots.push(root);
    git(root, 'init', '-q');
    writeAxis(root, 'foo', 'src/**', 'Committed ruling', dir);
    commitAll(root);
    return root;
  };
  const rulings = async (cwd, from?) =>
    (await scopedTargets(['src/a.ts'], '', 6, cwd, from)).map((b) => [b.slug, b.ruling]);

  beforeEach(() => {
    vi.stubEnv('DEVKIT_COMMIT_INDEX_FILE', undefined);
    vi.stubEnv('DEVKIT_COMMIT_GIT_DIR', undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('a gate reads the index; an unstaged draft and an untracked axis reach only the worktree read', async () => {
    const root = committedRepo();
    writeAxis(root, 'foo', 'src/**', 'Unstaged draft');
    writeAxis(root, 'fresh', 'src/**', 'Untracked claim');
    expect(await rulings(root)).toEqual([['foo', 'Committed ruling']]);
    expect(await rulings(root, 'worktree')).toEqual([
      ['foo', 'Unstaged draft'],
      ['fresh', 'Untracked claim'],
    ]);
  });

  it('a staged ruling wins over a different unstaged one', async () => {
    const root = committedRepo();
    writeAxis(root, 'foo', 'src/**', 'Staged ruling');
    git(root, 'add', '.');
    writeAxis(root, 'foo', 'src/**', 'Unstaged draft');
    expect(await rulings(root)).toEqual([['foo', 'Staged ruling']]);
  });

  it('reads committed Targets from the index when the log folder is deleted but not staged', async () => {
    const root = committedRepo();
    rmSync(join(root, 'docs/decisions'), { recursive: true });
    expect(await rulings(root)).toEqual([['foo', 'Committed ruling']]);
    expect(await rulings(root, 'worktree')).toEqual([]);
  });

  it('reads a decisions dir that lives in another repository from its worktree, not its index', async () => {
    const shared = committedRepo();
    writeAxis(shared, 'foo', 'src/**', 'Unstaged draft');
    const root = mkdtempSync(join(tmpdir(), 'scoped-consumer-'));
    roots.push(root);
    git(root, 'init', '-q');
    writeFileSync(
      join(root, 'guard.config.json'),
      JSON.stringify({ decisionsDir: join(shared, 'docs/decisions') }),
    );
    expect(await rulings(root)).toEqual([['foo', 'Unstaged draft']]);
  });

  it('reads a record whose name holds pathspec characters, and only that record', async () => {
    const root = committedRepo();
    writeAxis(root, 'a[1]', 'src/**', 'Bracket ruling');
    writeAxis(root, 'a1', 'src/**', 'Plain ruling');
    commitAll(root);
    expect(await rulings(root)).toEqual([
      ['a1', 'Plain ruling'],
      ['a[1]', 'Bracket ruling'],
      ['foo', 'Committed ruling'],
    ]);
  });

  it('reads a git-ignored decision log from the worktree, silently', async () => {
    const root = repoWithDecisions([['foo', 'src/**', 'Ignored-log ruling']]);
    git(root, 'init', '-q');
    writeFileSync(join(root, '.git', 'info', 'exclude'), 'docs/\n');
    writeFileSync(join(root, 'README.md'), 'x\n');
    commitAll(root);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await rulings(root)).toEqual([['foo', 'Ignored-log ruling']]);
    expect(error).not.toHaveBeenCalled();
  });

  it('resolves a package decisionsDir from its guard.config.json and reads it from the index', async () => {
    const root = committedRepo('packages/app/adr');
    writeFileSync(join(root, 'packages/app/guard.config.json'), '{"decisionsDir":"adr"}');
    commitAll(root);
    writeAxis(root, 'foo', 'src/**', 'Unstaged draft', 'packages/app/adr');
    expect(await rulings(join(root, 'packages/app'))).toEqual([['foo', 'Committed ruling']]);
  });

  it("follows the commit's carrier index", async () => {
    const root = committedRepo();
    const alt = join(root, '.git', 'alt-index');
    const altEnv = { ...process.env, GIT_INDEX_FILE: alt };
    execFileSync('git', ['read-tree', 'HEAD'], { cwd: root, env: altEnv });
    writeAxis(root, 'foo', 'src/**', 'Carried ruling');
    execFileSync('git', ['add', '.'], { cwd: root, env: altEnv });
    writeAxis(root, 'foo', 'src/**', 'Unstaged draft');
    vi.stubEnv('DEVKIT_COMMIT_INDEX_FILE', alt);
    vi.stubEnv('DEVKIT_COMMIT_GIT_DIR', join(root, '.git'));
    expect(await rulings(root)).toEqual([['foo', 'Carried ruling']]);
  });

  it('narrates once and reads the worktree when the index cannot be read', async () => {
    const root = committedRepo();
    writeFileSync(join(root, '.git', 'index'), 'not an index');
    writeAxis(root, 'foo', 'src/**', 'Worktree ruling');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await rulings(root)).toEqual([['foo', 'Worktree ruling']]);
    expect(await rulings(root)).toEqual([['foo', 'Worktree ruling']]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toMatch(/could not read the decision log/);
  });

  it('records under a nested proposed/ folder never become gate authority', async () => {
    const root = committedRepo();
    writeAxis(root, 'pending', 'src/**', 'Proposed ruling', 'docs/decisions/proposed');
    commitAll(root);
    expect(await rulings(root)).toEqual([['foo', 'Committed ruling']]);
    expect(await rulings(root, 'worktree')).toEqual([['foo', 'Committed ruling']]);
  });

  it('a ranked axis that is untracked or edited unstaged hands the gate no draft ruling', async () => {
    const root = committedRepo();
    writeAxis(root, 'bar', 'lib/**', 'Committed bar');
    commitAll(root);
    writeAxis(root, 'bar', 'lib/**', 'Unstaged bar draft');
    writeAxis(root, 'fresh', 'lib/**', 'Untracked claim');
    // SAFETY: scopedTargets reads only `slug` from a ranked row.
    vi.mocked(rankAxes).mockResolvedValue({ rows: [{ slug: 'fresh' }, { slug: 'bar' }] } as never);
    const blocks = await scopedTargets([], 'q', 6, root);
    vi.mocked(rankAxes).mockReset();
    expect(blocks.map((b) => [b.slug, b.ruling, b.via])).toEqual([
      ['bar', 'Committed bar', 'semantic'],
    ]);
  });

  it('a repo-root decisionsDir reads only its own records from the index, not every blob', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scoped-root-'));
    roots.push(root);
    git(root, 'init', '-q');
    writeFileSync(join(root, 'guard.config.json'), '{"decisionsDir":"."}');
    writeAxis(root, 'foo', 'src/**', 'Committed ruling', '.');
    git(root, 'add', '.');
    // A nested path git can hold but this read cannot decode: reached only by a recursive read.
    const blob = git(root, 'hash-object', '-w', '--stdin').trim();
    execFileSync('git', ['update-index', '--add', '-z', '--index-info'], {
      cwd: root,
      input: Buffer.concat([Buffer.from(`100644 ${blob}\tassets/`), Buffer.from([0xff, 0])]),
    });
    git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
    writeAxis(root, 'foo', 'src/**', 'Unstaged draft', '.');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await rulings(root)).toEqual([['foo', 'Committed ruling']]);
    expect(error).not.toHaveBeenCalled();
  });

  it('the scoped-targets CLI briefs from the worktree draft', async () => {
    const root = committedRepo();
    writeAxis(root, 'foo', 'src/**', 'Unstaged draft');
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await main(['--files', 'src/a.ts']);
    expect(JSON.parse(String(out.mock.calls[0]?.[0]))).toMatchObject([
      { slug: 'foo', ruling: 'Unstaged draft' },
    ]);
  });
});
