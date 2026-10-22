/**
 * scoped-targets — the deterministic scope-match half (the semantic --query half needs the vector
 * index + embeddings, so it's exercised by the query tests, not here). A fixture decisions dir at
 * <root>/docs/decisions; scopedTargets(files, '', k, root) must return exactly the Targets whose
 * `**Scope:**` glob covers a changed file, shaped for the consumer's critique-prep JSON.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rankAxes } from '../decisions.mts';
import { scopedTargets } from '../scoped-targets.mts';

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
  const dir = join(root, 'docs', 'decisions');
  mkdirSync(dir, { recursive: true });
  for (const [slug, scope, ruling, date = '2026-01-01'] of targets) {
    writeFileSync(
      join(dir, `${slug}.md`),
      `---\nslug: ${slug}\ncreated: 2026-01-01\n---\n\n## Target · ${date} — ${slug}\n\n**Ruling:** ${ruling}\n**Scope:** ${scope}\n`,
    );
  }
  return root;
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
