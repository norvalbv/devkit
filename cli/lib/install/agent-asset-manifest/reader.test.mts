import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readAgentAssetManifest } from './reader.mts';

const A = 'a'.repeat(64);
const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-asset-manifest-'));
  roots.push(root);
  return root;
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
