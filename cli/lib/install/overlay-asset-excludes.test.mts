import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { overlayAssetExcludes } from './overlay-asset-excludes.mts';
import {
  addToGitExclude,
  gitExcludeFile,
  hasOrphanExcludeBlock,
  pruneGitExclude,
  siblingOverlayCheckouts,
} from './overlay-excludes.mts';

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** A real repo plus a linked worktree of it; the worktree's `.git` is a file, not a directory. */
function repoWithWorktree() {
  const root = mkdtempSync(join(tmpdir(), 'overlay-excludes-repo-'));
  const wtParent = mkdtempSync(join(tmpdir(), 'overlay-excludes-wt-'));
  roots.push(root, wtParent);
  const wt = join(wtParent, 'wt');
  git(root, 'init', '-q');
  git(
    root,
    '-c',
    'user.email=test@example.com',
    '-c',
    'user.name=test',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-qm',
    'initial',
    '--allow-empty',
  );
  git(root, 'worktree', 'add', '-q', '-b', 'wt', wt);
  return { root, wt };
}

/** Give a checkout the local hook an overlay install leaves at its root. */
function markOverlay(checkout: string): void {
  mkdirSync(join(checkout, '.devkit', 'hooks'), { recursive: true });
  writeFileSync(join(checkout, '.devkit', 'hooks', 'pre-commit'), '#!/bin/sh\n');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('overlayAssetExcludes', () => {
  it('preserves the v1 logical-path mirror across its selected legacy providers', () => {
    expect(
      overlayAssetExcludes({ files: { 'brainstorming/SKILL.md': 'source-sha' } }, 'skills', [
        'claude',
        'cursor',
      ]),
    ).toEqual(['.claude/skills/brainstorming/', '.cursor/skills/brainstorming/']);
  });

  it('uses only exact v2 provider outputs, including Codex-native paths', () => {
    expect(
      overlayAssetExcludes(
        {
          schemaVersion: 2,
          kind: 'agents',
          devkitRef: 'v1.0.0',
          generatedAt: '2026-01-01T00:00:00.000Z',
          files: { 'feature-critique.md': 'source-sha' },
          providers: {
            claude: { files: {} },
            codex: { files: { 'feature-critique.toml': 'output-sha' } },
          },
        },
        'agents',
        ['claude', 'codex'],
      ),
    ).toEqual(['.codex/agents/feature-critique.toml']);
  });
});

describe('addToGitExclude', () => {
  it('prunes a deselected hook-registration ownership ledger', () => {
    const root = mkdtempSync(join(tmpdir(), 'overlay-excludes-'));
    roots.push(root);
    const info = join(root, '.git', 'info');
    mkdirSync(info, { recursive: true });
    const file = join(info, 'exclude');
    writeFileSync(
      file,
      [
        '# consumer',
        '# devkit overlay (local-only) — not committed',
        '.devkit/agent-hook-registrations-manifest.json',
        '.devkit/skills-manifest.json',
        '',
      ].join('\n'),
    );

    addToGitExclude(root, ['.devkit/skills-manifest.json'], false);

    expect(readFileSync(file, 'utf8')).not.toContain(
      '.devkit/agent-hook-registrations-manifest.json',
    );
    expect(readFileSync(file, 'utf8')).toContain('.devkit/skills-manifest.json');
  });

  it('hides overlay files in a linked worktree via the shared common-dir exclude', () => {
    const { root, wt } = repoWithWorktree();
    mkdirSync(join(wt, '.devkit'));
    writeFileSync(join(wt, '.devkit', 'config.json'), '{}\n');
    writeFileSync(join(wt, 'guard.config.json'), '{}\n');

    addToGitExclude(wt, ['.devkit/', 'guard.config.json'], false);

    expect(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8')).toContain('.devkit/');
    expect(git(wt, 'status', '--porcelain')).toBe('');
  });

  it('keeps a path a sibling overlay still uses when this checkout deselects it', () => {
    const { root, wt } = repoWithWorktree();
    markOverlay(root);
    addToGitExclude(root, ['.devkit/', '.claude/skills/testing/'], false);

    addToGitExclude(wt, ['.devkit/'], false);

    expect(readFileSync(gitExcludeFile(wt), 'utf8')).toContain('.claude/skills/testing/');
  });

  it('holds a lock beside the shared exclude while rewriting it', () => {
    const { wt } = repoWithWorktree();
    const file = gitExcludeFile(wt);
    writeFileSync(`${file}.devkit.lock`, String(process.pid)); // a live holder

    expect(() => addToGitExclude(wt, ['.devkit/'], false)).toThrow(
      /held by another devkit process/,
    );
    expect(existsSync(file) ? readFileSync(file, 'utf8') : '').not.toContain('.devkit/');
  });
});

describe('siblingOverlayCheckouts', () => {
  it('finds a sibling overlay whose worktree path contains a newline', () => {
    const { root } = repoWithWorktree();
    const parent = mkdtempSync(join(tmpdir(), 'overlay-excludes-odd-'));
    roots.push(parent);
    const odd = join(parent, 'line\nbreak');
    git(root, 'worktree', 'add', '-q', '-b', 'odd', odd);
    markOverlay(odd);

    expect(siblingOverlayCheckouts(root).map((path) => realpathSync(path))).toEqual([
      realpathSync(odd),
    ]);
  });
});

describe('pruneGitExclude', () => {
  it("keeps the shared lines while a sibling checkout's overlay still relies on them", () => {
    const { root, wt } = repoWithWorktree();
    markOverlay(root);
    addToGitExclude(wt, ['.devkit/', 'guard.config.json'], false);

    pruneGitExclude(wt, false);

    expect(readFileSync(gitExcludeFile(wt), 'utf8')).toContain('guard.config.json');
    expect(hasOrphanExcludeBlock(wt)).toBe(false);
  });

  it('prunes devkit lines, leaving the consumer ones, once no other overlay remains', () => {
    const { wt } = repoWithWorktree();
    const file = gitExcludeFile(wt);
    writeFileSync(file, '/consumer-cache/\n');
    addToGitExclude(wt, ['.devkit/', 'guard.config.json'], false);
    expect(hasOrphanExcludeBlock(wt)).toBe(true);

    pruneGitExclude(wt, false);

    const pruned = readFileSync(file, 'utf8');
    expect(pruned).toContain('/consumer-cache/');
    expect(pruned).not.toMatch(/# devkit overlay|\.devkit\/|guard\.config\.json/);
  });

  it('prunes only the devkit lines after its header, wherever an install appended them', () => {
    const { wt } = repoWithWorktree();
    const file = gitExcludeFile(wt);
    writeFileSync(file, '/guard.config.json\n');
    addToGitExclude(wt, ['.devkit/', 'guard.config.json'], false);
    writeFileSync(file, '# mine\n/.devkit/\n/fallow-baselines/\n', { flag: 'a' });
    addToGitExclude(wt, ['.devkit/', 'guard.config.json', 'oxlint.devkit.json'], false);

    pruneGitExclude(wt, false);

    expect(readFileSync(file, 'utf8').split('\n').filter(Boolean)).toEqual([
      '/guard.config.json',
      '# mine',
      '/.devkit/',
      '/fallow-baselines/',
    ]);
  });
});
