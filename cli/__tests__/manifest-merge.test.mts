import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { syncProviderNativeAssets } from '../lib/install/agent-asset-manifest/lifecycle.mts';
import { testExecFileSync, testSpawnSync } from './_helpers.mts';

const roots: string[] = [];
const MANIFEST = '.devkit/skills-manifest.json';

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'manifest-merge-'));
  roots.push(root);
  return root;
}

function git(root: string, ...args: string[]): string {
  return testExecFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

function syncSkills(root: string, edited: readonly string[]): void {
  syncProviderNativeAssets({
    root,
    kind: 'skills',
    sources: ['alpha', 'middle', 'zeta'].map((name) => ({
      logicalRel: `${name}/SKILL.md`,
      content: Buffer.from(`# ${name}${edited.includes(name) ? ' (edited)' : ''}\n`),
    })),
    targets: ['claude'],
    devkitRef: 'v1.0.0',
  });
}

function commitSkillEdit(root: string, branch: string, skill: string): void {
  git(root, 'switch', '-q', '-c', branch, 'main');
  syncSkills(root, [skill]);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', `edit ${skill}`);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('committed skills manifest', () => {
  it('merges two branches that regenerated it after editing different skills', () => {
    const root = tempRoot();
    git(root, 'init', '-q', '-b', 'main');
    syncSkills(root, []);
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'base');
    commitSkillEdit(root, 'edit-alpha', 'alpha');
    commitSkillEdit(root, 'edit-zeta', 'zeta');

    const merge = testSpawnSync('git', ['merge-tree', '--write-tree', 'edit-alpha', 'edit-zeta'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(merge.stdout).not.toContain('CONFLICT');
    expect(merge.status).toBe(0);

    const fresh = tempRoot();
    syncSkills(fresh, ['alpha', 'zeta']);
    const tree = merge.stdout.split('\n')[0];
    expect(git(root, 'show', `${tree}:${MANIFEST}`)).toBe(
      readFileSync(join(fresh, MANIFEST), 'utf8'),
    );
  });
});
