import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyGenerated,
  DEVKIT_GENERATED,
  generatedPathsFor,
  parseGeneratedConfig,
  renderCommand,
  renderConflictAbort,
} from './registry.mts';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function repo(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'gen-paths-'));
  roots.push(root);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body);
  return root;
}

/** A guard.config.json whose `generated` key holds this JSON value. */
const config = (generatedJson: string) => ({
  'guard.config.json': `{ "generated": ${generatedJson} }`,
});

describe('renderCommand', () => {
  it('keeps the consumer-facing `devkit …` form outside the devkit repo', () => {
    expect(renderCommand('devkit sync-skills', repo())).toBe('devkit sync-skills');
  });

  it('rewrites a leading `devkit ` to the source runner inside the devkit repo (self-host)', () => {
    const root = repo({ 'package.json': JSON.stringify({ name: '@norvalbv/devkit' }) });
    expect(renderCommand('devkit sync-skills', root)).toBe('node cli/index.mts sync-skills');
  });

  it('passes a non-devkit command through verbatim, even in self-host', () => {
    const root = repo({ 'package.json': JSON.stringify({ name: '@norvalbv/devkit' }) });
    expect(renderCommand('bun run build', root)).toBe('bun run build');
    // Only a leading WORD `devkit` is the runner — a word that merely starts with it is not.
    expect(renderCommand('devkitx build', root)).toBe('devkitx build');
  });
});

describe('parseGeneratedConfig', () => {
  it('returns [] when the key is absent', () => {
    expect(parseGeneratedConfig('{}')).toEqual([]);
    expect(parseGeneratedConfig('{"scanRoots": ["src"]}')).toEqual([]);
  });

  it('accepts well-formed entries, canonicalising a leading ./ and trimming only the command', () => {
    expect(
      parseGeneratedConfig(
        JSON.stringify({ generated: [{ glob: './gen/*.json', command: ' make gen ' }] }),
      ),
    ).toEqual([{ glob: 'gen/*.json', command: 'make gen' }]);
  });

  it('keeps glob whitespace verbatim — it is part of the Git path it must match', () => {
    const [entry] = parseGeneratedConfig(
      JSON.stringify({ generated: [{ glob: ' gen/**', command: 'x' }] }),
    );
    expect(entry.glob).toBe(' gen/**');
    expect(classifyGenerated([' gen/x', 'gen/x'], [entry])).toEqual({
      generated: [{ path: ' gen/x', command: 'x' }],
      other: ['gen/x'],
    });
  });

  it.each([
    ['a non-array', { glob: 'a', command: 'b' }],
    ['a non-object entry', ['gen/**']],
    ['a null entry', [null]],
    ['an unknown key', [{ glob: 'a', command: 'b', run: true }]],
    ['a missing command', [{ glob: 'a' }]],
    ['an empty glob', [{ glob: '', command: 'b' }]],
    ['a non-string command', [{ glob: 'a', command: ['make'] }]],
    ['an absolute glob', [{ glob: '/etc/*', command: 'b' }]],
    ['a parent-escaping glob', [{ glob: '../other/**', command: 'b' }]],
    ['a negated glob', [{ glob: '!gen/**', command: 'b' }]],
    ['a multi-line command', [{ glob: 'a', command: 'make\nrm -rf /' }]],
    // Every character a terminal renders as a break or a hidden effect, not just \r and \n.
    ['a command with U+2028 LINE SEPARATOR', [{ glob: 'a', command: 'make\u2028ship: ok' }]],
    ['a command with U+0085 NEXT LINE', [{ glob: 'a', command: 'make\u0085x' }]],
    ['a command with an ESC sequence', [{ glob: 'a', command: 'make \u001b[2K' }]],
    ['a command with a bidi override', [{ glob: 'a', command: 'make \u202egen' }]],
    ['a glob holding U+0001', [{ glob: 'dist/\u0001x', command: 'b' }]],
    // Outside the supported grammar (*, **, ?): refused, never silently half-supported.
    ['a character class', [{ glob: 'gen/[.]a.json', command: 'b' }]],
    ['a brace set', [{ glob: 'gen/{a,b}.json', command: 'b' }]],
    // Git reports canonical paths, so a `.`/empty segment could never match — reject, don't ignore.
    ['a glob with a `.` segment', [{ glob: 'dist/./**', command: 'b' }]],
    ['a glob with an empty segment', [{ glob: 'dist//x', command: 'b' }]],
    ['a glob with a trailing slash', [{ glob: 'gen/', command: 'b' }]],
  ])('rejects %s', (_label, value) => {
    expect(() => parseGeneratedConfig(JSON.stringify({ generated: value }))).toThrow(/generated/);
  });
});

