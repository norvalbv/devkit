// Unit tests for the import-wall baseline generator's parsing + classification.
// The scan-mode message-format coupling is pinned HERE — a plugin upgrade that changes
// the debug format fails these tests AND the generator's own loud-failure guard, so the
// baseline can never silently widen. (Ported from the frink-local generator, which is being
// deleted in favour of this devkit port — coverage must live where the generator lives.)
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyWidening,
  computeImportWallBaseline,
  parseImportPath,
} from '../lib/generate/generate-import-wall-baseline.mts';
import { linkStubIsolatedInstall } from './_install-layouts.mts';

describe('parseImportPath', () => {
  it('extracts the import path from the plugin debugMode format', () => {
    const msg = `Module must not import the selected import.\n\nFile path   = "src/renderer/x.ts"\nImport path = "src/main/lib/cloud/flows.ts"`;
    expect(parseImportPath(msg)).toBe('src/main/lib/cloud/flows.ts');
  });

  it('returns null when the debug suffix is absent (format drift trips the loud guard)', () => {
    expect(parseImportPath('Module must not import the selected import.')).toBeNull();
  });
});

describe('classifyWidening', () => {
  it.each([
    ['src/main/lib/cloud/flows.ts', 'src/main/**'],
    ['src/preload/index.d.ts', 'src/preload/**'],
    ['src/renderer/utils/source-filter.ts', 'src/renderer/utils/**'],
    ['src/renderer/types/resource-info.ts', 'src/renderer/types/**'],
    ['src/renderer/constants/ide-origins.ts', 'src/renderer/constants/**'],
    ['src/renderer/contexts/foo.tsx', 'src/renderer/contexts/**'],
    ['src/renderer/features/agents/atoms/index.ts', 'src/renderer/features/agents/**'],
  ])('%s → %s', (importPath, expected) => {
    expect(classifyWidening(importPath)).toBe(expected);
  });

  it('returns null for an unknown wall class (generator exits 1)', () => {
    expect(classifyWidening('src/weird/place.ts')).toBeNull();
    expect(classifyWidening('socket-server/src/index.ts')).toBeNull();
  });
});

describe('computeImportWallBaseline', () => {
  // A blind scan returns no violations, which would rewrite the baseline to empty.
  it('refuses a linked isolated install rather than scanning a tree it cannot root at', () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'import-wall-isolated-')));
    const donor = linkStubIsolatedInstall(cwd);
    try {
      expect(() => computeImportWallBaseline(cwd)).toThrow(/linked isolated install/);
    } finally {
      for (const dir of [cwd, donor]) rmSync(dir, { recursive: true, force: true });
    }
  });
});
