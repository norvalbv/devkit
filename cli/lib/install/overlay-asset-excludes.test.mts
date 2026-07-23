import { describe, expect, it } from 'vitest';
import { overlayAssetExcludes } from './overlay-asset-excludes.mts';

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
