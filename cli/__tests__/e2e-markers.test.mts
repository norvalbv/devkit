import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The e2e suite (e2e/*.e2e.test.mts) asserts on user-facing marker strings emitted by the shipped
// CLI. Those markers are slow to check (build+pack+install), so this cheap grep pins the underlying
// source phrases in the fast unit run: rename a phrase and this reddens immediately, instead of
// surfacing as a confusing e2e miss. Keep in sync with MARKERS in e2e/lib/harness.mts.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Source-literal fragments the e2e MARKERS are built from (the doctor "MISSING" glyph line is
// composed at runtime, so we pin its stable pieces rather than the assembled string).
const SOURCE_PHRASES = [
  '🚧 Deterministic gates',
  '🚫 Folder fan-out exceeded',
  'All checks OK.',
  'not initialized',
  'MISSING',
];

describe('e2e marker phrases still exist in source', () => {
  for (const phrase of SOURCE_PHRASES) {
    it(`finds ${JSON.stringify(phrase)}`, () => {
      const r = spawnSync('grep', ['-rFl', '--', phrase, 'cli', 'gate-engine'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
      expect(r.status, `phrase gone from source: ${phrase}`).toBe(0);
    });
  }
});
