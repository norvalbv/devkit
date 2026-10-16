import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  mkdirSync(dirname(path), { recursive: true });
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

  // RuleTester proves the rule; this proves the config loads it and its override globs match.
  it('blocks an unnamed raw CLI spawn only in a git-integration file', () => {
    const source = [
      "import { spawnSync } from 'node:child_process';",
      "import { CLI } from './_helpers.mts';",
      "spawnSync(process.execPath, [CLI, 'review']);",
      '',
    ].join('\n');
    const lint = (name: string) => {
      const path = fixture(join('cli', '__tests__', name), source);
      return spawnSync(OXLINT, ['--config', OXLINT_CONFIG, '--disable-nested-config', path], {
        encoding: 'utf8',
      });
    };

    const scoped = lint('review.test.mts');
    expect(scoped.status).toBe(1);
    expect(scoped.stdout).toContain('devkit(spawn-site-boundary)');
    expect(lint('parallel-only.test.mts').status).toBe(0);
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
