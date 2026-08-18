import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ANTI_SLOP_RULE_IDS } from './constants.mts';

const PINNED_PRODUCTION_DIGEST = 'b92b5ec53886d609ba77cdd14578b9c5a813a22c8bfc7e86cd3a4e85ee4091b7';

function sourceDigest(): { digest: string; files: string[] } {
  const root = join(import.meta.dirname, '../../../../anti-slop/src');
  const files = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
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
  it('matches the reviewed upstream production tree and complete rule registry', () => {
    const source = sourceDigest();
    expect(source.files).toHaveLength(19);
    expect(source.digest).toBe(PINNED_PRODUCTION_DIGEST);
    expect(ANTI_SLOP_RULE_IDS).toHaveLength(15);
  });
});