describe('generatedPathsFor', () => {
  it('returns devkit defaults when no config exists', () => {
    expect(generatedPathsFor(repo())).toEqual(DEVKIT_GENERATED);
  });

  it('puts consumer entries first so a declared glob overrides a default for the same path', () => {
    const root = repo(
      config(
        JSON.stringify([
          { glob: '.devkit/skills-manifest.json', command: 'npx devkit sync-skills' },
          { glob: 'gen/**', command: 'make gen' },
        ]),
      ),
    );
    const entries = generatedPathsFor(root);
    expect(entries[0]).toEqual({
      glob: '.devkit/skills-manifest.json',
      command: 'npx devkit sync-skills',
    });
    // The overridden default is dropped, not listed twice.
    expect(entries.filter((e) => e.glob === '.devkit/skills-manifest.json')).toHaveLength(1);
    expect(entries.some((e) => e.glob === '.devkit/agents-manifest.json')).toBe(true);
  });

  it('throws on a malformed guard.config.json so the caller can fall back', () => {
    expect(() => generatedPathsFor(repo({ 'guard.config.json': '{ nope' }))).toThrow();
    expect(() => generatedPathsFor(repo(config('"dist/**"')))).toThrow(/generated/);
  });
});

describe('classifyGenerated', () => {
  const entries = [
    { glob: 'dist/**', command: 'bun run build' },
    { glob: 'gen/*.json', command: 'make gen' },
    ...DEVKIT_GENERATED,
  ];

  it('splits generated from hand-written paths, preserving input order in each list', () => {
    const out = classifyGenerated(
      ['src/a.mts', '.devkit/skills-manifest.json', 'dist/x/y.mjs', 'README.md'],
      entries,
    );
    expect(out.generated).toEqual([
      { path: '.devkit/skills-manifest.json', command: 'devkit sync-skills' },
      { path: 'dist/x/y.mjs', command: 'bun run build' },
    ]);
    expect(out.other).toEqual(['src/a.mts', 'README.md']);
  });

  it('treats every non-wildcard character literally, regex metacharacters included', () => {
    const entry = [{ glob: 'gen/a+(b)|c$.json', command: 'x' }];
    expect(classifyGenerated(['gen/a+(b)|c$.json'], entry).generated).toHaveLength(1);
    expect(classifyGenerated(['gen/aa(b)|c$xjson'], entry).generated).toEqual([]);
  });

  it.each([
    ['gen/?.json', 'gen/a.json', true],
    ['gen/?.json', 'gen/ab.json', false],
    ['gen/?.json', 'gen/..json', true],
    ['**/x.json', 'x.json', true],
    ['**/x.json', 'a/b/x.json', true],
    ['a/**/b', 'a/b', true],
    ['a/**/b', 'a/x/y/b', true],
    ['a/**/b', 'a/xb', false],
    ['dist/**', 'dist', false],
    ['dist/**', 'dist/a/b', true],
    ['**', '.cfg/a', true],
    ['gen/*.json', 'gen/é.json', true],
  ])('glob %s vs %s → %s', (glob, path, hit) => {
    expect(classifyGenerated([path], [{ glob, command: 'r' }]).generated.length === 1).toBe(hit);
  });

  it('does not match a single-star glob across directories', () => {
    expect(classifyGenerated(['gen/sub/a.json'], entries).other).toEqual(['gen/sub/a.json']);
  });

  it('treats a bare ** as every path, dot-directories included', () => {
    const out = classifyGenerated(['.cfg/a', 'b'], [{ glob: '**', command: 'regen' }]);
    expect(out.other).toEqual([]);
  });

  it('skips empty records and de-duplicates repeated paths', () => {
    const out = classifyGenerated(['', 'dist/a', 'dist/a', ''], entries);
    expect(out.generated).toEqual([{ path: 'dist/a', command: 'bun run build' }]);
    expect(out.other).toEqual([]);
  });

  // A Git path is an exact byte identity: whitespace is part of the name, never padding.
  it.each([' dist/x', 'dist ', '  '])(
    'keeps %j verbatim instead of trimming it into another path',
    (path) => {
      const out = classifyGenerated([path], entries);
      expect(out.generated).toEqual([]);
      expect(out.other).toEqual([path]);
    },
  );

  it('matches names holding tabs or newlines, as they arrive over the NUL-delimited channel', () => {
    const out = classifyGenerated(['gen/a\tb.json', 'dist/x\ny'], entries);
    expect(out.generated.map((m) => m.path)).toEqual(['gen/a\tb.json', 'dist/x\ny']);
  });

  // node's matchesGlob hides dot-entries from wildcards; a generated tree does not.
  it.each([
    ['dist/.cache/out.mjs', 'dist/**'],
    ['dist/.hidden', 'dist/**'],
    ['.cfg/api.json', '**/*.json'],
    ['gen/.a.json', 'gen/*.json'],
  ])('matches the dot-entry %s under %s', (path, glob) => {
    expect(classifyGenerated([path], [{ glob, command: 'regen' }]).generated).toHaveLength(1);
  });

  // A dot is an ordinary literal: no other character may stand in for it.
  it('never aliases another character onto a literal dot', () => {
    const entry = [{ glob: 'dist/.cache/**', command: 'r' }];
    expect(classifyGenerated(['dist/\u0001cache/x'], entry).other).toEqual(['dist/\u0001cache/x']);
    expect(classifyGenerated(['dist/.cache/x'], entry).generated).toHaveLength(1);
  });

  it('still refuses a single-star glob across a dot-directory boundary', () => {
    expect(
      classifyGenerated(['gen/.x/a.json'], [{ glob: 'gen/*.json', command: 'r' }]).other,
    ).toEqual(['gen/.x/a.json']);
  });

  it('uses the FIRST matching entry when globs overlap', () => {
    const out = classifyGenerated(
      ['gen/a.json'],
      [
        { glob: 'gen/**', command: 'first' },
        { glob: 'gen/*.json', command: 'second' },
      ],
    );
    expect(out.generated[0].command).toBe('first');
  });
});

