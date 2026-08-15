import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { probeOxcRuntime, resolveOxcRuntime } from './runtime.mts';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devkit-oxc-runtime-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('pinned Oxc runtime', () => {
  it('resolves both exact Devkit dependencies and probes their package-local bins', () => {
    for (const tool of ['lint', 'fmt'] as const) {
      const runtime = resolveOxcRuntime(tool);
      expect(runtime.actualVersion).toBe(runtime.expectedVersion);
      expect(runtime.binPath).toContain(`node_modules/${runtime.packageName}/`);
      expect(probeOxcRuntime(tool)).toMatchObject({ ok: true, runtime });
    }
  });

  it('rejects a resolved package whose version differs from Devkit’s exact pin', () => {
    const root = tempRoot();
    const manifest = join(root, 'package.json');
    mkdirSync(join(root, 'bin'));
    writeFileSync(
      manifest,
      `${JSON.stringify({ version: '0.0.0', bin: { oxlint: './bin/oxlint.js' } })}\n`,
    );
    writeFileSync(join(root, 'bin/oxlint.js'), 'process.stdout.write("fake")\n');

    const result = probeOxcRuntime('lint', { resolvePackage: () => manifest });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('0.0.0 != pinned 1.78.0');
  });
});
