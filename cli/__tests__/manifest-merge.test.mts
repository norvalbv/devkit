import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentAssetKind } from '../lib/install/agent-assets/agent-providers.mts';
import { syncProviderNativeAssets } from '../lib/install/agent-asset-manifest/lifecycle.mts';
import { testExecFileSync, testSpawnSync } from './_helpers.mts';

const roots: string[] = [];
const MANIFEST = '.devkit/skills-manifest.json';
const UNITS = ['alpha', 'middle', 'zeta'];
const KINDS = [
  { kind: 'skills', manifest: MANIFEST, rel: (name: string) => `${name}/SKILL.md` },
  { kind: 'agents', manifest: '.devkit/agents-manifest.json', rel: (name: string) => `${name}.md` },
  {
    kind: 'hooks',
    manifest: '.devkit/agent-hooks-manifest.json',
    rel: (name: string) => `${name}.sh`,
  },
] as const satisfies readonly {
  kind: AgentAssetKind;
  manifest: string;
  rel: (name: string) => string;
}[];
type Kind = (typeof KINDS)[number];

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

/** Sync one kind's units; `edits` names a unit's edit, and a `null` edit drops the unit's source. */
function syncAssets(root: string, kind: Kind, edits: Record<string, string | null> = {}): void {
  syncProviderNativeAssets({
    root,
    kind: kind.kind,
    sources: UNITS.filter((name) => edits[name] !== null).map((name) => ({
      logicalRel: kind.rel(name),
      content: Buffer.from(`# ${name}${edits[name] ? ` (${edits[name]})` : ''}\n`),
    })),
    targets: ['claude'],
    devkitRef: 'v1.0.0',
  });
}

function syncSkills(root: string, edited: readonly string[]): void {
  syncAssets(root, KINDS[0], Object.fromEntries(edited.map((name) => [name, 'edited'])));
}

function commitSkillEdit(root: string, branch: string, skill: string): void {
  git(root, 'switch', '-q', '-c', branch, 'main');
  syncSkills(root, [skill]);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', `edit ${skill}`);
}

/** Overlay shape: only the manifest is committed; the projected outputs stay untracked on disk. */
function commitManifest(
  root: string,
  kind: Kind,
  branch: string,
  edits: Record<string, string | null>,
): void {
  git(root, 'switch', '-q', '-c', branch, 'main');
  syncAssets(root, kind, edits);
  git(root, 'add', '--', kind.manifest);
  git(root, 'commit', '-qm', branch);
}

/** Two branches regenerate after editing the SAME unit; returns a checkout of `ours` mid-`verb`. */
function conflictedCheckout(
  kind: Kind,
  verb: 'merge' | 'rebase',
  theirs: Record<string, string | null>,
  ours: Record<string, string | null> = { middle: 'ours' },
): string {
  const root = tempRoot();
  git(root, 'init', '-q', '-b', 'main');
  syncAssets(root, kind, ours.zeta === null ? { zeta: null } : {});
  git(root, 'add', '--', kind.manifest);
  git(root, 'commit', '-qm', 'base');
  commitManifest(root, kind, 'ours', ours);
  commitManifest(root, kind, 'theirs', theirs);
  git(root, 'switch', '-q', 'ours');
  syncAssets(root, kind, ours);

  const stopped = testSpawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', verb, 'theirs'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  expect(stopped.status).not.toBe(0);
  expect(git(root, 'ls-files', '-u', '--', kind.manifest)).not.toBe('');
  expect(readFileSync(join(root, kind.manifest), 'utf8')).toMatch(/^<{7} /m);
  return root;
}

function freshManifest(kind: Kind, edits: Record<string, string | null>): string {
  const fresh = tempRoot();
  syncAssets(fresh, kind, edits);
  return readFileSync(join(fresh, kind.manifest), 'utf8');
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

describe('a merge-conflicted manifest', () => {
  it.each(KINDS)('is regenerated by the $kind sync, and the merge then completes', (kind) => {
    const root = conflictedCheckout(kind, 'merge', { middle: 'theirs' });
    const merged = { middle: 'merged' };
    syncAssets(root, kind, merged);

    expect(readFileSync(join(root, kind.manifest), 'utf8')).toBe(freshManifest(kind, merged));
    git(root, 'add', '--', kind.manifest);
    git(root, 'commit', '-q', '--no-edit');
    expect(git(root, 'ls-files', '-u')).toBe('');
  });

  it('regenerates the same manifest mid-rebase, where ours and theirs swap', () => {
    const root = conflictedCheckout(KINDS[0], 'rebase', { middle: 'theirs' });
    const merged = { middle: 'merged' };
    syncAssets(root, KINDS[0], merged);
    expect(readFileSync(join(root, MANIFEST), 'utf8')).toBe(freshManifest(KINDS[0], merged));
  });

  it('removes an output only the checked-out side recorded once the merged sources drop it', () => {
    const root = conflictedCheckout(KINDS[0], 'merge', { middle: 'theirs', zeta: null });
    expect(existsSync(join(root, '.claude/skills/zeta/SKILL.md'))).toBe(true);
    const merged = { middle: 'merged', zeta: null };
    syncAssets(root, KINDS[0], merged);

    expect(existsSync(join(root, '.claude/skills/zeta'))).toBe(false);
    expect(readFileSync(join(root, MANIFEST), 'utf8')).toBe(freshManifest(KINDS[0], merged));
  });

  // Only the other branch recorded `zeta`; this checkout's `zeta` is the consumer's own file.
  it.each([
    ['still bundle it', { middle: 'merged' }],
    ['drop it', { middle: 'merged', zeta: null }],
  ])(
    'preserves a consumer file only the other branch recorded, when the merged sources %s',
    (_case, merged) => {
      const root = conflictedCheckout(
        KINDS[0],
        'merge',
        { middle: 'theirs' },
        { middle: 'ours', zeta: null },
      );
      const consumer = join(root, '.claude/skills/zeta/SKILL.md');
      mkdirSync(dirname(consumer), { recursive: true });
      writeFileSync(consumer, '# my own zeta\n');
      syncAssets(root, KINDS[0], merged);
      expect(readFileSync(consumer, 'utf8')).toBe('# my own zeta\n');
    },
  );
});
