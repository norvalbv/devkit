import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  decodeSyncManifest,
  encodeSyncManifestV2,
  type SyncManifest,
  type SyncManifestV2,
} from '../../sync-manifest.mts';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

function agentManifest(): SyncManifestV2 {
  return {
    schemaVersion: 2,
    kind: 'agents',
    devkitRef: 'v1.2.3',
    generatedAt: '2026-07-21T00:00:00.000Z',
    files: { 'feature-critique.md': A },
    providers: {
      claude: { files: { 'feature-critique.md': A } },
      codex: { files: { 'feature-critique.toml': B } },
    },
  };
}

describe('sync manifest v2 codec', () => {
  it('round-trips canonical provider-native skill and agent outputs without filesystem roots', () => {
    const skills: SyncManifestV2 = {
      schemaVersion: 2,
      kind: 'skills',
      devkitRef: null,
      generatedAt: '2026-07-21T00:00:00.000Z',
      files: { 'brainstorming/SKILL.md': A },
      providers: {
        cursor: { files: { 'brainstorming/SKILL.md': A } },
        codex: { files: { 'brainstorming/SKILL.md': A } },
      },
    };
    const encoded = encodeSyncManifestV2(skills, 'skills');
    expect(decodeSyncManifest(JSON.parse(encoded), 'skills')).toEqual({
      version: 2,
      manifest: {
        ...skills,
        providers: {
          codex: { files: { 'brainstorming/SKILL.md': A } },
          cursor: { files: { 'brainstorming/SKILL.md': A } },
        },
      },
    });
    expect(encoded).not.toContain('.agents');
    expect(encoded).not.toContain('.codex');

    expect(
      decodeSyncManifest(JSON.parse(encodeSyncManifestV2(agentManifest(), 'agents')), 'agents'),
    ).toEqual({ version: 2, manifest: agentManifest() });
  });

  it('cannot enter legacy broad-ownership helpers through structural typing', () => {
    expectTypeOf<SyncManifestV2>().not.toExtend<SyncManifest>();
  });

  it('keeps explicit legacy targets and limits a target-less legacy manifest to Claude/Cursor', () => {
    expect(
      decodeSyncManifest({ files: { 'reviewer.md': A }, targets: ['cursor'] }, 'agents'),
    ).toEqual({
      version: 1,
      manifest: { files: { 'reviewer.md': A }, targets: ['cursor'] },
    });
    expect(decodeSyncManifest({ files: { 'skill/SKILL.md': A } }, 'skills')).toEqual({
      version: 1,
      manifest: { files: { 'skill/SKILL.md': A }, targets: ['claude', 'cursor'] },
    });
  });

  it('returns a deep snapshot rather than retaining caller-owned objects', () => {
    const input = agentManifest();
    const decoded = decodeSyncManifest(input, 'agents');
    input.files['feature-critique.md'] = B;
    const codex = input.providers.codex;
    if (!codex) throw new Error('Codex projection missing from fixture');
    codex.files['feature-critique.toml'] = A;
    expect(decoded).toEqual({ version: 2, manifest: agentManifest() });
  });
});

describe('sync manifest schema and projection rejection', () => {
  it.each([
    ['future schema', { ...agentManifest(), schemaVersion: 3 }],
    [
      'unknown field',
      { ...agentManifest(), ownershipFallback: { provider: 'codex', rel: 'anything' } },
    ],
    [
      'unknown provider',
      { ...agentManifest(), providers: { ...agentManifest().providers, other: { files: {} } } },
    ],
    ['bad source hash', { ...agentManifest(), files: { 'feature-critique.md': 'A'.repeat(64) } }],
    ['source traversal', { ...agentManifest(), files: { '../feature-critique.md': A } }],
    ['source absolute path', { ...agentManifest(), files: { '/feature-critique.md': A } }],
    ['source Windows path', { ...agentManifest(), files: { 'C:/feature-critique.md': A } }],
    ['source backslash', { ...agentManifest(), files: { 'dir\\feature-critique.md': A } }],
    ['source NUL', { ...agentManifest(), files: { 'feature\0-critique.md': A } }],
    ['source C1 control', { ...agentManifest(), files: { 'feature\u0085-critique.md': A } }],
    ['oversized metadata', { ...agentManifest(), devkitRef: 'x'.repeat(1025) }],
    [
      'noncanonical Codex projection',
      {
        ...agentManifest(),
        providers: { codex: { files: { 'feature-critique.md': B } } },
      },
    ],
    [
      'orphan output',
      {
        ...agentManifest(),
        providers: { codex: { files: { 'other.toml': B } } },
      },
    ],
    ['orphan source', { ...agentManifest(), providers: { codex: { files: {} } } }],
    [
      'identity hash mismatch',
      {
        ...agentManifest(),
        providers: { claude: { files: { 'feature-critique.md': B } } },
      },
    ],
    [
      'provider ownership field',
      {
        ...agentManifest(),
        providers: { codex: { files: { 'feature-critique.toml': B }, ownsDirectory: true } },
      },
    ],
  ])('rejects %s', (_name, manifest) => {
    expect(() => decodeSyncManifest(manifest, 'agents')).toThrow();
  });
});

