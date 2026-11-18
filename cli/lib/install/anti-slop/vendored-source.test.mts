import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ANTI_SLOP_DEVKIT_RULE_IDS,
  ANTI_SLOP_RULE_IDS,
  ANTI_SLOP_UPSTREAM_RULE_IDS,
} from './constants.mts';

const PINNED_UPSTREAM_IMPLEMENTATION_DIGEST =
  'fb28449a39e1b3b79e0a7c1918f16879a6720b6221a55d72b9c160527325da60';

function sourceDigest(): { digest: string; files: string[] } {
  const root = join(import.meta.dirname, '../../../../anti-slop/src');
  const files = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => {
      const path = relative(root, file).split('\\').join('/');
      return path !== 'index.ts' && !path.startsWith('devkit/');
    })
    .sort((a, b) => relative(root, a).localeCompare(relative(root, b)));
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(relative(root, file).split('\\').join('/'));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return { digest: hash.digest('hex'), files };
}

describe('vendored anti-slop source', () => {
  it('keeps upstream implementations byte-pinned while composing Devkit extensions', () => {
    const source = sourceDigest();
    expect(source.files).toHaveLength(21);
    expect(source.digest).toBe(PINNED_UPSTREAM_IMPLEMENTATION_DIGEST);
    expect(ANTI_SLOP_UPSTREAM_RULE_IDS).toHaveLength(15);
    expect(ANTI_SLOP_DEVKIT_RULE_IDS).toEqual([
      'anti-slop/no-unsafe-external-record-access',
      'anti-slop/no-unsafe-external-record-enumeration',
      'anti-slop/no-elapsed-time-assertions',
    ]);
    expect(ANTI_SLOP_RULE_IDS).toHaveLength(18);
  });
});
