// `devkit init --baselines-only` — the surgical regen path for a structure-RULE change.
// Verifies the guards (mode/preset/config) and the short-circuit contract (writes baselines,
// NOTHING else), plus the consumer-exempt wiring (readImportWallExempt).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readImportWallExempt } from '../commands/init.mts';
import { tmpRepos } from './_helpers.mts';

const { tmpRepo, devkit, cleanup } = tmpRepos('baselines-only-');
afterEach(cleanup);

describe('devkit init --baselines-only (guards)', () => {
  it('rejects overlay/standalone mode (no structure preset there)', () => {
    const r = devkit(tmpRepo(), 'init', '--stack', 'electron', '--baselines-only', '--standalone');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('overlay/standalone');
  });

  it('rejects a stack with no structure preset', () => {
    const r = devkit(tmpRepo(), 'init', '--stack', 'node-service', '--baselines-only');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no structure-lint preset');
  });

  it('rejects when no eslint.config.mjs exists (bare repo)', () => {
    const r = devkit(tmpRepo(), 'init', '--stack', 'electron', '--baselines-only');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no eslint.config.mjs');
  });

  it('short-circuits: regenerates baselines and writes NOTHING else', () => {
    const root = tmpRepo();
    writeFileSync(join(root, 'eslint.config.mjs'), 'export default [];\n');
    const r = devkit(root, 'init', '--stack', 'electron', '--baselines-only');
    expect(r.status).toBe(0);
    // the full-init artefacts must NOT appear — proves the short-circuit skipped them
    expect(existsSync(join(root, '.devkit/config.json'))).toBe(false);
    expect(existsSync(join(root, 'biome.jsonc'))).toBe(false);
    expect(existsSync(join(root, '.husky'))).toBe(false);
  });
});

describe('readImportWallExempt', () => {
  const writeExempt = (root, body) => {
    mkdirSync(join(root, 'eslint', 'baselines'), { recursive: true });
    writeFileSync(join(root, 'eslint', 'baselines', 'exempt.mjs'), body);
  };

  it('reads importWallExempt patterns into a Set', async () => {
    const root = tmpRepo();
    writeExempt(
      root,
      'export const importWallExempt = [{ name: "x", pattern: "src/renderer/lib/trpc.ts" }];\n',
    );
    const set = await readImportWallExempt(root);
    expect(set).toBeInstanceOf(Set);
    expect(set.has('src/renderer/lib/trpc.ts')).toBe(true);
  });

  it('returns empty Set when exempt.mjs is absent', async () => {
    expect((await readImportWallExempt(tmpRepo())).size).toBe(0);
  });
});
