import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSelection } from '../lib/components.mts';
import { buildFullHook } from '../lib/husky/husky-block.mts';
import { buildSelfHostHook } from '../lib/husky/self-host.mts';
import {
  inspectSkillProjectionIntegrity,
  printSkillProjectionWarning,
} from '../lib/husky/skill-projection-integrity.mts';
import { rootRegistry } from './_helpers.mts';

const shipScript = fileURLToPath(new URL('../lib/ship/ship-branch.sh', import.meta.url));
const reshipScript = fileURLToPath(new URL('../lib/ship/reship.sh', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const { mkTmp, cleanup } = rootRegistry();

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function write(root: string, rel: string, content: string): void {
  const file = join(root, rel);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content);
}

function devkitRepo({
  name = '@norvalbv/devkit',
  targets = ['claude', 'cursor'],
  guards = ['decisions'],
}: {
  name?: string;
  targets?: string[];
  guards?: string[];
} = {}): string {
  const root = mkTmp('skill-projection-integrity-');
  write(root, 'package.json', `${JSON.stringify({ name })}\n`);
  write(root, '.devkit/config.json', `${JSON.stringify({ components: { guards } })}\n`);
  write(
    root,
    '.devkit/skills-manifest.json',
    `${JSON.stringify({
      schemaVersion: 2,
      kind: 'skills',
      devkitRef: null,
      generatedAt: '2026-08-23T00:00:00.000Z',
      files: {},
      providers: Object.fromEntries(targets.map((target) => [target, { files: {} }])),
    })}\n`,
  );
  return root;
}

function providerDir(provider: string): string {
  if (provider === 'claude') return '.claude/skills';
  if (provider === 'cursor') return '.cursor/skills';
  if (provider === 'codex') return '.agents/skills';
  throw new Error(`unsupported test provider: ${provider}`);
}

function seedSkill(
  root: string,
  name: string,
  files: Record<string, string>,
  providers: string[] = ['claude', 'cursor'],
): void {
  for (const [rel, content] of Object.entries(files)) {
    const logical = `${name}/${rel}`;
    write(root, `skills/${logical}`, content);
    write(root, `dist/skills/${logical}`, content);
    for (const provider of providers) write(root, `${providerDir(provider)}/${logical}`, content);
  }
}

describe('inspectSkillProjectionIntegrity', () => {
  it('uses the writer selection and recorded providers, including never-synced skills', () => {
    const root = devkitRepo();
    seedSkill(root, 'review', { 'SKILL.md': '# Review\n' });
    seedSkill(root, 'decisions', { 'SKILL.md': '# Decisions\n' });
    seedSkill(root, 'i-have-adhd', { 'SKILL.md': '# Vendored only\n' }, []);

    expect(inspectSkillProjectionIntegrity(root)).toEqual({
      active: true,
      checkedProjections: ['claude', 'cursor', 'dist'],
      findings: [],
    });
  });

  it('reports provider and packaged missing, stale, and orphan files', () => {
    const root = devkitRepo();
    seedSkill(root, 'review', {
      'SKILL.md': '# Review\n',
      'references/checklist.md': 'check\n',
    });
    write(root, '.claude/skills/review/SKILL.md', '# stale\n');
    write(root, '.cursor/skills/review/extra.md', 'orphan\n');
    rmSync(join(root, '.cursor/skills/review/references/checklist.md'));
    write(root, 'dist/skills/review/references/checklist.md', 'stale\n');

    expect(inspectSkillProjectionIntegrity(root).findings.sort()).toEqual([
      'missing .cursor/skills/review/references/checklist.md',
      'orphan .cursor/skills/review/extra.md',
      'stale .claude/skills/review/SKILL.md',
      'stale dist/skills/review/references/checklist.md',
    ]);
  });

  it('checks Codex only when its manifest provider is recorded', () => {
    const root = devkitRepo({ targets: ['codex'] });
    seedSkill(root, 'review', { 'SKILL.md': '# Review\n' }, []);

    expect(inspectSkillProjectionIntegrity(root).findings).toEqual([
      'missing .agents/skills/review/SKILL.md',
    ]);
    write(root, '.agents/skills/review/SKILL.md', '# Review\n');
    expect(inspectSkillProjectionIntegrity(root).findings).toEqual([]);
  });

  it('warns instead of passing vacuously when no skills manifest exists', () => {
    const root = devkitRepo();
    seedSkill(root, 'review', { 'SKILL.md': '# Review\n' });
    rmSync(join(root, '.devkit/skills-manifest.json'));

    expect(inspectSkillProjectionIntegrity(root).findings).toEqual([
      'unchecked skills/ — no agentTargets configured, nothing compared',
    ]);
  });

  it('warns explicitly when the canonical skills directory is missing', () => {
    const root = devkitRepo();

    expect(inspectSkillProjectionIntegrity(root)).toEqual({
      active: true,
      checkedProjections: ['claude', 'cursor', 'dist'],
      findings: ['unchecked skills/ — canonical skills directory missing'],
    });
  });

  it('does not activate in consumer repositories', () => {
    const root = devkitRepo({ name: 'consumer' });
    seedSkill(root, 'review', { 'SKILL.md': '# Review\n' });

    expect(inspectSkillProjectionIntegrity(root)).toEqual({
      active: false,
      checkedProjections: [],
      findings: [],
    });
  });

  it('does not activate when package identity is malformed', () => {
    const root = devkitRepo();
    write(root, 'package.json', '{ merge conflict');

    expect(inspectSkillProjectionIntegrity(root)).toEqual({
      active: false,
      checkedProjections: [],
      findings: [],
    });
  });
});

describe('self-host Husky skill projection warning', () => {
  it('is advisory and distinguishes automatic repairs from orphan cleanup', () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const status = printSkillProjectionWarning({
      active: true,
      checkedProjections: ['cursor', 'dist'],
      findings: ['orphan .cursor/skills/review/extra.md'],
    });

    expect(status).toBe(0);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('skill projection drift detected (advisory)'),
    );
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('remove orphan files explicitly'));
  });

  it('is generated only into the internal self-host hook and remains fail-open', () => {
    const selfHost = buildSelfHostHook(defaultSelection(), '', repoRoot);
    const consumer = buildFullHook(defaultSelection(), '');

    expect(selfHost).toContain('# devkit:self-host-skill-projection-advisory');
    expect(selfHost).toContain('cli/lib/husky/skill-projection-integrity.mts');
    expect(selfHost).toContain('--root "$__dk_skill_root" || true');
    expect(consumer).not.toContain('self-host-skill-projection-advisory');

    for (const script of [shipScript, reshipScript]) {
      const source = readFileSync(script, 'utf8');
      expect(source).not.toContain('skill-projection-integrity');
    }
  });

  it('executes advisory-only for commits and skips review-mode replays', () => {
    const hook = buildSelfHostHook(defaultSelection(), '', repoRoot);
    const fragment = hook.match(
      /# devkit:self-host-skill-projection-advisory[\s\S]*?# \/devkit:self-host-skill-projection-advisory/,
    )?.[0];
    expect(fragment).toBeDefined();

    const bin = mkTmp('skill-projection-hook-bin-');
    write(bin, 'node', '#!/bin/sh\necho "NODE:$*"\nexit 17\n');
    chmodSync(join(bin, 'node'), 0o755);
    const run = (runMode?: string) => {
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
      if (runMode) env.DEVKIT_RUN_MODE = runMode;
      return execFileSync('sh', ['-e', '-c', fragment ?? 'exit 99'], {
        cwd: repoRoot,
        encoding: 'utf8',
        env,
      });
    };

    expect(run()).toContain('cli/lib/husky/skill-projection-integrity.mts');
    expect(run('review')).toBe('');
  });
});
