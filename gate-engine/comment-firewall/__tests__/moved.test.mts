import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectChangedComments } from '../detect.mts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

const RATIONALE = [
  '// The cache key is the blob, not the path.',
  '// A rename therefore keeps its verdict.',
  '// An edit to the blob always re-runs it.',
  '// Twins in one file share one key.',
  '// The ordinal separates them.',
  '// Context never enters the key.',
];
const helper = (rationale = RATIONALE) =>
  [
    ...rationale,
    'export function helper(): number {',
    '  // Names the artifact so a borrowed verdict is visible (sc-3491)',
    '  return 1;',
    '}',
    '',
  ].join('\n');
const filler = (name: string, count = 60) =>
  Array.from({ length: count }, (_, index) => `export const ${name}${index} = ${index};\n`).join(
    '',
  );

/** A repo whose base commit holds `base` under src/. */
function repo(base: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'guard-comments-moved-'));
  roots.push(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'moved@example.test']);
  git(root, ['config', 'user.name', 'Moved Test']);
  mkdirSync(path.join(root, 'src'));
  writeFileSync(
    path.join(root, 'guard.config.json'),
    JSON.stringify({
      scanRoots: ['src'],
      sourceExtensions: ['ts'],
      comments: { forbiddenRefs: ['\\bsc-\\d+\\b'] },
    }),
  );
  stage(root, base);
  git(root, ['commit', '-qm', 'base']);
  return root;
}

/** Writes then stages `files` under src/; a null value deletes the file. */
function stage(root: string, files: Record<string, string | null>): void {
  const entries = Object.entries(files);
  for (const [name, contents] of entries) {
    if (contents === null) continue;
    mkdirSync(path.dirname(path.join(root, 'src', name)), { recursive: true });
    writeFileSync(path.join(root, 'src', name), contents);
  }
  for (const [name, contents] of entries) {
    if (contents === null) git(root, ['rm', '-q', `src/${name}`]);
  }
  git(root, ['add', '-A']);
}

const indent = (text: string) => text.replace(/^(?=.)/gm, '  ');
const flagged = (root: string) => {
  const { findings, refFindings } = detectChangedComments(root);
  return {
    paragraphs: findings.map((finding) => finding.path),
    refs: refFindings.map((finding) => finding.path),
  };
};
const clean = { paragraphs: [], refs: [] };

