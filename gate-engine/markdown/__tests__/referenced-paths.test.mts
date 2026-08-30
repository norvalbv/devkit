import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { referencedRepoPathCandidates, resolvesCaseExact } from '../referenced-paths.mts';

describe('referencedRepoPathCandidates', () => {
  it('collects inline, linked and fenced repo-relative paths once in first-seen order', () => {
    const markdown = [
      'Read `README.md` and [the decisions](docs/decisions/INDEX.md).',
      '```sh',
      'node gate-engine/decisions/cli.mts show slug',
      '```',
      'Then reopen `README.md`.',
    ].join('\n');

    expect(referencedRepoPathCandidates(markdown)).toEqual([
      'README.md',
      'docs/decisions/INDEX.md',
      'gate-engine/decisions/cli.mts',
    ]);
  });

  it('normalizes ./ prefixes, locators and trailing-slash directory citations', () => {
    const markdown = [
      '[readme](./README.md#documentation)',
      '`docs/decisions/INDEX.md?raw=1`',
      '`cli/index.mts:12`',
      '`skills/`',
    ].join(' ');

    expect(referencedRepoPathCandidates(markdown)).toEqual([
      './README.md',
      'docs/decisions/INDEX.md',
      'cli/index.mts',
      'skills',
    ]);
  });

  it('ignores remote URLs, glob forms and placeholder-bearing paths', () => {
    const markdown = [
      'https://example.com/docs/readme.md',
      'mailto:docs@example.com',
      '//example.com/docs/readme.md',
      '`skills/**`',
      '`docs/?.md`',
      '`docs/f?o.md`',
      '`docs/[ab].md`',
      '`docs/{a,b}.md`',
      '`<slug>`',
      '`docs/<slug>.md`',
    ].join(' ');

    expect(referencedRepoPathCandidates(markdown)).toEqual([]);
  });
});

describe('resolvesCaseExact', () => {
  const roots: string[] = [];
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'devkit-markdown-paths-'));
    roots.push(root);
    mkdirSync(join(root, 'docs', 'decisions'), { recursive: true });
    writeFileSync(join(root, 'README.md'), 'readme');
    writeFileSync(join(root, 'docs', 'decisions', 'INDEX.md'), 'index');

    const outside = mkdtempSync(join(tmpdir(), 'devkit-markdown-paths-outside-'));
    roots.push(outside);
    writeFileSync(join(outside, 'secret.md'), 'outside');
    symlinkSync(outside, join(root, 'outside-link'), 'dir');
  });

  afterAll(() => {
    for (const dir of roots.reverse()) rmSync(dir, { recursive: true, force: true });
  });

  it('accepts exact segments and ./ while rejecting missing or wrongly-cased segments', () => {
    expect(resolvesCaseExact(root, 'README.md')).toBe(true);
    expect(resolvesCaseExact(root, './docs/decisions/INDEX.md')).toBe(true);
    expect(resolvesCaseExact(root, 'docs/Decisions/INDEX.md')).toBe(false);
    expect(resolvesCaseExact(root, 'docs/decisions/gone.md')).toBe(false);
    expect(resolvesCaseExact(root, 'README.md/child')).toBe(false);
  });

  it('rejects empty, absolute and parent-traversing paths', () => {
    expect(resolvesCaseExact(root, '')).toBe(false);
    expect(resolvesCaseExact(root, '/README.md')).toBe(false);
    expect(resolvesCaseExact(root, '../README.md')).toBe(false);
    expect(resolvesCaseExact(root, 'docs/../README.md')).toBe(false);
  });

  it('follows repository symlinks because this checks existence and casing, not confinement', () => {
    expect(resolvesCaseExact(root, 'outside-link/secret.md')).toBe(true);
  });
});
