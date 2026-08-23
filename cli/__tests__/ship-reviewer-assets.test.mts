import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { projectShipAssetKind } from '../lib/ship/review/asset-runtime.mts';
import { testSpawnSync as spawnSync } from './_helpers.mts';
import {
  dirs,
  dropWorktree,
  packagedApiSecurityAgent,
  packagedApiSecurityChecklist,
  scriptPath,
  seedShipRepo,
  WT_RE,
} from './_ship-branch-fixture.mts';

const prepareGateWorktreeScript = fileURLToPath(
  new URL('../lib/ship/prepare-gate-worktree.sh', import.meta.url),
);
const sourcePackageRoot = fileURLToPath(new URL('../../', import.meta.url));
const packagedCompletenessAgent = fileURLToPath(
  new URL('../../agents/feature-completeness-reviewer.md', import.meta.url),
);

function runReviewerRefresh(worktree, root, packageRoot = '', env = process.env) {
  return spawnSync(
    '/bin/bash',
    [
      '-c',
      [
        'source "$1"',
        'test_package_root=$2',
        'if [ -n "$test_package_root" ]; then',
        '  gate_package_root() { printf "%s\\n" "$test_package_root"; }',
        'fi',
        'refresh_ship_reviewer_assets "$3" "$4" shipping',
      ].join('\n'),
      'refresh-reviewer-assets',
      prepareGateWorktreeScript,
      packageRoot,
      worktree,
      root,
    ],
    { encoding: 'utf8', env },
  );
}

