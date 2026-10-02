import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectChangedComments } from '../detect.mts';
import { runCommentFirewall } from '../gate.mts';

/** The guard.config.json `comments` block as a consumer writes it. */
interface CommentsConfig {
  forbiddenRefs?: string[];
  forbidDecisionRefs?: boolean;
}

const DEVKIT_REFS: CommentsConfig = {
  forbiddenRefs: ['\\bsc-\\d+\\b', '\\breport-[0-9a-f]{6,}\\b'],
};

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** A repo whose base commit holds `before` in src/a.tsx, with `after` staged over it. */
/** `comments: null` writes a guard.config.json with no `comments` key at all. */
function staged(before: string, after: string, comments: CommentsConfig | null = DEVKIT_REFS) {
  const root = mkdtempSync(path.join(tmpdir(), 'guard-comment-refs-'));
  roots.push(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'refs@example.test']);
  git(root, ['config', 'user.name', 'Refs Test']);
  mkdirSync(path.join(root, 'src'));
  mkdirSync(path.join(root, 'docs/decisions/proposed'), { recursive: true });
  for (const slug of ['ultra-effort-tier', 'INDEX', 'coverage']) {
    writeFileSync(path.join(root, `docs/decisions/${slug}.md`), `# ${slug}\n`);
  }
  writeFileSync(path.join(root, 'docs/decisions/proposed/draft-only-slug.md'), '# draft\n');
  writeFileSync(
    path.join(root, 'guard.config.json'),
    JSON.stringify({
      scanRoots: ['src'],
      sourceExtensions: ['tsx'],
      ...(comments && { comments }),
    }),
  );
  writeFileSync(path.join(root, 'src/a.tsx'), before);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'base']);
  writeFileSync(path.join(root, 'src/a.tsx'), after);
  git(root, ['add', 'src/a.tsx']);
  return root;
}

const cited = (root: string) =>
  detectChangedComments(root).refFindings.map((finding) => finding.refs.join(','));

