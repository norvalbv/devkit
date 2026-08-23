import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  inspectSkillProjectionIntegrity,
  printSkillProjectionWarning,
} from '../lib/ship/skill-projection-integrity.mts';
import { rootRegistry } from './_helpers.mts';

const shipScript = fileURLToPath(new URL('../lib/ship/ship-branch.sh', import.meta.url));
const reshipScript = fileURLToPath(new URL('../lib/ship/reship.sh', import.meta.url));
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

describe('ship skill projection warning', () => {
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

  it('runs fail-open for both new ships and reships', () => {
    for (const script of [shipScript, reshipScript]) {
      const source = readFileSync(script, 'utf8');
      expect(source).toContain('skill-projection-integrity');
      expect(source).toContain('node "$SKILL_PROJECTION_INTEGRITY" --root "$ROOT" || true');
    }
  });
});