describe('comments moved verbatim between staged files', () => {
  it('excuses a commented function extracted into a new file git does not pair as a rename', () => {
    const root = repo({ 'a.ts': filler('v') + helper() });
    stage(root, { 'a.ts': filler('v'), 'b.ts': helper() });
    expect(git(root, ['diff', '--cached', '--name-status'])).toMatch(/^A\tsrc\/b\.ts$/m);
    expect(flagged(root)).toEqual(clean);
  });

  it('still blocks the same comments written fresh with no matching removal', () => {
    const root = repo({ 'a.ts': filler('v') });
    stage(root, { 'b.ts': helper() });
    expect(flagged(root)).toEqual({ paragraphs: ['src/b.ts'], refs: ['src/b.ts'] });
  });

  it('blocks a moved paragraph with one word changed, while its unchanged citing line stays excused', () => {
    const root = repo({ 'a.ts': filler('v') + helper() });
    const edited = RATIONALE.map((line, index) =>
      index === 1 ? line.replace('keeps', 'loses') : line,
    );
    stage(root, { 'a.ts': filler('v'), 'b.ts': helper(edited) });
    expect(flagged(root)).toEqual({ paragraphs: ['src/b.ts'], refs: [] });
  });

  it('excuses one copy only, deterministically, when a moved comment is also pasted elsewhere', () => {
    const root = repo({ 'a.ts': filler('v') + helper() });
    stage(root, { 'a.ts': filler('v'), 'b.ts': helper(), 'c.ts': helper() });
    const expected = { paragraphs: ['src/c.ts'], refs: ['src/c.ts'] };
    expect(flagged(root)).toEqual(expected);
    expect(flagged(root)).toEqual(expected);
  });

  it('excuses a moved comment that shared a blank-separated paragraph with one that stayed', () => {
    const moved = '// Names the artifact (sc-1)\nexport const A = 1;\n';
    const root = repo({ 'a.ts': `${filler('v')}// Section: loaders.\n\n${moved}` });
    stage(root, { 'a.ts': `${filler('v')}// Section: loaders.\n\n`, 'b.ts': moved });
    expect(flagged(root)).toEqual(clean);
  });

  it('excuses a moved comment placed one blank line under an existing comment', () => {
    const root = repo({
      'a.ts': filler('v') + helper(),
      'b.ts': '// Existing note.\n\nexport const z = 0;\n',
    });
    stage(root, {
      'a.ts': filler('v'),
      'b.ts': `// Existing note.\n\n${helper()}export const z = 0;\n`,
    });
    expect(flagged(root)).toEqual(clean);
  });

  it('excuses a move whose first comment line also opens the next paragraph in the source', () => {
    const next = `${RATIONALE[0]}\n// A different second line.\n// A different third line.\nexport const after = 2;\n`;
    const root = repo({ 'a.ts': filler('v') + helper() + next });
    stage(root, { 'a.ts': filler('v') + next, 'b.ts': helper() });
    expect(flagged(root)).toEqual(clean);
  });

  it('excuses a moved JSDoc block, whose delimiter lines carry no text', () => {
    const doc = ['/**', ...RATIONALE.map((line) => line.replace('//', ' *')), ' */'];
    const root = repo({ 'a.ts': filler('v') + helper(doc) });
    stage(root, { 'a.ts': filler('v'), 'b.ts': helper(doc) });
    expect(flagged(root)).toEqual(clean);
  });

  it('excuses comments from a deleted file landing in an unrelated new one', () => {
    const root = repo({ 'a.ts': filler('v') + helper() });
    stage(root, { 'a.ts': null, 'z.ts': filler('w') + helper() });
    expect(git(root, ['diff', '--cached', '--name-status'])).toMatch(/^D\tsrc\/a\.ts$/m);
    expect(flagged(root)).toEqual(clean);
  });

  it('skips oversized and non-source removals instead of failing the gate', () => {
    const huge = `${'x'.repeat(17 * 1024 * 1024)}\n`;
    const root = repo({
      'a.ts': filler('v') + helper(),
      'blob.bin': huge,
      'big.ts': `${RATIONALE[0]}\nexport const s = "${huge.trim()}";\n`,
    });
    stage(root, { 'a.ts': filler('v'), 'b.ts': helper(), 'blob.bin': null, 'big.ts': null });
    expect(flagged(root)).toEqual(clean);
  });

  it('finds the source in a package subdirectory even when grep.fullName is configured', () => {
    const config = { scanRoots: ['src'], comments: { forbiddenRefs: ['\\bsc-\\d+\\b'] } };
    const root = repo({
      'pkg/guard.config.json': JSON.stringify(config),
      'pkg/src/a.ts': filler('v') + helper(),
    });
    git(root, ['config', 'grep.fullName', 'true']);
    stage(root, { 'pkg/src/a.ts': filler('v'), 'pkg/src/b.ts': helper() });
    expect(flagged(path.join(root, 'src', 'pkg'))).toEqual(clean);
  });

  it('reads removals from the old side of a source file renamed in the same commit', () => {
    const root = repo({ 'a.ts': filler('v') + helper() });
    stage(root, { 'a.ts': null, 'a2.ts': filler('v'), 'b.ts': helper() });
    expect(git(root, ['diff', '--cached', '--name-status'])).toMatch(
      /^R\d+\tsrc\/a\.ts\tsrc\/a2\.ts$/m,
    );
    expect(flagged(root)).toEqual(clean);
  });

  it('ignores CRLF line endings and re-indentation of a moved JSDoc block', () => {
    const doc = ['/**', ...RATIONALE.map((line) => line.replace('//', ' *')), ' */'];
    const crlf = (text: string) => text.replaceAll('\n', '\r\n');
    const root = repo({ 'a.ts': crlf(filler('v') + helper(doc)) });
    stage(root, {
      'a.ts': crlf(filler('v')),
      'b.ts': `export namespace N {\n${indent(helper(doc))}}\n`,
    });
    expect(flagged(root)).toEqual(clean);
  });

  it('matches comment text literally, never as a pattern', () => {
    const moved = '// -x [a-z]+ $HOME \\d (sc-1)\nexport const A = 1;\n';
    const root = repo({ 'a.ts': filler('v') + moved });
    stage(root, { 'a.ts': filler('v'), 'b.ts': moved });
    expect(flagged(root)).toEqual(clean);
  });

  it('excuses text moved in from outside the scanned roots', () => {
    const root = repo({ '../lib/a.ts': filler('v') + helper() });
    stage(root, { '../lib/a.ts': filler('v'), 'b.ts': helper() });
    expect(flagged(root)).toEqual(clean);
  });

  it('excuses a paragraph moved to a distant hunk of the same file', () => {
    const root = repo({ 'a.ts': helper() + filler('v') });
    stage(root, { 'a.ts': filler('v') + helper() });
    expect(flagged(root)).toEqual(clean);
  });

  it('does not let a deletion merged in from the other parent excuse a copy the resolution adds', () => {
    const root = repo({ 'a.ts': filler('v') + helper() });
    const trunk = git(root, ['branch', '--show-current']).trim();
    git(root, ['switch', '-qc', 'theirs']);
    stage(root, { 'a.ts': filler('v') });
    git(root, ['commit', '-qm', 'drop helper']);
    git(root, ['switch', '-q', trunk]);
    git(root, ['merge', '-q', '--no-ff', '--no-commit', 'theirs']);
    stage(root, { 'b.ts': helper() });
    expect(flagged(root)).toEqual({ paragraphs: ['src/b.ts'], refs: ['src/b.ts'] });
  });
});