describe('sync manifest resource and path boundaries', () => {
  it('rejects cross-kind replay, excessive fields/text, and filesystem-colliding Unicode', () => {
    expect(() => decodeSyncManifest(agentManifest(), 'hooks')).toThrow(/kind/);

    const tooManyFiles = Object.fromEntries(
      Array.from({ length: 4097 }, (_, index) => [`${index}.md`, A]),
    );
    expect(() =>
      decodeSyncManifest({ ...agentManifest(), files: tooManyFiles }, 'agents'),
    ).toThrow();

    const excessiveText = Object.fromEntries(
      Array.from({ length: 300 }, (_, index) => [`${index}-${'x'.repeat(4070)}`, A]),
    );
    expect(() =>
      decodeSyncManifest(
        {
          schemaVersion: 2,
          kind: 'skills',
          devkitRef: null,
          generatedAt: '2026-07-21T00:00:00.000Z',
          files: excessiveText,
          providers: {},
        },
        'skills',
      ),
    ).toThrow(/accepted limit/);

    for (const collidingPath of ['\ud800/SKILL.md', '\ud801/SKILL.md']) {
      expect(() =>
        decodeSyncManifest(
          {
            schemaVersion: 2,
            kind: 'skills',
            devkitRef: null,
            generatedAt: '2026-07-21T00:00:00.000Z',
            files: { [collidingPath]: A },
            providers: { claude: { files: { [collidingPath]: A } } },
          },
          'skills',
        ),
      ).toThrow(/well-formed Unicode/);
    }
  });
});

describe('sync manifest hostile legacy input', () => {
  it('rejects arrays, accessors, proxies, and malformed legacy targets without invoking them', () => {
    expect(() => decodeSyncManifest([], 'skills')).toThrow();
    const files = vi.fn(() => ({ 'skill/SKILL.md': A }));
    expect(() =>
      decodeSyncManifest(
        {
          get files() {
            return files();
          },
        },
        'skills',
      ),
    ).toThrow();
    expect(files).not.toHaveBeenCalled();

    const { proxy, revoke } = Proxy.revocable({ files: { 'skill/SKILL.md': A } }, {});
    revoke();
    expect(() => decodeSyncManifest(proxy, 'skills')).toThrow();
    expect(() =>
      decodeSyncManifest({ files: { 'skill/SKILL.md': A }, targets: ['codex'] }, 'skills'),
    ).toThrow();
    expect(() =>
      decodeSyncManifest(
        { files: { 'skill/SKILL.md': A }, targets: ['claude', 'claude'] },
        'skills',
      ),
    ).toThrow();

    const outOfRangeTargets: unknown[] = [];
    const hiddenAccessor = vi.fn(() => 'claude');
    for (let index = 0; index < 4097; index++) {
      Object.defineProperty(outOfRangeTargets, String(4_294_967_295 + index), {
        enumerable: true,
        ...(index === 0 ? { get: hiddenAccessor } : { value: 'claude' }),
      });
    }
    expect(() =>
      decodeSyncManifest({ files: { 'skill/SKILL.md': A }, targets: outOfRangeTargets }, 'skills'),
    ).toThrow();
    expect(hiddenAccessor).not.toHaveBeenCalled();
  });
});
