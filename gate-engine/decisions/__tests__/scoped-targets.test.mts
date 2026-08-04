/**
 * scoped-targets — the deterministic scope-match half (the semantic --query half needs the vector
 * index + embeddings, so it's exercised by the query tests, not here). A fixture decisions dir at
 * <root>/docs/decisions; scopedTargets(files, '', k, root) must return exactly the Targets whose
 * `**Scope:**` glob covers a changed file, shaped for the consumer's critique-prep JSON.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  for (const [slug, scope, ruling] of targets) {
    writeFileSync(
      join(dir, `${slug}.md`),
      `---\nslug: ${slug}\ncreated: 2026-01-01\n---\n\n## Target · 2026-01-01 — ${slug}\n\n**Ruling:** ${ruling}\n**Scope:** ${scope}\n`,
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

  it('returns [] when no scope matches and no query is given', async () => {
    const root = repoWithDecisions([['foo', 'src/foo/**', 'r']]);
    expect(await scopedTargets(['src/other/x.ts'], '', 6, root)).toEqual([]);
  });

  it('returns [] for no files and no query (nothing governs)', async () => {
    const root = repoWithDecisions([['foo', 'src/foo/**', 'r']]);
    expect(await scopedTargets([], '', 6, root)).toEqual([]);
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
