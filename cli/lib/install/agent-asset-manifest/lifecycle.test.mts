import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncSkills } from '../../../commands/sync/sync-skills.mts';
import {
  findProviderNativeAssetConflicts,
  isSafeAgentAssetPath,
  removeProviderNativeAssets,
  syncProviderNativeAssets,
} from './lifecycle.mts';

const roots: string[] = [];
const AGENT = Buffer.from(`---
name: reviewer
description: Review a completed plan
---
Check the plan before implementation.
`);

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-asset-lifecycle-'));
  roots.push(root);
  return root;
}

function sha(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function agentOptions(root: string) {
  return {
    root,
    kind: 'agents' as const,
    sources: [{ logicalRel: 'reviewer.md', content: AGENT }],
    targets: ['claude', 'codex', 'cursor'],
    devkitRef: 'v1.2.3',
  };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('provider-native asset sync', () => {
  it('writes exact provider projections before a stable strict manifest', () => {
    const root = tempRoot();
    const first = syncProviderNativeAssets({
      ...agentOptions(root),
      now: () => '2026-07-22T10:00:00.000Z',
    });
    const claude = readFileSync(join(root, '.claude/agents/reviewer.md'));
    const codex = readFileSync(join(root, '.codex/agents/reviewer.toml'));
    const cursor = readFileSync(join(root, '.cursor/agents/reviewer.md'));
    expect(claude).toEqual(AGENT);
    expect(cursor).toEqual(AGENT);
    expect(codex.toString()).toContain('developer_instructions =');
    expect(first.manifest).toMatchObject({
      schemaVersion: 2,
      kind: 'agents',
      generatedAt: '2026-07-22T10:00:00.000Z',
      files: { 'reviewer.md': sha(AGENT) },
      providers: {
        claude: { files: { 'reviewer.md': sha(AGENT) } },
        codex: { files: { 'reviewer.toml': sha(codex) } },
        cursor: { files: { 'reviewer.md': sha(AGENT) } },
      },
    });

    const bytes = readFileSync(join(root, '.devkit/agents-manifest.json'), 'utf8');
    const second = syncProviderNativeAssets({
      ...agentOptions(root),
      now: () => '2026-07-22T11:00:00.000Z',
    });
    expect(second.manifest.generatedAt).toBe('2026-07-22T10:00:00.000Z');
    expect(readFileSync(join(root, '.devkit/agents-manifest.json'), 'utf8')).toBe(bytes);
    expect(existsSync(join(root, '.devkit/agent-assets.lock'))).toBe(false);
  });

  it('preserves a foreign or tracked unit across every selected provider unless adopted', () => {
    const root = tempRoot();
    mkdirSync(join(root, '.codex/agents'), { recursive: true });
    writeFileSync(join(root, '.codex/agents/reviewer.toml'), 'user-owned = true\n');

    expect(findProviderNativeAssetConflicts(agentOptions(root))).toMatchObject([
      { unit: 'reviewer.md', reason: 'foreign', provider: 'codex' },
    ]);
    const preserved = syncProviderNativeAssets(agentOptions(root));
    expect(preserved.manifest.files).toEqual({});
    expect(existsSync(join(root, '.claude/agents/reviewer.md'))).toBe(false);
    expect(readFileSync(join(root, '.codex/agents/reviewer.toml'), 'utf8')).toBe(
      'user-owned = true\n',
    );

    const adopted = syncProviderNativeAssets({
      ...agentOptions(root),
      override: () => true,
    });
    expect(adopted.manifest.files).toHaveProperty('reviewer.md');
    expect(readFileSync(join(root, '.codex/agents/reviewer.toml'), 'utf8')).not.toBe(
      'user-owned = true\n',
    );

    const trackedRoot = tempRoot();
    const tracked = syncProviderNativeAssets({
      ...agentOptions(trackedRoot),
      skipTracked: (rel) => rel === '.codex/agents/reviewer.toml',
      override: () => true,
    });
    expect(tracked.skips).toMatchObject([{ unit: 'reviewer.md', reason: 'tracked' }]);
    expect(tracked.manifest.files).toEqual({});
    expect(existsSync(join(trackedRoot, '.claude/agents/reviewer.md'))).toBe(false);
  });

  it('carries forward only prior owned outputs when a newly selected provider conflicts', () => {
    const root = tempRoot();
    mkdirSync(join(root, '.devkit'), { recursive: true });
    mkdirSync(join(root, '.claude/agents'), { recursive: true });
    mkdirSync(join(root, '.codex/agents'), { recursive: true });
    writeFileSync(join(root, '.claude/agents/reviewer.md'), AGENT);
    writeFileSync(join(root, '.codex/agents/reviewer.toml'), 'user-owned = true\n');
    writeFileSync(
      join(root, '.devkit/agents-manifest.json'),
      JSON.stringify({
        files: { 'reviewer.md': sha(AGENT) },
        targets: ['claude'],
        devkitRef: 'v1.2.2',
        generatedAt: '2026-07-21T10:00:00.000Z',
      }),
    );

    const result = syncProviderNativeAssets(agentOptions(root));
    expect(result.manifest.files).toEqual({ 'reviewer.md': sha(AGENT) });
    expect(result.manifest.providers.claude?.files).toEqual({ 'reviewer.md': sha(AGENT) });
    expect(result.manifest.providers.codex?.files).toEqual({});
    expect(result.manifest.providers.cursor?.files).toEqual({});
    expect(readFileSync(join(root, '.codex/agents/reviewer.toml'), 'utf8')).toBe(
      'user-owned = true\n',
    );
    expect(existsSync(join(root, '.cursor/agents/reviewer.md'))).toBe(false);
  });

  it('relinquishes a tracked provider output without dropping safe ownership elsewhere', () => {
    const root = tempRoot();
    syncProviderNativeAssets(agentOptions(root));
    const trackedPath = join(root, '.codex/agents/reviewer.toml');
    writeFileSync(trackedPath, 'tracked user bytes\n');

    const rerun = syncProviderNativeAssets({
      ...agentOptions(root),
      skipTracked: (rel) => rel === '.codex/agents/reviewer.toml',
    });
    expect(rerun.manifest.providers.codex?.files).not.toHaveProperty('reviewer.toml');
    expect(rerun.manifest.providers.claude?.files).toHaveProperty('reviewer.md');
    expect(rerun.manifest.providers.cursor?.files).toHaveProperty('reviewer.md');

    removeProviderNativeAssets({
      root,
      kind: 'agents',
      dropManifest: true,
    });
    expect(readFileSync(trackedPath, 'utf8')).toBe('tracked user bytes\n');
    expect(existsSync(join(root, '.claude/agents/reviewer.md'))).toBe(false);
    expect(existsSync(join(root, '.cursor/agents/reviewer.md'))).toBe(false);
  });

  it('preserves a tracked stale output while relinquishing its ownership', () => {
    const root = tempRoot();
    syncProviderNativeAssets(agentOptions(root));
    const trackedRel = '.codex/agents/reviewer.toml';
    const trackedPath = join(root, trackedRel);
    writeFileSync(trackedPath, 'tracked stale bytes\n');

    const rerun = syncProviderNativeAssets({
      ...agentOptions(root),
      sources: [],
      skipTracked: (rel) => rel === trackedRel,
    });

    expect(rerun.skips).toContainEqual({
      unit: 'reviewer.md',
      reason: 'tracked',
      provider: 'codex',
      path: trackedRel,
    });
    expect(rerun.manifest.files).toEqual({});
    expect(rerun.manifest.providers.codex?.files).toEqual({});
    expect(readFileSync(trackedPath, 'utf8')).toBe('tracked stale bytes\n');
    expect(existsSync(join(root, '.claude/agents/reviewer.md'))).toBe(false);
    expect(existsSync(join(root, '.cursor/agents/reviewer.md'))).toBe(false);
  });

  it('validates every projection before publishing any output or manifest', () => {
    const root = tempRoot();
    expect(() =>
      syncProviderNativeAssets({
        ...agentOptions(root),
        sources: [
          { logicalRel: 'reviewer.md', content: AGENT },
          { logicalRel: 'broken.md', content: Buffer.from('no frontmatter') },
        ],
      }),
    ).toThrow(/frontmatter/);
    expect(existsSync(join(root, '.claude/agents/reviewer.md'))).toBe(false);
    expect(existsSync(join(root, '.devkit/agents-manifest.json'))).toBe(false);
  });

  it('uses the existing agent-hook collision key when a hook is adopted', () => {
    const root = tempRoot();
    mkdirSync(join(root, '.codex/hooks'), { recursive: true });
    writeFileSync(join(root, '.codex/hooks/check.sh'), 'mine\n');
    const override = vi.fn(() => true);
    syncProviderNativeAssets({
      root,
      kind: 'hooks',
      sources: [{ logicalRel: 'check.sh', content: Buffer.from('devkit\n') }],
      targets: ['codex'],
      devkitRef: null,
      override,
    });
    expect(override).toHaveBeenCalledWith('agent-hook', 'check.sh');
    expect(readFileSync(join(root, '.codex/hooks/check.sh'), 'utf8')).toBe('devkit\n');
  });

  it('sets every hook output mode before publishing its manifest', () => {
    const root = tempRoot();
    const result = syncProviderNativeAssets({
      root,
      kind: 'hooks',
      sources: [{ logicalRel: 'check.sh', content: Buffer.from('#!/bin/sh\n') }],
      targets: ['claude', 'codex', 'cursor'],
      devkitRef: null,
      fileMode: 0o755,
    });

    for (const outputPath of result.outputPaths)
      expect(statSync(join(root, outputPath)).mode & 0o111).toBe(0o111);
    expect(existsSync(join(root, '.devkit/agent-hooks-manifest.json'))).toBe(true);
  });

  it('does not publish hook ownership when setting an output mode fails', () => {
    const root = tempRoot();
    expect(() =>
      syncProviderNativeAssets({
        root,
        kind: 'hooks',
        sources: [{ logicalRel: 'check.sh', content: Buffer.from('#!/bin/sh\n') }],
        targets: ['codex'],
        devkitRef: null,
        fileMode: Number.NaN,
      }),
    ).toThrow();
    expect(existsSync(join(root, '.devkit/agent-hooks-manifest.json'))).toBe(false);
  });

  it('never follows a nested parent or leaf symlink, even when override is enabled', () => {
    const skillRoot = tempRoot();
    const outside = join(skillRoot, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'reference.md'), 'keep\n');
    mkdirSync(join(skillRoot, '.agents/skills/review/references'), { recursive: true });
    rmSync(join(skillRoot, '.agents/skills/review/references'), { recursive: true });
    symlinkSync(outside, join(skillRoot, '.agents/skills/review/references'));
    expect(isSafeAgentAssetPath(skillRoot, '.agents/skills/review/references/reference.md')).toBe(
      false,
    );
    const skill = syncProviderNativeAssets({
      root: skillRoot,
      kind: 'skills',
      sources: [
        { logicalRel: 'review/SKILL.md', content: Buffer.from('# Review\n') },
        { logicalRel: 'review/references/reference.md', content: Buffer.from('replace\n') },
      ],
      targets: ['codex'],
      devkitRef: null,
      override: () => true,
    });
    expect(skill.skips).toContainEqual(
      expect.objectContaining({ unit: 'review', reason: 'unsafe', provider: 'codex' }),
    );
    expect(readFileSync(join(outside, 'reference.md'), 'utf8')).toBe('keep\n');
    expect(skill.manifest.files).toEqual({});

    const agentRoot = tempRoot();
    const target = join(agentRoot, 'outside.toml');
    writeFileSync(target, 'keep\n');
    mkdirSync(join(agentRoot, '.codex/agents'), { recursive: true });
    symlinkSync(target, join(agentRoot, '.codex/agents/reviewer.toml'));
    expect(isSafeAgentAssetPath(agentRoot, '.codex/agents/reviewer.toml')).toBe(false);
    const agent = syncProviderNativeAssets({ ...agentOptions(agentRoot), override: () => true });
    expect(agent.skips).toContainEqual(
      expect.objectContaining({ unit: 'reviewer.md', reason: 'unsafe', provider: 'codex' }),
    );
    expect(readFileSync(target, 'utf8')).toBe('keep\n');
    expect(existsSync(join(agentRoot, '.claude/agents/reviewer.md'))).toBe(false);
  });
});

describe('migration and removal', () => {
  it('keeps Claude/Cursor-only installs on v1 and transitions only when Codex is selected', () => {
    const root = tempRoot();
    const legacy = syncSkills([], root, ['claude', 'cursor']);
    expect(legacy).not.toHaveProperty('schemaVersion');
    expect(
      JSON.parse(readFileSync(join(root, '.devkit/skills-manifest.json'), 'utf8')),
    ).not.toHaveProperty('schemaVersion');

    const native = syncSkills([], root, ['claude', 'codex', 'cursor']);
    expect(native).toMatchObject({ schemaVersion: 2, kind: 'skills' });
    expect(existsSync(join(root, '.agents/skills/brainstorming/SKILL.md'))).toBe(true);

    const narrowed = syncSkills([], root, ['claude', 'cursor']);
    expect(narrowed).toMatchObject({ schemaVersion: 2, kind: 'skills' });
    expect(existsSync(join(root, '.agents/skills/brainstorming/SKILL.md'))).toBe(false);
  });

  it('removes exact v2-owned outputs partially or completely and publishes ownership last', () => {
    const root = tempRoot();
    syncProviderNativeAssets(agentOptions(root));

    const partial = removeProviderNativeAssets({
      root,
      kind: 'agents',
      targets: ['codex'],
    });
    expect(partial).toMatchObject({ handled: true, removed: ['.codex/agents/reviewer.toml'] });
    expect(existsSync(join(root, '.codex/agents/reviewer.toml'))).toBe(false);
    expect(existsSync(join(root, '.claude/agents/reviewer.md'))).toBe(true);
    expect(partial.manifest?.providers).not.toHaveProperty('codex');

    const complete = removeProviderNativeAssets({
      root,
      kind: 'agents',
      targets: ['claude'],
      dropManifest: true,
    });
    expect(complete.manifest).toBeNull();
    expect(existsSync(join(root, '.claude/agents/reviewer.md'))).toBe(false);
    expect(existsSync(join(root, '.cursor/agents/reviewer.md'))).toBe(false);
    expect(existsSync(join(root, '.devkit/agents-manifest.json'))).toBe(false);
  });

  it('refuses removal through a replaced symlink and leaves the manifest authoritative', () => {
    const root = tempRoot();
    syncProviderNativeAssets(agentOptions(root));
    const output = join(root, '.codex/agents/reviewer.toml');
    const outside = join(root, 'outside.toml');
    writeFileSync(outside, 'keep\n');
    rmSync(output);
    symlinkSync(outside, output);

    expect(() =>
      removeProviderNativeAssets({
        root,
        kind: 'agents',
        targets: ['codex'],
      }),
    ).toThrow(/Refusing to remove/);
    expect(readFileSync(outside, 'utf8')).toBe('keep\n');
    expect(existsSync(join(root, '.devkit/agents-manifest.json'))).toBe(true);
    expect(existsSync(join(root, '.claude/agents/reviewer.md'))).toBe(true);
  });

  it('refuses to recursively remove a managed file replaced by a consumer directory', () => {
    const root = tempRoot();
    syncProviderNativeAssets(agentOptions(root));
    const output = join(root, '.codex/agents/reviewer.toml');
    rmSync(output);
    mkdirSync(output);
    writeFileSync(join(output, 'consumer.txt'), 'keep\n');

    expect(() =>
      removeProviderNativeAssets({
        root,
        kind: 'agents',
        targets: ['codex'],
      }),
    ).toThrow(/Refusing to remove/);
    expect(readFileSync(join(output, 'consumer.txt'), 'utf8')).toBe('keep\n');
    expect(existsSync(join(root, '.devkit/agents-manifest.json'))).toBe(true);
  });

  it('retains omitted v2 and legacy hook records for additive --only syncs', () => {
    const root = tempRoot();
    const initial = syncProviderNativeAssets({
      root,
      kind: 'hooks',
      sources: [
        { logicalRel: 'selected.sh', content: Buffer.from('old selected\n') },
        { logicalRel: 'other.sh', content: Buffer.from('old other\n') },
      ],
      targets: ['claude', 'codex', 'cursor'],
      devkitRef: 'v1',
    });
    writeFileSync(join(root, '.claude/hooks/other.sh'), 'locally changed\n');
    const updated = syncProviderNativeAssets({
      root,
      kind: 'hooks',
      sources: [{ logicalRel: 'selected.sh', content: Buffer.from('new selected\n') }],
      targets: ['claude', 'codex', 'cursor'],
      devkitRef: 'v2',
      retainUnspecified: true,
    });
    expect(readFileSync(join(root, '.claude/hooks/other.sh'), 'utf8')).toBe('locally changed\n');
    expect(updated.manifest.files['other.sh']).toBe(initial.manifest.files['other.sh']);
    expect(updated.manifest.providers.codex?.files['other.sh']).toBe(
      initial.manifest.providers.codex?.files['other.sh'],
    );

    const legacyRoot = tempRoot();
    mkdirSync(join(legacyRoot, '.devkit'), { recursive: true });
    for (const provider of ['claude', 'cursor']) {
      mkdirSync(join(legacyRoot, `.${provider}/hooks`), { recursive: true });
      writeFileSync(join(legacyRoot, `.${provider}/hooks/selected.sh`), 'old selected\n');
      writeFileSync(join(legacyRoot, `.${provider}/hooks/other.sh`), 'old other\n');
    }
    writeFileSync(
      join(legacyRoot, '.devkit/agent-hooks-manifest.json'),
      JSON.stringify({
        files: {
          'selected.sh': sha(Buffer.from('old selected\n')),
          'other.sh': sha(Buffer.from('old other\n')),
        },
        targets: ['claude', 'cursor'],
      }),
    );
    const migrated = syncProviderNativeAssets({
      root: legacyRoot,
      kind: 'hooks',
      sources: [{ logicalRel: 'selected.sh', content: Buffer.from('new selected\n') }],
      targets: ['claude', 'codex', 'cursor'],
      devkitRef: 'v2',
      retainUnspecified: true,
    });
    expect(migrated.manifest.files['other.sh']).toBe(sha(Buffer.from('old other\n')));
    expect(migrated.manifest.providers.claude?.files['other.sh']).toBe(
      sha(Buffer.from('old other\n')),
    );
    expect(migrated.manifest.providers.cursor?.files['other.sh']).toBe(
      sha(Buffer.from('old other\n')),
    );
    expect(migrated.manifest.providers.codex?.files).not.toHaveProperty('other.sh');
    expect(readFileSync(join(legacyRoot, '.cursor/hooks/other.sh'), 'utf8')).toBe('old other\n');
  });
});
