import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { testSpawnSync as spawnSync } from './_helpers.mts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OXLINT = join(ROOT, 'node_modules', '.bin', 'oxlint');
const OXLINT_CONFIG = join(ROOT, 'oxc', 'oxlint.devkit-lint.json');
const roots: string[] = [];

function fixture(name: string, source: string) {
  const root = mkdtempSync(join(tmpdir(), 'devkit-lint-policy-'));
  roots.push(root);
  const path = join(root, name);
  writeFileSync(path, source);
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Devkit lint ownership', () => {
  it('makes the native Oxlint profile fail on a JS/TS correctness violation', () => {
    const path = fixture('unused.mts', 'const unused = 1;\n');

    const result = spawnSync(OXLINT, ['--config', OXLINT_CONFIG, '--disable-nested-config', path], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
  });

  it('runs the policy without a Biome fallback command', () => {
    const packageJson: { scripts?: Record<string, string> } = JSON.parse(
      readFileSync(join(ROOT, 'package.json'), 'utf8'),
    );

    expect(packageJson.scripts?.lint).toBe('bun run lint:oxlint');
    expect(packageJson.scripts?.['lint:biome']).toBeUndefined();
    expect(packageJson.scripts?.['lint:regex']).toBeUndefined();
  });
});
