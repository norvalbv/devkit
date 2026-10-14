// Research agents run real experiments; scratch left in an unswept temp dir outlives the run.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..');

describe('research agents: scratch is read-only first and deleted by literal path', () => {
  it.each(['prior-art', 'feature-critique'])('%s carries the scratch rule', (name) => {
    const agent = readFileSync(join(ROOT, 'agents', `${name}.md`), 'utf8');
    for (const marker of [
      'Read before you run; delete what you create.',
      "Never copy a consumer's index",
      'bare `mktemp -d`',
      '`du -sh`',
      'absolute path mktemp',
      'never a shell variable or glob',
      'best-effort',
      'invites experiments',
    ])
      expect(agent).toContain(marker);
  });
});
