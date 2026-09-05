import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildCappedDiffEvidence } from '../../../../../diff-evidence.mts';
import { measureSpan, type RequiredSpan } from '../visibility.mts';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const span = (
  file: string,
  content: string,
  start = 1,
  end = start,
  side: 'base' | 'post' = 'post',
): RequiredSpan => ({
  file,
  side,
  start,
  end,
  fileSha256: hash(content),
  spanSha256: hash(
    content
      .split('\n')
      .slice(start - 1, end)
      .join('\n'),
  ),
});

function added(file: string, content: string): string {
  const lines = content.split('\n');
  if (content.endsWith('\n')) lines.pop();
  return `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}\n`).join('')}${content.endsWith('\n') ? '' : '\\ No newline at end of file\n'}`;
}

function evidence(post: Record<string, string>, inventory = 'file inventory') {
  const diff = Object.entries(post)
    .map(([file, content]) => added(file, content))
    .join('');
  return {
    base: {},
    post,
    selectedFiles: Object.keys(post),
    diff,
    rendered: buildCappedDiffEvidence(diff, inventory),
  };
}

const pressure = () =>
  Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`file${i}.ts`, `${'x'.repeat(9000)}\n`]));

describe('required-span initial diff visibility', () => {
  it('keeps an over-8k file intact on the native under-60k fast path', () => {
    const content = `${'é😀'.repeat(4000)}\n++counter;\n`;
    const input = evidence({ 'file.ts': content });
    expect(input.diff.length).toBeGreaterThan(8000);
    expect(input.diff.length).toBeLessThan(60000);
    expect(measureSpan(span('file.ts', content, 1, 2), input)).toEqual({
      status: 'supplied',
      shownLines: 2,
      totalLines: 2,
    });
  });

  it('uses the native 60k boundary and never counts a partial source line', () => {
    const empty = evidence({ 'file.ts': '\n' });
    const content = `${'x'.repeat(60000 - empty.diff.length)}\n`;
    const below = evidence({ 'file.ts': content });
    expect(below.diff.length).toBe(60000);
    expect(measureSpan(span('file.ts', content), below).status).toBe('supplied');
    const longer = `x${content}`;
    const above = evidence({ 'file.ts': longer });
    expect(above.diff.length).toBe(60001);
    expect(measureSpan(span('file.ts', longer), above)).toEqual({
      status: 'truncated',
      shownLines: 0,
      totalLines: 1,
    });
  });

  it('does not mistake the marker newline for a source-line terminator cut by the cap', () => {
    const headerLength = added('first.ts', '\nlast\n').indexOf('\n+') + 1;
    // Skip the +++ file header: the source starts immediately after the hunk header.
    const sourceStart = added('first.ts', '\nlast\n').indexOf('@@\n') + 3;
    expect(sourceStart).toBeGreaterThan(headerLength);
    const content = `${'x'.repeat(8000 - sourceStart - 1)}\nlast\n`;
    const input = evidence({ 'first.ts': content, ...pressure() });
    expect(input.rendered).toContain(`${'x'.repeat(20)}\n[TRUNCATED:`);
    expect(measureSpan(span('first.ts', content), input)).toEqual({
      status: 'truncated',
      shownLines: 0,
      totalLines: 1,
    });
  });

  it('distinguishes a partially shown span from later truncated and omitted spans', () => {
    const first = `ready();\n${'x'.repeat(9000)}\nlast();\n`;
    const post = { ...pressure(), 'file0.ts': first };
    const input = evidence(post);
    expect(measureSpan(span('file0.ts', first, 1, 3), input)).toEqual({
      status: 'partial',
      shownLines: 1,
      totalLines: 3,
    });
    expect(measureSpan(span('file0.ts', first, 3), input).status).toBe('truncated');
    expect(measureSpan(span('file8.ts', post['file8.ts']), input).status).toBe('omitted');
  });

  it('does not let inventory, omission path names, or text in another file supply an omitted span', () => {
    const content = 'required();\n';
    const post = { 'first.ts': content, ...pressure(), 'last-required.ts': content };
    const inventory = `${added('last-required.ts', content)}\n${content}last-required.ts`;
    const input = evidence(post, inventory);
    expect(input.rendered).toContain('OMITTED: last-required.ts');
    expect(measureSpan(span('last-required.ts', content), input)).toEqual({
      status: 'omitted',
      shownLines: 0,
      totalLines: 1,
    });
  });

  it('maps both sides by hunk coordinates, including unchanged context and no-newline markers', () => {
    const base = 'same\nold\n++counter;';
    const post = 'same\nnew\n++counter;';
    const diff =
      'diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,3 @@\n same\n-old\n+new\n ++counter;\n\\ No newline at end of file\n';
    const input = {
      base: { 'file.ts': base },
      post: { 'file.ts': post },
      selectedFiles: ['file.ts'],
      diff,
      rendered: buildCappedDiffEvidence(diff, ''),
    };
    expect(measureSpan(span('file.ts', base, 1, 3, 'base'), input).shownLines).toBe(3);
    expect(measureSpan(span('file.ts', post, 1, 3), input).shownLines).toBe(3);
  });

  it('does not confuse added source beginning with ++ for a file header', () => {
    const content = '++counter;\n';
    expect(measureSpan(span('file.ts', content), evidence({ 'file.ts': content })).status).toBe(
      'supplied',
    );
  });

  it('uses rename source paths for base spans and selected destination paths for scope', () => {
    const old = 'old\n';
    const current = 'new\n';
    const diff =
      'diff --git "a/caf\\303\\251.ts" "b/new\\tname.ts"\nrename from "caf\\303\\251.ts"\nrename to "new\\tname.ts"\n--- "a/caf\\303\\251.ts"\n+++ "b/new\\tname.ts"\n@@ -1 +1 @@\n-old\n+new\n';
    const input = {
      base: { 'café.ts': old },
      post: { 'new\tname.ts': current },
      selectedFiles: ['"new\\tname.ts"'],
      diff,
      rendered: buildCappedDiffEvidence(diff, ''),
    };
    expect(measureSpan(span('café.ts', old, 1, 1, 'base'), input).status).toBe('supplied');
    expect(measureSpan(span('new\tname.ts', current), input).status).toBe('supplied');
    expect(
      measureSpan(span('café.ts', old, 1, 1, 'base'), { ...input, selectedFiles: [] }).status,
    ).toBe('out-of-scope');
    expect(
      measureSpan(span('café.ts', old, 1, 1, 'base'), { ...input, selectedFiles: ['café.ts'] })
        .status,
    ).toBe('out-of-scope');
  });

  it('maps deleted base files and unquoted paths with spaces', () => {
    const content = 'gone\n';
    const diff =
      'diff --git a/old file.ts b/old file.ts\ndeleted file mode 100644\n--- a/old file.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n';
    const input = {
      base: { 'old file.ts': content },
      post: { 'old file.ts': null },
      selectedFiles: ['old file.ts'],
      diff,
      rendered: buildCappedDiffEvidence(diff, ''),
    };
    expect(measureSpan(span('old file.ts', content, 1, 1, 'base'), input).status).toBe('supplied');
  });

  it('distinguishes source outside hunks from source outside the selected task', () => {
    const content = 'outside\nnew\n';
    const diff =
      'diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -2 +2 @@\n-old\n+new\n';
    const input = {
      base: {},
      post: { 'file.ts': content, 'other.ts': content },
      selectedFiles: ['file.ts'],
      diff,
      rendered: buildCappedDiffEvidence(diff, ''),
    };
    expect(measureSpan(span('file.ts', content), input).status).toBe('not-in-diff');
    expect(measureSpan(span('file.ts', content, 1, 2), input)).toEqual({
      status: 'partial',
      shownLines: 1,
      totalLines: 2,
    });
    expect(measureSpan(span('other.ts', content), input).status).toBe('out-of-scope');
  });

  it('fails closed with generic errors for invalid binding, source range, and non-native evidence', () => {
    const content = 'valid\n';
    const input = evidence({ 'file.ts': content });
    const required = span('file.ts', content);
    for (const invalid of [
      { fileSha256: hash('other') },
      { spanSha256: hash('other') },
      { start: 0 },
      { end: 2 },
      { file: 'missing.ts' },
    ]) {
      expect(() => measureSpan({ ...required, ...invalid }, input)).toThrow(
        'INVALID_REQUIRED_SPAN',
      );
    }
    expect(() => measureSpan(required, { ...input, rendered: 'valid' })).toThrow(
      'INVALID_RENDERED_EVIDENCE',
    );
    const changed = input.diff.replace('+valid', '+other');
    expect(() =>
      measureSpan(required, {
        ...input,
        diff: changed,
        rendered: buildCappedDiffEvidence(changed, ''),
      }),
    ).toThrow('INVALID_DIFF_EVIDENCE');
  });
});
