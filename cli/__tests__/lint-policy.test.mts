import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { testSpawnSync as spawnSync } from './_helpers.mts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OXLINT = join(ROOT, 'node_modules', '.bin', 'oxlint');
const OXLINT_CONFIG = join(ROOT, 'oxc', 'oxlint.devkit-lint.json');
const BIOME = join(ROOT, 'node_modules', '.bin', 'biome');
const NON_JS_CONFIG = join(ROOT, 'biome', 'non-js.jsonc');
const REGEX_CONFIG = join(ROOT, 'biome', 'regex.jsonc');
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

  it('keeps the existing production-only top-level-regex rule in Biome', () => {
    const result = spawnSync(
      BIOME,
      [
        'lint',
        '--config-path',
        REGEX_CONFIG,
        '--diagnostic-level=error',
        '--stdin-file-path',
        'cli/production.mts',
      ],
      { encoding: 'utf8', input: 'const matcher = /value/;\nmatcher.test("x");\n' },
    );

    expect(result.status).toBe(1);
  });

  it.each([
    ['JSON duplicate keys', 'package.json', '{"name":"one","name":"two"}\n'],
    ['CSS unknown properties', 'cli/style.css', 'a { colr: red; }\n'],
  ])('retains Biome for %s', (_name, path, source) => {
    const result = spawnSync(
      BIOME,
      [
        'check',
        '--config-path',
        NON_JS_CONFIG,
        '--formatter-enabled=false',
        '--assist-enabled=false',
        '--error-on-warnings',
        '--stdin-file-path',
        path,
      ],
      { encoding: 'utf8', input: source },
    );

    expect(result.status).toBe(1);
  });
});
