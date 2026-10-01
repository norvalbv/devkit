import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyScanRoots } from '../lib/install/init/scan-roots.mts';

const roots: string[] = [];
const mkTmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'scan-roots-'));
  roots.push(d);
  return d;
};
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

const cfgPath = (root: string) => join(root, 'guard.config.json');

describe('applyScanRoots', () => {
  it('adds scanRoots by JSON round-trip when the key is absent, keeping every other key', () => {
    const root = mkTmp();
    writeFileSync(cfgPath(root), JSON.stringify({ fanoutCap: 12, review: { on: true } }));

    applyScanRoots(root, ['services/webapp/src'], false);

    expect(JSON.parse(readFileSync(cfgPath(root), 'utf8'))).toEqual({
      fanoutCap: 12,
      review: { on: true },
      scanRoots: ['services/webapp/src'],
    });
  });

  it('writes nothing on dry-run, with no roots, or when guard.config.json was never written', () => {
    const root = mkTmp();
    const before = '{ "scanRoots": ["src"] }\n';
    writeFileSync(cfgPath(root), before);

    applyScanRoots(root, ['lib'], true);
    applyScanRoots(root, [], false);
    applyScanRoots(root, null, false);
    expect(readFileSync(cfgPath(root), 'utf8')).toBe(before);

    const bare = mkTmp();
    applyScanRoots(bare, ['lib'], false);
    expect(existsSync(cfgPath(bare))).toBe(false);
  });

  it.each([
    ['a root containing `]`', '{ "scanRoots": ["old]root"], "//scanRoots": "keep" }', ['src']],
    ['an escaped quote', '{ "scanRoots": ["a\\"]b"], "//scanRoots": "keep" }', ['src']],
    [
      'a replacement token in the new root',
      '{ "scanRoots": ["src"], "//scanRoots": "keep" }',
      ['$&', "$'"],
    ],
    [
      'a decoy key inside an earlier string value',
      '{ "//note": "\\"scanRoots\\": [\\"decoy\\"]", "scanRoots": ["src"] }',
      ['lib'],
    ],
  ])('sets only the real scanRoots key for %s', (_label, before, next) => {
    const root = mkTmp();
    writeFileSync(cfgPath(root), before);

    applyScanRoots(root, next, false);

    expect(JSON.parse(readFileSync(cfgPath(root), 'utf8'))).toEqual({
      ...JSON.parse(before),
      scanRoots: next,
    });
  });
});
