import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DECISIONS_REGISTRATIONS } from '../../../cli/lib/install/hook-registration-ledger/decisions-registrations.mts';
import { HOOK_REGISTRATIONS } from '../../../cli/lib/install/hook-registration-ledger/registrations.mts';
import { packageDir } from '../../../cli/lib/fs-helpers.mts';
import { matchesRepoGlob } from '../../../skills/_devkit/review-roots.mjs';
import { decisionHookScripts } from '../../decisions/eval/brief/bench.mts';
import { loadCatalog } from '../catalog.mts';
import { suiteHashes } from '../source.mts';
import { memory } from './tracker-fixtures.mts';

const LEDGER = 'cli/lib/install/hook-registration-ledger';
const REGISTRY = `${LEDGER}/registrations.mts`;
const DECISIONS = `${LEDGER}/decisions-registrations.mts`;
const SCRIPTS = decisionHookScripts().map((name) => `agents-hooks/${name}`);

const read = (path: string) => readFileSync(join(packageDir(), path), 'utf8');
const CATALOG = 'docs/benchmarks/catalog.json';
const suite = loadCatalog(memory({ [CATALOG]: read(CATALOG) })).suites.find(
  ({ id }) => id === 'decisions-brief',
);
if (!suite) throw new Error(`${CATALOG} has no decisions-brief suite`);
const { hashes } = suite;
const fingerprinted = (path: string) =>
  hashes.implementation.some((glob) => matchesRepoGlob(path, glob));

function implementationHash(edits: Record<string, string> = {}) {
  const files = Object.fromEntries([REGISTRY, DECISIONS, ...SCRIPTS].map((p) => [p, read(p)]));
  for (const [path, suffix] of Object.entries(edits)) files[path] += suffix;
  return suiteHashes(memory(files), hashes).implementation;
}

describe('decisions-brief implementation fingerprint', () => {
  it('covers exactly what the bench runs: the decisions registrations and every hook script', () => {
    expect(HOOK_REGISTRATIONS.decisions).toBe(DECISIONS_REGISTRATIONS);
    for (const path of [DECISIONS, ...SCRIPTS]) expect(fingerprinted(path), path).toBe(true);
    expect(fingerprinted(REGISTRY)).toBe(false);
  });

  it('ignores an edit to another component registration and stales on a decisions-side edit', () => {
    const base = implementationHash();
    expect(implementationHash({ [REGISTRY]: '\n// another component\n' })).toBe(base);
    for (const path of [DECISIONS, ...SCRIPTS])
      expect(implementationHash({ [path]: '\n// edited\n' }), path).not.toBe(base);
  });
});
