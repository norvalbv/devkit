import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectChangedComments, parsePatchHunks, scanCommentTokens } from '../detect.mts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function fixture(extension = 'ts'): string {
  const root = mkdtempSync(path.join(tmpdir(), 'guard-comments-'));
  roots.push(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'comments@example.test']);
  git(root, ['config', 'user.name', 'Comment Test']);
  mkdirSync(path.join(root, 'src'));
  writeFileSync(
    path.join(root, 'guard.config.json'),
    `${JSON.stringify({ scanRoots: ['src'], sourceExtensions: [extension] })}\n`,
  );
  return root;
}

function commitAll(root: string, message: string): void {
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', message]);
}

describe('scanCommentTokens', () => {
  it('uses lexer trivia instead of treating delimiters inside literals as comments', () => {
    const source = [
      'const url = "https://example.test/a/*b*/";',
      'const pattern = /\\/\\/ not-a-comment/;',
      'const slashEnding = /^\\.\\//;',
      'const template = `value // still text`;',
      'const interpolated = `before $' + '{value} // still template text`;',
      'const nested = `before $' + '{' + '{ value: `inner $' + '{value} /* text */` }} // tail`;',
      '// durable invariant',
      'const x = 1; /* block reason */',
    ].join('\n');
    expect(scanCommentTokens(source, 'ts').map((token) => token.text)).toEqual([
      '// durable invariant',
      '/* block reason */',
    ]);
  });

  it('reconstructs a complete multi-line token', () => {
    const [token] = scanCommentTokens('/* first\n * second\n */\nconst x = 1;', 'ts');
    expect(token).toMatchObject({ startLine: 1, endLine: 3, kind: 'block' });
    expect(token?.text).toBe('/* first\n * second\n */');
  });
});

describe('parsePatchHunks', () => {
  it('does not advance the new line for a no-newline marker', () => {
    const hunks = parsePatchHunks(
      '@@ -1 +1,2 @@\n-old\n\\ No newline at end of file\n+new\n+// reason',
    );
    expect([...hunks[0].addedLines]).toEqual([1, 2]);
  });

  it('treats source beginning with diff-header characters as hunk content', () => {
    const hunks = parsePatchHunks(
      'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,3 @@\n value\n+++counter;\n+// reason',
    );
    expect([...hunks[0].addedLines]).toEqual([2, 3]);
  });
});

describe('detectChangedComments', () => {
  it('challenges added and modified staged comments as whole tokens, using the index only', () => {
    const root = fixture();
    writeFileSync(
      path.join(root, 'src/a.ts'),
      'const url = "https://example.test";\n// old note\n',
    );
    commitAll(root, 'base');

    writeFileSync(
      path.join(root, 'src/a.ts'),
      'const url = "https://example.test";\n// durable constraint changed\n/* first\n * second\n */\n',
    );
    git(root, ['add', 'src/a.ts']);
    writeFileSync(path.join(root, 'src/a.ts'), 'const url = "unstaged";\n');

    const result = detectChangedComments(root);
    expect(result.unsupported).toEqual([]);
    expect(result.findings.map((finding) => finding.comment)).toEqual([
      '// durable constraint changed',
      '/* first\n * second\n */',
    ]);
    expect(result.findings[1]).toMatchObject({ startLine: 3, endLine: 5 });
  });

  it('grandfathers untouched comments and ignores deletions', () => {
    const root = fixture();
    writeFileSync(
      path.join(root, 'src/a.ts'),
      '// inherited debt\nconst value = 1;\n// remove me\n',
    );
    commitAll(root, 'base');
    writeFileSync(path.join(root, 'src/a.ts'), '// inherited debt\nconst value = 2;\n');
    git(root, ['add', 'src/a.ts']);
    expect(detectChangedComments(root).findings).toEqual([]);
  });

  it('does not fire on a pure rename', () => {
    const root = fixture();
    writeFileSync(path.join(root, 'src/a.ts'), '// invariant\nconst value = 1;\n');
    commitAll(root, 'base');
    git(root, ['mv', 'src/a.ts', 'src/b.ts']);
    expect(detectChangedComments(root).findings).toEqual([]);
  });

  it('reports a configured staged extension with no lexer adapter', () => {
    const root = fixture('py');
    writeFileSync(path.join(root, 'src/a.py'), '# explanation\nvalue = 1\n');
    git(root, ['add', '.']);
    expect(detectChangedComments(root)).toMatchObject({
      findings: [],
      unsupported: [{ extension: 'py', path: 'src/a.py' }],
    });
  });
});
