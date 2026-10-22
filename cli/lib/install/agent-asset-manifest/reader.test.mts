import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { testSpawnSync } from '../../../__tests__/_helpers.mts';
import { encodeSyncManifestV2, type SyncManifestV2 } from './codec.mts';
import { readAgentAssetManifest } from './reader.mts';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-asset-manifest-'));
  roots.push(root);
  return root;
}

function v2(
  files: Record<string, string>,
  providers: SyncManifestV2['providers'] = { claude: { files } },
): string {
  return encodeSyncManifestV2(
    { schemaVersion: 2, kind: 'skills', devkitRef: 'v1.0.0', files, providers },
    'skills',
  );
}

function conflict(ours: string, theirs: string): string {
  return `<<<<<<< ours\n${ours}\n=======\n${theirs}\n>>>>>>> theirs\n`;
}

/** Real git conflict markers, in the given `merge.conflictStyle`. */
function mergeFile(
  root: string,
  style: string,
  base: string,
  ours: string,
  theirs: string,
): string {
  for (const [name, content] of Object.entries({ base, ours, theirs }))
    writeFileSync(join(root, name), content);
  const merged = testSpawnSync(
    'git',
    ['merge-file', '-p', ...(style === 'merge' ? [] : [`--${style}`]), 'ours', 'base', 'theirs'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  return merged.stdout;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('readAgentAssetManifest', () => {
  it('returns absence or the strictly decoded manifest union directly', () => {
    const path = join(tempRoot(), 'skills-manifest.json');
    expect(readAgentAssetManifest(path, 'skills')).toBeNull();
    writeFileSync(path, JSON.stringify({ files: { 'brainstorming/SKILL.md': A } }));
    expect(readAgentAssetManifest(path, 'skills')).toEqual({
      version: 1,
      manifest: {
        files: { 'brainstorming/SKILL.md': A },
        targets: ['claude', 'cursor'],
      },
    });
  });

  it.each([
    ['oversized bytes', Buffer.alloc(1024 * 1024 + 1), /1 MiB/],
    ['invalid UTF-8', Buffer.from([0xff]), /UTF-8/],
    [
      'duplicate object keys',
      Buffer.from(`{"files":{},"files":{"brainstorming/SKILL.md":"${A}"}}`),
      /duplicate object field "files"/,
    ],
    ['invalid JSON', Buffer.from('{"files":'), /valid JSON/],
  ])('rejects %s before schema decoding', (_name, content, error) => {
    const path = join(tempRoot(), 'skills-manifest.json');
    writeFileSync(path, content);
    expect(() => readAgentAssetManifest(path, 'skills')).toThrow(error);
  });

  it.each(['merge', 'diff3', 'zdiff3'])(
    'decodes %s-style conflict markers as the union of both sides, ours winning a hash clash',
    (style) => {
      const root = tempRoot();
      const base = v2({ 'alpha/SKILL.md': A, 'beta/SKILL.md': A });
      const ours = v2({ 'alpha/SKILL.md': B, 'beta/SKILL.md': A, 'ours/SKILL.md': A });
      const theirs = v2({ 'alpha/SKILL.md': C, 'beta/SKILL.md': A, 'theirs/SKILL.md': A });
      const path = join(root, 'skills-manifest.json');
      writeFileSync(path, mergeFile(root, style, base, ours, theirs));
      expect(readFileSync(path, 'utf8')).toMatch(/^<{7} /m);

      const files = {
        'alpha/SKILL.md': B,
        'beta/SKILL.md': A,
        'ours/SKILL.md': A,
        'theirs/SKILL.md': A,
      };
      expect(readAgentAssetManifest(path, 'skills')).toEqual({
        version: 2,
        manifest: {
          schemaVersion: 2,
          kind: 'skills',
          devkitRef: 'v1.0.0',
          files,
          providers: { claude: { files } },
        },
      });
    },
  );

  // A branch that added a provider target must keep it owned, or its outputs would turn foreign.
  it('keeps a provider record only one side has', () => {
    const path = join(tempRoot(), 'skills-manifest.json');
    const alpha = { 'alpha/SKILL.md': A };
    const both = { 'alpha/SKILL.md': A, 'beta/SKILL.md': B };
    writeFileSync(
      path,
      conflict(v2(alpha), v2(both, { claude: { files: alpha }, codex: { files: both } })),
    );
    expect(readAgentAssetManifest(path, 'skills')).toMatchObject({
      version: 2,
      manifest: { files: both, providers: { claude: { files: alpha }, codex: { files: both } } },
    });
  });

  it('drops a one-sided record whose copy in this checkout diverges from it', () => {
    const root = tempRoot();
    const sha = createHash('sha256').update('# beta\n').digest('hex');
    for (const [name, content] of [
      ['beta', '# beta\n'],
      ['gamma', '# my own gamma\n'],
    ]) {
      mkdirSync(join(root, '.claude/skills', name), { recursive: true });
      writeFileSync(join(root, '.claude/skills', name, 'SKILL.md'), content);
    }
    const path = join(root, '.devkit', 'skills-manifest.json');
    mkdirSync(dirname(path));
    const ours = JSON.stringify({ files: { 'alpha/SKILL.md': A }, targets: ['claude'] });
    const theirs = { 'beta/SKILL.md': sha, 'gamma/SKILL.md': B };
    writeFileSync(path, conflict(ours, JSON.stringify({ files: theirs, targets: ['claude'] })));
    expect(readAgentAssetManifest(path, 'skills')?.manifest.files).toEqual({
      'alpha/SKILL.md': A,
      'beta/SKILL.md': sha,
    });
  });

  it('splits CRLF markers and unions legacy v1 targets', () => {
    const path = join(tempRoot(), 'skills-manifest.json');
    const ours = JSON.stringify({ files: { 'alpha/SKILL.md': A }, targets: ['claude'] });
    const theirs = JSON.stringify({ files: { 'beta/SKILL.md': A }, targets: ['cursor'] });
    writeFileSync(path, conflict(ours, theirs).replaceAll('\n', '\r\n'));
    expect(readAgentAssetManifest(path, 'skills')).toEqual({
      version: 1,
      manifest: {
        files: { 'alpha/SKILL.md': A, 'beta/SKILL.md': A },
        targets: ['claude', 'cursor'],
      },
    });
  });

  it.each([
    ['an undecodable side', conflict(v2({ 'alpha/SKILL.md': A }), '{"files":'), /valid JSON/],
    ['mixed schema versions', conflict(v2({}), JSON.stringify({ files: {} })), /schema versions/],
    ['an unterminated hunk', '<<<<<<< ours\n{}\n=======\n{}\n', /unterminated/],
    ['an out-of-order marker', '=======\n{}\n', /out of order/],
  ])('refuses a conflicted manifest with %s, naming the remedy', (_name, content, reason) => {
    const path = join(tempRoot(), 'skills-manifest.json');
    writeFileSync(path, content);
    expect(() => readAgentAssetManifest(path, 'skills')).toThrow(reason);
    expect(() => readAgentAssetManifest(path, 'skills')).toThrow(
      /unresolved merge conflict markers.*git checkout --ours/,
    );
  });

  it('rejects symlinks and non-regular leaves', () => {
    const root = tempRoot();
    const target = join(root, 'target.json');
    writeFileSync(target, JSON.stringify({ files: {} }));
    const link = join(root, 'link.json');
    symlinkSync(target, link);
    expect(() => readAgentAssetManifest(link, 'skills')).toThrow(/symlink/);

    const directory = join(root, 'directory.json');
    mkdirSync(directory);
    expect(() => readAgentAssetManifest(directory, 'skills')).toThrow(/regular file/);
  });
});
