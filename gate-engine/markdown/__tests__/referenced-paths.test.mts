import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  lineAnchors,
  referencedRepoPathCandidates,
  resolvesCaseExact,
} from '../referenced-paths.mts';

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

  it('reads a Claude Code @import as the path it imports', () => {
    expect(referencedRepoPathCandidates('@AGENTS.md\n@docs/rules.md')).toEqual([
      'AGENTS.md',
      'docs/rules.md',
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

describe('lineAnchors', () => {
  it.each([
    ['cli/lib/ship/reship.sh:443', ['cli/lib/ship/reship.sh:443']],
    ['see update.mts:186-189.', ['update.mts:186-189']],
    ['ERROR src/a.mts:93:39 (+2)', ['src/a.mts:93']],
    ['CLAUDE.md:12 and jobs.c:3800', ['CLAUDE.md:12', 'jobs.c:3800']],
    ['(ship-branch.sh:298) twice: ship-branch.sh:298', ['ship-branch.sh:298']],
    ['a Windows path src\\lib\\a.ts:12', ['a.ts:12']],
    ['a CRLF line ending reship.sh:12\r\n', ['reship.sh:12']],
  ])('finds the anchor in %j', (text, anchors) => {
    expect(lineAnchors(text)).toEqual(anchors);
  });

  it.each([
    'localhost:3000',
    'api.example.com:443',
    'node:22-bookworm',
    'at 10:30',
    'ADVISORY: <file:line>',
    'https://github.com/o/r/blob/0a1b2c3/a.ts#L12',
    '**Scope:** gate-engine/decisions/**,cli/lib/*.mts',
    'reship.sh names the preflight',
    'pytest tests/test_a.py::test_x',
    'edit package.json: 3 keys changed',
  ])('finds no anchor in %j', (text) => {
    expect(lineAnchors(text)).toEqual([]);
  });
});
