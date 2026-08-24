import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectChangedComments, parsePatchHunks, scanCommentTokens } from '../detect.mts';
import { runCommentFirewall } from '../gate.mts';

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

  it('distinguishes multi-line trailing explanations from comments followed by code', () => {
    const [trailingExplanation] = scanCommentTokens(
      'doHack(); /* first\n * second\n * third\n */\n',
      'ts',
    );
    const [followedByCode] = scanCommentTokens(
      '/* first\n * second\n * third\n */ doHack();\n',
      'ts',
    );
    const [followedByStructure] = scanCommentTokens(
      '/* first\n * second\n * third\n */ });\n',
      'ts',
    );
    expect(trailingExplanation?.standalone).toBe(true);
    expect(followedByCode?.standalone).toBe(false);
    expect(followedByStructure?.standalone).toBe(true);
  });

  it('treats JSX closing tags after a multi-line comment as structural', () => {
    const [token] = scanCommentTokens('{/* first\n * second\n * third\n */}</div>;\n', 'tsx');
    expect(token?.standalone).toBe(true);
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
  it('challenges only staged comment paragraphs with at least three text lines', () => {
    const root = fixture();
    writeFileSync(
      path.join(root, 'src/a.ts'),
      'const url = "https://example.test";\n// old note\n',
    );
    commitAll(root, 'base');

    writeFileSync(
      path.join(root, 'src/a.ts'),
      [
        'const url = "https://example.test";',
        '// short note changed',
        'const separatorA = 0;',
        '// two-line note',
        '// remains unchallenged',
        'const separatorB = 0;',
        '// first paragraph line',
        '// second paragraph line',
        '// third paragraph line',
        '/**',
        ' * first block line',
        ' * second block line',
        ' */',
        '/* first challenged block line',
        ' * second challenged block line',
        ' * third challenged block line',
        ' */',
        '',
      ].join('\n'),
    );
    git(root, ['add', 'src/a.ts']);
    writeFileSync(path.join(root, 'src/a.ts'), 'const url = "unstaged";\n');

    const result = detectChangedComments(root);
    expect(result.unsupported).toEqual([]);
    expect(result.findings.map((finding) => finding.comment)).toEqual([
      '// first paragraph line\n// second paragraph line\n// third paragraph line',
      '/* first challenged block line\n * second challenged block line\n * third challenged block line\n */',
    ]);
    expect(result.findings[1]).toMatchObject({ startLine: 14, endLine: 17 });
  });

  it('reconstructs a modified existing line-comment paragraph before attribution', () => {
    const root = fixture();
    writeFileSync(path.join(root, 'src/a.ts'), '// first\n// old second\n// third\nconst x = 1;\n');
    commitAll(root, 'base');
    writeFileSync(
      path.join(root, 'src/a.ts'),
      '// new first\n// new second\n// new third\nconst x = 1;\n',
    );
    git(root, ['add', 'src/a.ts']);

    expect(detectChangedComments(root).findings.map((item) => item.comment)).toEqual([
      '// new first\n// new second\n// new third',
    ]);
  });

  it('does not sweep an untouched two-line note into an adjacent one-line addition', () => {
    const root = fixture();
    writeFileSync(path.join(root, 'src/a.ts'), '// old first\n// old second\nconst x = 1;\n');
    commitAll(root, 'base');
    writeFileSync(
      path.join(root, 'src/a.ts'),
      '// old first\n// old second\n// new short note\nconst x = 1;\n',
    );
    git(root, ['add', 'src/a.ts']);
    expect(detectChangedComments(root).findings).toEqual([]);
  });

  it('groups adjacent one-line block comments into one staged paragraph', () => {
    const root = fixture();
    writeFileSync(
      path.join(root, 'src/a.ts'),
      [
        '/* This workaround skips validation in the legacy path. */',
        '/* It monkey-patches the result until the upstream fix lands. */',
        '/* Remove this branch when the tracked dependency is upgraded. */',
        'const x = 1;',
        '',
      ].join('\n'),
    );
    git(root, ['add', '.']);
    expect(detectChangedComments(root).findings.map((item) => item.comment)).toEqual([
      [
        '/* This workaround skips validation in the legacy path. */',
        '/* It monkey-patches the result until the upstream fix lands. */',
        '/* Remove this branch when the tracked dependency is upgraded. */',
      ].join('\n'),
    ]);
  });

  it('challenges a multi-line workaround opened after code but passes one followed by code', () => {
    const root = fixture();
    writeFileSync(
      path.join(root, 'src/a.ts'),
      [
        'doHack(); /* workaround detail one',
        ' * workaround detail two',
        ' * workaround detail three',
        ' */',
        '/* inline detail one',
        ' * inline detail two',
        ' * inline detail three',
        ' */ doOtherWork();',
        '/* structural detail one',
        ' * structural detail two',
        ' * structural detail three',
        ' */ });',
        '',
      ].join('\n'),
    );
    git(root, ['add', '.']);
    expect(detectChangedComments(root).findings.map((item) => item.comment)).toEqual([
      [
        '/* workaround detail one',
        ' * workaround detail two',
        ' * workaround detail three',
        ' */',
      ].join('\n'),
      [
        '/* structural detail one',
        ' * structural detail two',
        ' * structural detail three',
        ' */',
      ].join('\n'),
    ]);
  });

  it('does not count a CRLF block-comment closer as a third text line', () => {
    const root = fixture();
    writeFileSync(
      path.join(root, 'src/a.ts'),
      '/**\r\n * first documentation line\r\n * second documentation line\r\n */\r\nconst x = 1;\r\n',
    );
    git(root, ['add', '.']);
    expect(detectChangedComments(root).findings).toEqual([]);
  });

  it('ignores inline comments but does not exempt long file-header directives', () => {
    const root = fixture();
    writeFileSync(
      path.join(root, 'src/a.ts'),
      [
        '/*!',
        ' * @license',
        ' * Copyright Example Authors',
        ' * More license text',
        ' */',
        'const a = 1; // inline one',
        'const b = 2; // inline two',
        'const c = 3; // inline three',
        '',
      ].join('\n'),
    );
    writeFileSync(
      path.join(root, 'src/b.ts'),
      [
        '/** @generated',
        ' * Generated source file',
        ' * Do not edit this file directly',
        ' */',
        '',
      ].join('\n'),
    );
    git(root, ['add', '.']);
    expect(detectChangedComments(root).findings.map((item) => item.path)).toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
  });

  it('does not let bare preserve markers or non-header directives bypass review', () => {
    const root = fixture();
    writeFileSync(
      path.join(root, 'src/a.ts'),
      [
        'const value = 1;',
        '/*!',
        ' * workaround detail one',
        ' * workaround detail two',
        ' * workaround detail three',
        ' */',
        '// @preserve',
        '// workaround detail three',
        '// workaround detail four',
        '',
      ].join('\n'),
    );
    git(root, ['add', '.']);
    expect(detectChangedComments(root).findings.map((item) => item.comment)).toHaveLength(2);
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

describe('finding id stability', () => {
  const PARAGRAPH = [
    '// The wire format counts UTF-16 code units, not code points.',
    '// Surrogate pairs therefore consume two units on this path.',
    '// Callers slicing by code point must convert before indexing.',
  ].join('\n');

  const BASE = Array.from({ length: 24 }, (_, index) => `const base${index} = ${index};`);

  function withParagraph(extra: string[] = [], paragraph = PARAGRAPH): string {
    return [...extra, ...BASE.slice(0, 12), paragraph, ...BASE.slice(12), ''].join('\n');
  }

  function stagedId(root: string, source: string): string {
    writeFileSync(path.join(root, 'src/a.ts'), source);
    git(root, ['add', 'src/a.ts']);
    const findings = detectChangedComments(root).findings;
    if (findings.length !== 1) throw new Error(`expected one finding, got ${findings.length}`);
    return findings[0]?.id ?? '';
  }

  function baseRepo(): string {
    const root = fixture();
    writeFileSync(path.join(root, 'src/a.ts'), `${BASE.join('\n')}\n`);
    commitAll(root, 'base');
    return root;
  }

  it('survives an unrelated insertion far above it in the same file', () => {
    const root = baseRepo();
    const before = stagedId(root, withParagraph());
    const after = stagedId(root, withParagraph(['const inserted = 0;']));
    expect(after).toBe(before);
  });

  it('survives an unrelated insertion inside its own context window', () => {
    const root = baseRepo();
    const before = stagedId(root, withParagraph());
    const near = [...BASE.slice(0, 11), 'const inserted = 0;', ...BASE.slice(11, 12)];
    const after = stagedId(root, [...near, PARAGRAPH, ...BASE.slice(12), ''].join('\n'));
    expect(after).toBe(before);
  });

  it('still re-keys when the comment text itself changes', () => {
    const root = baseRepo();
    const before = stagedId(root, withParagraph());
    const edited = PARAGRAPH.replace('two units', 'three units');
    const after = stagedId(root, withParagraph([], edited));
    expect(after).not.toBe(before);
  });

  it('gives two byte-identical paragraphs in one file distinct ids', () => {
    const root = baseRepo();
    writeFileSync(
      path.join(root, 'src/a.ts'),
      [
        ...BASE.slice(0, 12),
        PARAGRAPH,
        'const separator = 0;',
        PARAGRAPH,
        ...BASE.slice(12),
        '',
      ].join('\n'),
    );
    git(root, ['add', 'src/a.ts']);
    const ids = detectChangedComments(root).findings.map((finding) => finding.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('finding id identity semantics', () => {
  const BLOCK = [
    '/* The retry budget is three attempts because the upstream',
    ' * gateway coalesces bursts inside a five second window.',
    ' * Exceeding it trips their per-tenant throttle.',
    ' */',
  ].join('\n');

  const INDENTED_BLOCK = [
    'function wrap(): void {',
    '  /* The retry budget is three attempts because the upstream',
    '   * gateway coalesces bursts inside a five second window.',
    '   * Exceeding it trips their per-tenant throttle.',
    '   */',
    '  return;',
    '}',
  ].join('\n');

  const TWIN = [
    '// The cache key omits the tenant on this legacy path.',
    '// Adding it would invalidate every warm entry at once.',
    '// The migration in SC-1 removes the exception entirely.',
  ].join('\n');

  function repoWith(committed: string): string {
    const root = fixture();
    writeFileSync(path.join(root, 'src/a.ts'), committed);
    commitAll(root, 'base');
    return root;
  }

  function stageAndDetect(root: string, source: string) {
    writeFileSync(path.join(root, 'src/a.ts'), source);
    git(root, ['add', 'src/a.ts']);
    return detectChangedComments(root).findings;
  }

  it('survives a re-indent when an extract refactor wraps the paragraph', () => {
    const root = repoWith('const anchor = 1;\n');
    const [flat] = stageAndDetect(root, `const anchor = 1;\n${BLOCK}\n`);
    const [indented] = stageAndDetect(root, `const anchor = 1;\n${INDENTED_BLOCK}\n`);
    expect(indented?.id).toBe(flat?.id);
  });

  it('reserves an ordinal for an untouched twin above the changed paragraph', () => {
    const alone = repoWith('const anchor = 1;\n');
    const [first] = stageAndDetect(alone, `const anchor = 1;\n${TWIN}\n`);

    const twinned = repoWith(`${TWIN}\nconst anchor = 1;\n`);
    const [second] = stageAndDetect(twinned, `${TWIN}\nconst anchor = 1;\n${TWIN}\n`);

    expect(second?.comment).toBe(first?.comment);
    expect(second?.id).not.toBe(first?.id);
  });

  it("never lets a byte-identical copy pasted above inherit its twin's rationale", () => {
    const root = repoWith('const anchor = 1;\n');
    const [original] = stageAndDetect(root, `const anchor = 1;\n${TWIN}\n`);
    commitAll(root, 'justified paragraph');

    const pastedAbove = stageAndDetect(root, `${TWIN}\nconst anchor = 1;\n${TWIN}\n`);
    expect(pastedAbove).toHaveLength(1);
    expect(pastedAbove[0]?.comment).toBe(original?.comment);
    expect(pastedAbove[0]?.id).not.toBe(original?.id);
  });
});

describe('gate outcome after an unrelated line shift', () => {
  const PARAGRAPH = [
    '// Offsets in this protocol are UTF-16 code units, not bytes.',
    '// A surrogate pair therefore advances the cursor by two.',
    '// Byte-based slicing corrupts every message past the first.',
  ].join('\n');
  const RATIONALE = {
    rationale: 'The external protocol defines offsets in UTF-16 code units, unlike byte length.',
    at: '2026-08-15T00:00:00.000Z',
  };

  it('routes a still-justified paragraph to review instead of blocking it again', () => {
    const root = fixture();
    const base = Array.from({ length: 24 }, (_, index) => `const base${index} = ${index};`);
    writeFileSync(path.join(root, 'src/a.ts'), `${base.join('\n')}\n`);
    commitAll(root, 'base');

    const body = (extra: string[]): string =>
      [...extra, ...base.slice(0, 12), PARAGRAPH, ...base.slice(12), ''].join('\n');
    writeFileSync(path.join(root, 'src/a.ts'), body([]));
    git(root, ['add', 'src/a.ts']);
    const justified = detectChangedComments(root).findings[0]?.id ?? '';
    expect(justified).toMatch(/^[0-9a-f]{12}$/);

    writeFileSync(path.join(root, 'src/a.ts'), body(['const inserted = 0;']));
    git(root, ['add', 'src/a.ts']);

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const judge = vi.fn(() => ({
      [justified]: { verdict: 'PASS' as const, reason: 'load-bearing' },
    }));
    const exit = runCommentFirewall(root, {
      loadRationales: () => ({ version: 1, entries: { [justified]: RATIONALE } }),
      loadReceipts: () => ({}),
      saveReceipt: () => true,
      judge,
      model: () => 'haiku',
      now: () => '2026-08-24T00:00:00.000Z',
      strict: () => false,
    });
    vi.restoreAllMocks();

    expect(judge).toHaveBeenCalledTimes(1);
    expect(exit).toBe(0);
  });
});
