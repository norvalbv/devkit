// Each agentTarget's skills, agents and hooks dirs equal what the sync writers project from source.
// A small file of its own, so related-tests can force it whenever a hook source or projection moves.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Selection } from '../lib/components.mts';
import { projectionDrift } from '../lib/install/agent-assets/projection-parity.mts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// #405, #395 and #1111/#1198 each edited a source without re-running the writer, so the projections
// served stale bytes for days to weeks. Missing, stale and orphaned files all fail here.
describe('committed agent-asset projection parity', () => {
  for (const [kind, srcDir, manifest] of [
    ['skills', 'skills', 'skills-manifest.json'],
    ['agents', 'agents', 'agents-manifest.json'],
    ['hooks', 'agents-hooks', 'agent-hooks-manifest.json'],
  ] as const) {
    it(`${srcDir}/ === what sync-${kind} projects into every agentTarget`, () => {
      // SAFETY: `.devkit/config.json` is devkit-owned and committed here, and `components` is the
      // object the sync writers read; a reshaped field throws inside this test, never passes.
      const { components } = JSON.parse(
        readFileSync(join(ROOT, '.devkit', 'config.json'), 'utf8'),
      ) as { components: Partial<Selection> & { agentTargets: string[] } };

      // One target per call, so a gitignored projection reports `unchecked` instead of riding its
      // siblings' pass; the Set keeps a per-call `unreadable` source line from repeating per target.
      const { agentTargets } = components;
      const drift = (agentTargets.length ? agentTargets.map((t) => [t]) : [[]]).flatMap((targets) =>
        projectionDrift({ root: ROOT, kind, srcDir, targets, selection: components }),
      );
      // Sync rewrites a stale file but never prunes an orphan, so each class names its own repair.
      expect(
        [...new Set(drift)],
        `stale/missing → run \`node cli/index.mts sync-${kind}\` and commit the projection and ` +
          `.devkit/${manifest}; orphan → \`git rm\` it, or \`rm\` it when untracked; ` +
          'unchecked → the projection dir is gitignored here: un-ignore it and commit the projection',
      ).toEqual([]);
    });
  }
});