describe('ship reviewer asset refresh', () => {
  it('preserves tracked consumer skills while exact-replacing packaged reviewer assets', () => {
    const consumerSkill = '# consumer-owned identity\n';
    const retiredAgent = 'retired-reviewer.md';
    const { dir, env, git } = seedShipRepo({
      hookBody: 'cat .claude/skills/frink-identity/SKILL.md >/dev/null',
    });
    mkdirSync(join(dir, '.claude/agents'), { recursive: true });
    writeFileSync(join(dir, '.claude/agents/api-security-reviewer.md'), '# tracked\n');
    writeFileSync(join(dir, '.claude/agents', retiredAgent), '# retired devkit agent\n');
    mkdirSync(join(dir, '.claude/skills/api-security/scripts'), { recursive: true });
    writeFileSync(
      join(dir, '.claude/skills/api-security/scripts/checklist.mjs'),
      '// tracked stale checklist\n',
    );
    writeFileSync(join(dir, '.claude/skills/api-security/obsolete.txt'), 'stale\n');
    mkdirSync(join(dir, '.claude/skills/frink-identity'), { recursive: true });
    writeFileSync(join(dir, '.claude/skills/frink-identity/SKILL.md'), consumerSkill);
    mkdirSync(join(dir, '.devkit'), { recursive: true });
    writeFileSync(
      join(dir, '.devkit/agents-manifest.json'),
      `${JSON.stringify({ files: { [retiredAgent]: '0'.repeat(64) }, targets: ['claude'] })}\n`,
    );
    git(['add', '.claude'], { stdio: 'ignore' });
    git(['commit', '-q', '-m', 'track .claude'], { stdio: 'ignore' });
    writeFileSync(
      join(dir, '.husky/_/pre-commit'),
      '#!/bin/sh\ncat .claude/skills/frink-identity/SKILL.md >/dev/null && test ! -e .claude/agents/retired-reviewer.md\n',
    );
    writeFileSync(join(dir, 'note.txt'), 'hi\n');

    const result = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/claude-consumer-skill', 't', 'note.txt'],
      {
        cwd: dir,
        input: 'b\n',
        encoding: 'utf8',
        env: { ...env, SHIP_DRY_RUN: '1' },
      },
    );
    const worktree = WT_RE.exec(result.stderr)?.[1];

    try {
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(worktree, '.claude/skills/frink-identity/SKILL.md'), 'utf8')).toBe(
        consumerSkill,
      );
      expect(readFileSync(join(worktree, '.claude/agents/api-security-reviewer.md'), 'utf8')).toBe(
        readFileSync(packagedApiSecurityAgent, 'utf8'),
      );
      expect(
        readFileSync(join(worktree, '.claude/agents/feature-completeness-reviewer.md'), 'utf8'),
      ).toBe(readFileSync(packagedCompletenessAgent, 'utf8'));
      expect(readdirSync(join(worktree, '.claude/agents')).sort()).toEqual(
        readdirSync(join(sourcePackageRoot, 'agents')).sort(),
      );
      expect(existsSync(join(dir, '.claude/agents', retiredAgent))).toBe(true);
      expect(
        readFileSync(join(worktree, '.claude/skills/api-security/scripts/checklist.mjs'), 'utf8'),
      ).toBe(readFileSync(packagedApiSecurityChecklist, 'utf8'));
      expect(existsSync(join(worktree, '.claude/skills/api-security/obsolete.txt'))).toBe(false);
      expect(git(['show', 'HEAD:.claude/skills/frink-identity/SKILL.md'])).toBe(consumerSkill);
    } finally {
      dropWorktree(git, result.stderr);
    }
  });

  it('fails before stale consumer bytes can mask a missing packaged reviewer asset', () => {
    const parent = mkdtempSync(join(tmpdir(), 'ship-review-assets-missing-'));
    dirs.push(parent);
    const packageRoot = join(parent, 'package');
    const worktree = join(parent, 'worktree');
    const root = join(parent, 'root');
    mkdirSync(packageRoot);
    mkdirSync(worktree);
    mkdirSync(root);
    cpSync(fileURLToPath(new URL('../../agents', import.meta.url)), join(packageRoot, 'agents'), {
      recursive: true,
    });
    cpSync(fileURLToPath(new URL('../../skills', import.meta.url)), join(packageRoot, 'skills'), {
      recursive: true,
    });
    mkdirSync(join(packageRoot, 'gate-engine/review'), { recursive: true });
    for (const file of ['baseline-fallow-paths.mts', 'baseline-gate.mts']) {
      cpSync(
        fileURLToPath(new URL(`../../gate-engine/review/${file}`, import.meta.url)),
        join(packageRoot, 'gate-engine/review', file),
      );
    }
    rmSync(join(packageRoot, 'agents/api-security-reviewer.md'));
    mkdirSync(join(worktree, '.claude/agents'), { recursive: true });
    writeFileSync(join(worktree, '.claude/agents/api-security-reviewer.md'), '# stale\n');

    const result = runReviewerRefresh(worktree, root, packageRoot);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(
      /packaged reviewer asset is missing: agents\/api-security-reviewer\.md/,
    );
    expect(readFileSync(join(worktree, '.claude/agents/api-security-reviewer.md'), 'utf8')).toBe(
      '# stale\n',
    );
  });

  it('rejects a symlinked child root without mutating its external target', () => {
    const parent = mkdtempSync(join(tmpdir(), 'ship-review-assets-link-'));
    dirs.push(parent);
    const worktree = join(parent, 'worktree');
    const root = join(parent, 'root');
    const external = join(parent, 'external');
    mkdirSync(join(worktree, '.claude'), { recursive: true });
    mkdirSync(root);
    mkdirSync(external);
    writeFileSync(join(external, 'consumer.txt'), 'untouched\n');
    symlinkSync(external, join(worktree, '.claude/skills'), 'dir');

    const result = runReviewerRefresh(worktree, root, sourcePackageRoot);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/\.claude\/skills must be a real directory/);
    expect(readFileSync(join(external, 'consumer.txt'), 'utf8')).toBe('untouched\n');
  });

  it('rejects a child root swapped to an external symlink after validation', () => {
    const parent = mkdtempSync(join(tmpdir(), 'ship-review-assets-race-'));
    dirs.push(parent);
    const worktree = join(parent, 'worktree');
    const root = join(parent, 'root');
    const external = join(parent, 'external');
    const savedSkills = join(parent, 'saved-skills');
    const skillRoot = join(worktree, '.claude/skills');
    const stubBin = join(parent, 'bin');
    mkdirSync(join(skillRoot, 'consumer-only'), { recursive: true });
    mkdirSync(join(external, 'api-security'), { recursive: true });
    mkdirSync(root);
    mkdirSync(stubBin);
    writeFileSync(join(skillRoot, 'consumer-only/SKILL.md'), '# consumer\n');
    writeFileSync(join(external, 'api-security/sentinel.txt'), 'external untouched\n');
    writeFileSync(
      join(stubBin, 'node'),
      [
        '#!/usr/bin/env bash',
        'if [ "$2" = manifest-owned ] && [ "$4" = skills ] && [ ! -e "$DEVKIT_RACE_SAVED" ]; then',
        '  mv -- "$DEVKIT_RACE_ROOT" "$DEVKIT_RACE_SAVED"',
        '  ln -s -- "$DEVKIT_RACE_EXTERNAL" "$DEVKIT_RACE_ROOT"',
        'fi',
        'exec "$DEVKIT_RACE_REAL_NODE" "$@"',
        '',
      ].join('\n'),
    );
    chmodSync(join(stubBin, 'node'), 0o755);

    const result = runReviewerRefresh(worktree, root, sourcePackageRoot, {
      ...process.env,
      DEVKIT_RACE_EXTERNAL: external,
      DEVKIT_RACE_REAL_NODE: process.execPath,
      DEVKIT_RACE_ROOT: skillRoot,
      DEVKIT_RACE_SAVED: savedSkills,
      PATH: `${stubBin}:${process.env.PATH ?? ''}`,
    });

    expect(existsSync(join(external, 'api-security/sentinel.txt'))).toBe(true);
    expect(readFileSync(join(external, 'api-security/sentinel.txt'), 'utf8')).toBe(
      'external untouched\n',
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/ship reviewer skills root must be a real directory/);
    expect(readFileSync(join(savedSkills, 'consumer-only/SKILL.md'), 'utf8')).toBe('# consumer\n');
  });

  it('restores quarantined assets when a replacement rename fails', () => {
    const parent = mkdtempSync(join(tmpdir(), 'ship-review-assets-rollback-'));
    dirs.push(parent);
    const worktree = join(parent, 'worktree');
    const runtime = join(parent, 'runtime');
    const owned = join(parent, 'owned');
    const agents = join(worktree, '.claude/agents');
    mkdirSync(agents, { recursive: true });
    mkdirSync(runtime);
    writeFileSync(join(agents, 'a.md'), 'consumer a\n');
    writeFileSync(join(agents, 'b.md'), 'consumer b\n');
    writeFileSync(join(runtime, 'a.md'), 'packaged a\n');
    writeFileSync(join(runtime, 'b.md'), 'packaged b\n');
    writeFileSync(owned, '');
    const originalCwd = process.cwd();
    let renames = 0;

    try {
      expect(() =>
        projectShipAssetKind(worktree, runtime, owned, 'agents', (source, destination) => {
          renames += 1;
          if (renames === 3) throw new Error('injected install failure');
          renameSync(source, destination);
        }),
      ).toThrow(/injected install failure/);
      expect(process.cwd()).toBe(originalCwd);
    } finally {
      process.chdir(originalCwd);
    }

    expect(readFileSync(join(agents, 'a.md'), 'utf8')).toBe('consumer a\n');
    expect(readFileSync(join(agents, 'b.md'), 'utf8')).toBe('consumer b\n');
    expect(readdirSync(agents).filter((name) => name.startsWith('.devkit-'))).toEqual([]);
  });

  it('restores cwd and reports an absolute recovery path when rollback fails', () => {
    const parent = mkdtempSync(join(tmpdir(), 'ship-review-assets-recovery-'));
    dirs.push(parent);
    const worktree = join(parent, 'worktree');
    const runtime = join(parent, 'runtime');
    const owned = join(parent, 'owned');
    const agents = join(worktree, '.claude/agents');
    mkdirSync(agents, { recursive: true });
    mkdirSync(runtime);
    writeFileSync(join(agents, 'a.md'), 'consumer a\n');
    writeFileSync(join(agents, 'b.md'), 'consumer b\n');
    writeFileSync(join(runtime, 'a.md'), 'packaged a\n');
    writeFileSync(join(runtime, 'b.md'), 'packaged b\n');
    writeFileSync(owned, '');
    const originalCwd = process.cwd();
    let renames = 0;
    let failure: unknown;

    try {
      projectShipAssetKind(worktree, runtime, owned, 'agents', (source, destination) => {
        renames += 1;
        if (renames === 3 || renames === 4) throw new Error('injected rename failure');
        renameSync(source, destination);
      });
    } catch (cause) {
      failure = cause;
    } finally {
      const finalCwd = process.cwd();
      process.chdir(originalCwd);
      expect(finalCwd).toBe(originalCwd);
    }

    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error('expected rollback AggregateError');
    const recoveryPath = failure.message.split('recovery assets retained in ')[1] ?? '';
    expect(isAbsolute(recoveryPath)).toBe(true);
    expect(recoveryPath).toContain('/.claude/agents/.devkit-review-assets-');
    expect(existsSync(recoveryPath)).toBe(true);
  });

  it('rejects a non-directory child root before making a partial projection', () => {
    const parent = mkdtempSync(join(tmpdir(), 'ship-review-assets-file-'));
    dirs.push(parent);
    const worktree = join(parent, 'worktree');
    const root = join(parent, 'root');
    mkdirSync(join(worktree, '.claude'), { recursive: true });
    mkdirSync(root);
    writeFileSync(join(worktree, '.claude/skills'), 'consumer file\n');

    const result = runReviewerRefresh(worktree, root, sourcePackageRoot);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/\.claude\/skills must be a real directory/);
    expect(readFileSync(join(worktree, '.claude/skills'), 'utf8')).toBe('consumer file\n');
    expect(existsSync(join(worktree, '.claude/agents'))).toBe(false);
  });

  it('uses a safe private reviewer snapshot when TMPDIR contains spaces', () => {
    const { dir, env, git } = seedShipRepo();
    const parent = mkdtempSync(join(tmpdir(), 'ship-review-assets-tmp-'));
    dirs.push(parent);
    const spacedTmp = join(parent, 'tmp with spaces');
    mkdirSync(spacedTmp);
    writeFileSync(join(dir, 'note.txt'), 'hi\n');

    const result = spawnSync('/bin/bash', [scriptPath, 'feat/claude-spaced-tmp', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1', TMPDIR: spacedTmp },
    });

    try {
      expect(result.status, result.stderr).toBe(0);
    } finally {
      dropWorktree(git, result.stderr);
    }
  });
});
