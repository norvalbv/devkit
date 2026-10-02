// fallow reads only vitest.config.* / vite.config.*, so every e2e test and setup module the vitest
// configs load must be a declared .fallowrc.jsonc entry, or ship's audit lists it as unused.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseJsonc } from '../lib/husky/format-identity/jsonc.mts';
import unitConfig from '../../vitest.config.mjs';
import e2eConfig from '../../vitest.e2e.config.mjs';

const ROOT = join(import.meta.dirname, '..', '..');

interface TestBlock {
  include?: string | string[];
  setupFiles?: string | string[];
  globalSetup?: string | string[];
}

// vitest accepts a bare string or an array for each of these keys; './x' and 'x' name one file.
const paths = (value: string | string[] | undefined): string[] =>
  [value ?? []].flat().map((p) => p.replace(/^\.\//, ''));

const setupPaths = (test: TestBlock): string[] => [
  ...paths(test.setupFiles),
  ...paths(test.globalSetup),
];

/** Paths fallow cannot reach on its own and so must be listed under `entry`. */
function requiredEntries(unit: TestBlock, e2e: TestBlock): string[] {
  // Setup modules the unit config already names are resolved by fallow's vitest plugin.
  const resolvedByPlugin = new Set(setupPaths(unit));
  return [
    ...paths(e2e.include),
    ...setupPaths(e2e).filter((p) => !resolvedByPlugin.has(p)),
    ...paths(unit.include).filter((p) => p.startsWith('e2e/')),
  ];
}

describe('.fallowrc.jsonc entry points', () => {
  const fallowrc = parseJsonc<{ entry?: string[] }>(
    readFileSync(join(ROOT, '.fallowrc.jsonc'), 'utf8'),
  );

  it('parses, so an unreadable config cannot pass vacuously', () => {
    expect(fallowrc?.entry?.length).toBeGreaterThan(0);
  });

  it('declares every test file and setup module the vitest configs load outside the plugin', () => {
    const required = requiredEntries(unitConfig.test ?? {}, e2eConfig.test ?? {});
    // The e2e include, its global-setup and the e2e/lib unit glob: never an empty requirement.
    expect(required).toEqual(
      expect.arrayContaining([
        'e2e/**/*.e2e.test.mts',
        'e2e/lib/global-setup.mts',
        'e2e/lib/**/*.unit.test.mts',
      ]),
    );
    expect(required.filter((p) => !fallowrc?.entry?.includes(p))).toEqual([]);
  });
});

describe('requiredEntries', () => {
  it('normalises bare-string keys and leading ./ the way vitest does', () => {
    expect(
      requiredEntries({}, { include: 'e2e/a.test.mts', globalSetup: './e2e/setup.mts' }),
    ).toEqual(['e2e/a.test.mts', 'e2e/setup.mts']);
  });

  it('requires a root-level setup module only the e2e config loads', () => {
    expect(
      requiredEntries(
        { setupFiles: ['./shared.mjs'] },
        { setupFiles: ['./shared.mjs'], globalSetup: ['./e2e-only.mjs'] },
      ),
    ).toEqual(['e2e-only.mjs']);
  });

  it('ignores unit-config includes outside e2e/, which the plugin already resolves', () => {
    expect(requiredEntries({ include: ['cli/**/*.test.mts', 'e2e/x.unit.test.mts'] }, {})).toEqual([
      'e2e/x.unit.test.mts',
    ]);
  });
});