describe('renderConflictAbort', () => {
  it('prints only the legacy hand-merge block when nothing is generated', () => {
    const text = renderConflictAbort({ generated: [], other: ['f.txt'] }, 'main').join('\n');
    expect(text).toContain('ship: origin/main and your working tree changed the same region of:');
    expect(text).toContain('  f.txt');
    expect(text).toContain('where you can see both sides');
    expect(text).not.toContain('generated');
  });

  it('names the generator and the ordered remedy, and never the hand-merge line, for generated-only', () => {
    const text = renderConflictAbort(
      {
        generated: [{ path: '.devkit/skills-manifest.json', command: 'devkit sync-skills' }],
        other: [],
      },
      'main',
    ).join('\n');
    expect(text).toContain('.devkit/skills-manifest.json');
    expect(text).toContain('`devkit sync-skills`');
    expect(text).toMatch(/do not hand-merge/i);
    expect(text).not.toContain('where you can see both sides');
    // Ordered: integrate the base BEFORE regenerating — regenerating first re-aborts, because the
    // patch is anchored at the fork point.
    const integrate = text.indexOf('origin/main');
    const regenerate = text.indexOf('`devkit sync-skills`');
    expect(integrate).toBeGreaterThan(-1);
    expect(integrate).toBeLessThan(regenerate);
  });

  it('lists mixed conflicts separately, attaching the hand-merge line only to hand-written paths', () => {
    const lines = renderConflictAbort(
      {
        generated: [{ path: 'dist/a.mjs', command: 'bun run build' }],
        other: ['src/f.mts'],
      },
      'main',
    );
    const handMerge = lines.findIndex((l) => l.includes('where you can see both sides'));
    const sameRegion = lines.findIndex((l) => l.includes('changed the same region of'));
    expect(sameRegion).toBeGreaterThan(-1);
    expect(handMerge).toBeGreaterThan(sameRegion);
    // The hand-merge section names src/f.mts and not dist/a.mjs.
    const handSection = lines.slice(sameRegion, handMerge + 1).join('\n');
    expect(handSection).toContain('src/f.mts');
    expect(handSection).not.toContain('dist/a.mjs');
  });

  it('groups paths that share a generator under one command', () => {
    const text = renderConflictAbort(
      {
        generated: [
          { path: 'dist/a.mjs', command: 'bun run build' },
          { path: '.devkit/skills-manifest.json', command: 'devkit sync-skills' },
          { path: 'dist/b.mjs', command: 'bun run build' },
        ],
        other: [],
      },
      'main',
    ).join('\n');
    expect(text.match(/`bun run build`/g)).toHaveLength(1);
    expect(text.indexOf('dist/b.mjs')).toBeLessThan(text.indexOf('`bun run build`'));
  });

  it('quotes a path containing whitespace or control characters so it cannot forge a line', () => {
    const text = renderConflictAbort(
      { generated: [{ path: 'gen/a b\nship: fake', command: 'x' }], other: ['c\td'] },
      'main',
    ).join('\n');
    expect(text).not.toMatch(/^ship: fake/m);
    expect(text).toContain('"c\\td"');
  });

  it.each(['\u2028', '\u2029', '\u0085', '\u001b', '\u202e', '\u200b'])(
    'escapes %j in a printed path so no terminal renders it as a break or hidden effect',
    (ch) => {
      const text = renderConflictAbort(
        { generated: [], other: [`gen/a${ch}ship: fake`] },
        'main',
      ).join('\n');
      expect(text).not.toContain(ch);
      expect(text).toContain(`\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
    },
  );
});