describe('forbidden references in changed comments', () => {
  it.each([
    ['a trailing ticket', 'const a = 1; // (sc-3836)\n'],
    ['a leading ticket line', '// sc-3855: a plain click always opens the file.\nconst a = 1;\n'],
    ['an autonomous report id', '/** Raised by report-245f3760. */\nconst a = 1;\n'],
    ['a JSX comment', 'const el = <div>{/* sc-1 */}</div>;\n'],
  ])('blocks %s', (_name, after) => {
    expect(cited(staged('const a = 0;\n', after))).toHaveLength(1);
  });

  it('reports the reference on the changed line of a multi-line block only', () => {
    const before = '/**\n * Old first line.\n * Unchanged (sc-12).\n */\nconst a = 1;\n';
    const after = '/**\n * New first line (sc-99).\n * Unchanged (sc-12).\n */\nconst a = 1;\n';
    expect(detectChangedComments(staged(before, after)).refFindings).toMatchObject([
      { line: 2, refs: ['sc-99'] },
    ]);
  });

  it.each([
    [
      'a code-only edit beside an unchanged trailing reference',
      'const a = 1; // sc-3836\n',
      'const a = 2; // sc-3836\n',
    ],
    [
      'an untouched reference next to an added line',
      '// sc-123\nconst a = 1;\n',
      '// sc-123\nconst a = 1;\nconst b = 2;\n',
    ],
    ['a reference inside a string literal', 'const a = 1;\n', "const a = 'sc-1 // sc-2';\n"],
    [
      'a code-only edit beside two comments on one line',
      'const a = 1; /* sc-1 */ /* note */\n',
      'const a = 2; /* sc-1 */ /* note */\n',
    ],
    [
      'a code-only edit beside two references on one line',
      'const a = 1; /* sc-1 */ /* sc-2 */\n',
      'const a = 2; /* sc-1 */ /* sc-2 */\n',
    ],
  ])('passes %s', (_name, before, after) => {
    expect(cited(staged(before, after))).toEqual([]);
  });

  it.each([
    [
      'a reworded comment that keeps its reference',
      '// sc-3836: A\nconst a = 1;\n',
      '// sc-3836: B\nconst a = 1;\n',
    ],
    ['a swapped ticket', 'const a = 1; // sc-111\n', 'const a = 1; // sc-222\n'],
    [
      'a shortened comment that keeps its reference',
      '// sc-1 obsolete\nconst a = 1;\n',
      '// sc-1\nconst a = 1;\n',
    ],
    [
      'a reference moved into a longer comment',
      'const a = 1; // sc-1\n',
      'const a = 1; // see sc-1\n',
    ],
    [
      'a pasted twin of an existing reference',
      'const a = 1; // sc-3836\n',
      'const a = 1; // sc-3836\nconst b = 1; // sc-3836\n',
    ],
  ])('blocks %s', (_name, before, after) => {
    expect(cited(staged(before, after))).toHaveLength(1);
  });

  it('does not let a deletion elsewhere in the hunk excuse a new reference', () => {
    const before = 'const a = 1; // sc-7\nconst b = 1;\nconst c = 1;\n';
    const after = 'const a = 1;\nconst b = 1;\nconst c = 1; // sc-7\n';
    expect(cited(staged(before, after))).toEqual(['sc-7']);
  });

  it.each([
    ['no comments key', null],
    ['an empty pattern list', { forbiddenRefs: [] }],
  ])('checks nothing with %s, so a consumer ID convention passes', (_name, comments) => {
    const after = '// JIRA-123 @spec BM-002 sc-1 docs/decisions/x.md\nconst a = 1;\n';
    expect(cited(staged('const a = 0;\n', after, comments))).toEqual([]);
  });

  it('matches committed decision record names and the decisions path when opted in', () => {
    const after = [
      '// Why: docs/decisions',
      '// see ultra-effort-tier for the ruling',
      '// coverage stays a plain word; INDEX too',
      '// draft-only-slug is not a committed record name in this index',
      '// ultra-effort-tiers is a different word',
      'const a = 1;',
    ].join('\n');
    const root = staged('const a = 0;\n', `${after}\n`, { forbidDecisionRefs: true });
    expect(cited(root)).toEqual(['docs/decisions', 'ultra-effort-tier']);
  });

  it('matches a decision path or name after a slash', () => {
    const after =
      '// See ./docs/decisions/ultra-effort-tier.md and ./ultra-effort-tier.md\nconst a = 1;\n';
    const root = staged('const a = 0;\n', after, { forbidDecisionRefs: true });
    expect(cited(root)).toEqual(['docs/decisions,ultra-effort-tier']);
  });

  it('matches only record names, never every comment, when decisions live at the repo root', () => {
    const root = staged(
      'const a = 0;\n',
      '// plain note\n// see root-level-ruling\nconst a = 1;\n',
    );
    writeFileSync(path.join(root, 'root-level-ruling.md'), '# ruling\n');
    writeFileSync(
      path.join(root, 'guard.config.json'),
      JSON.stringify({
        scanRoots: ['src'],
        sourceExtensions: ['tsx'],
        decisionsDir: '.',
        comments: { forbidDecisionRefs: true },
      }),
    );
    git(root, ['add', '.']);
    expect(cited(root)).toEqual(['root-level-ruling']);
  });

  it('checks nothing when the decisions directory holds no hyphenated record names', () => {
    const root = staged('const a = 0;\n', '// plain note\nconst a = 1;\n');
    writeFileSync(
      path.join(root, 'guard.config.json'),
      JSON.stringify({
        scanRoots: ['src'],
        sourceExtensions: ['tsx'],
        decisionsDir: '.',
        comments: { forbidDecisionRefs: true },
      }),
    );
    git(root, ['add', '.']);
    expect(cited(root)).toEqual([]);
  });

  it('exits 4 naming the key when a configured pattern does not compile', () => {
    const root = staged('const a = 0;\n', '// x\nconst a = 1;\n', { forbiddenRefs: ['sc-(\\d+'] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = runCommentFirewall(root, { emit: () => {} });
    const output = vi.mocked(console.error).mock.calls.flat().join('\n');
    vi.restoreAllMocks();
    expect(exit).toBe(4);
    expect(output).toContain('comments.forbiddenRefs[0]');
  });
});
