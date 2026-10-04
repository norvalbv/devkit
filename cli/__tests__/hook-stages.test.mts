import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GUARD_IDS } from '../lib/components.mts';
import { testSpawnSync } from './_helpers.mts';
import {
  buildCommitMsgBlock,
  buildCommitMsgHook,
  checkCommitMsgHook,
} from '../lib/husky/commit-msg-block.mts';
import { buildGuardBlock, buildOverlayHook, hookStages } from '../lib/husky/husky-block.mts';
import {
  buildSelfHostBlock,
  SELF_HOST_EXTRAS,
  SELF_HOST_STRUCTURE_CMD,
  selfHostSelection,
} from '../lib/husky/self-host.mts';

const PRE_COMMIT = [
  'biome-format',
  'deterministic',
  'guard-decisions',
  'guard-review',
  'guard-sentry-prewarm',
  'guard-qavis-advisory',
];
const ALL = { biome: true, guards: GUARD_IDS };

// Pins the stage order each builder emits. A reorder, or a new `# devkit:` sentinel that is neither
// listed here nor declared infrastructure in hookStages, fails here before doctor prints it.
describe('hookStages reads the order the generated hooks run', () => {
  it('package and standalone: reviewers and the sentry prewarm run before the qavis advisory', () => {
    expect(hookStages(buildGuardBlock(ALL))).toEqual(PRE_COMMIT);
    expect(hookStages(buildGuardBlock(ALL, '', { binDir: 'global-optional' }))).toEqual(PRE_COMMIT);
  });

  it('overlay: the same body plus its staged lint overlay ahead of the judges', () => {
    expect(hookStages(buildOverlayHook(ALL))).toEqual([
      'biome-format',
      'deterministic',
      'lint overlay',
      ...PRE_COMMIT.slice(2),
    ]);
  });

  it('self-host: the package body, then its two trailing advisories', () => {
    const sel = {
      ...selfHostSelection(),
      structureCmd: SELF_HOST_STRUCTURE_CMD,
      extras: SELF_HOST_EXTRAS,
    };
    const stages = hookStages(buildSelfHostBlock(sel, '', process.cwd()));
    expect(stages.slice(-2)).toEqual(['fallow-advisory', 'self-host-skill-projection-advisory']);
    expect(stages.indexOf('guard-review')).toBeLessThan(stages.indexOf('guard-qavis-advisory'));
  });

  it('commit-msg: completeness, then sentry', () => {
    expect(hookStages(buildCommitMsgBlock({ guards: GUARD_IDS }) ?? '')).toEqual([
      'guard-completeness',
      'guard-sentry',
    ]);
  });
});

describe('hookStages reports the text it is given', () => {
  it('follows a hand-reordered block instead of the generator', () => {
    const edited =
      '# devkit:guard-qavis-advisory\n# /devkit:guard-qavis-advisory\n# devkit:guard-review\n';
    expect(hookStages(edited)).toEqual(['guard-qavis-advisory', 'guard-review']);
  });

  it('is empty for a block with no stages, and never lists hook infrastructure', () => {
    expect(hookStages('# devkit:commit-index\n# devkit:gate-log\necho hi\n')).toEqual([]);
  });
});

// A fresh hook carries infrastructure sentinels (the commit-index capture); they are not gates.
function repoWithHook(guards: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'dk-commit-msg-'));
  expect(testSpawnSync('git', ['init', '-q'], { cwd: root }).status).toBe(0);
  mkdirSync(join(root, '.husky'));
  writeFileSync(join(root, '.husky', 'commit-msg'), buildCommitMsgHook({ guards }));
  return root;
}

describe('checkCommitMsgHook', () => {
  it('reads a freshly generated hook as OK and prints its order', () => {
    const result = checkCommitMsgHook(repoWithHook(['review', 'sentry']), ['review', 'sentry']);
    expect(result.status).toBe('OK');
    expect(result.detail).toBe('block order: guard-completeness → guard-sentry');
  });

  it('still flags a deselected gate left in the block', () => {
    const result = checkCommitMsgHook(repoWithHook(['review', 'sentry']), ['review']);
    expect(result.status).toBe('DRIFT');
    expect(result.detail).toBe('block contains deselected gate(s): guard-sentry');
  });
});
