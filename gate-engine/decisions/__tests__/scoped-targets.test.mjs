/**
 * scoped-targets — the deterministic scope-match half (the semantic --query half needs the vector
 * index + embeddings, so it's exercised by the query tests, not here). A fixture decisions dir at
 * <root>/docs/decisions; scopedTargets(files, '', k, root) must return exactly the Targets whose
 * `**Scope:**` glob covers a changed file, shaped for the consumer's critique-prep JSON.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scopedTargets } from '../scoped-targets.mjs';

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
