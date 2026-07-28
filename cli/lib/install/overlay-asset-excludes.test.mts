import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { overlayAssetExcludes } from './overlay-asset-excludes.mts';
import { addToGitExclude } from './overlay-excludes.mts';

const roots: string[] = [];

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
});
