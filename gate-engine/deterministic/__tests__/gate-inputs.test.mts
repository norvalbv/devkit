import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG_FILENAME } from '../../config.mts';
import {
  FANOUT_BASELINE,
  IMPORT_WALL_BASELINE,
  LINES_BASELINE,
  SIZE_BASELINE,
  STRUCTURE_BASELINE_DIR,
  STRUCTURE_EXEMPT,
} from '../../ratchets/baseline-paths.mts';
import {
  CORRECTNESS_OVERRIDES_FILE,
  gateInputFor,
  gateInputs,
  QAVIS_RECEIPT,
} from '../gate-inputs.mts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(configJson?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'gate-inputs-'));
  roots.push(root);
  if (configJson) writeFileSync(join(root, 'guard.config.json'), configJson);
  return root;
}

const paths = (root: string) => [...gateInputs(root)].map((input) => input.path);

describe('gate-input registry', () => {
  // The list is the whole gate-parity contract, and dropping an entry breaks it silently (the gate
  // falls to defaults and still passes). Pin it so a deletion fails loudly.
  it('pins every fixed entry, then the default config-driven paths', () => {
    expect(paths(repo())).toEqual([
      CONFIG_FILENAME,
      '.fallowrc.json',
      '.fallowrc.jsonc',
      'fallow.toml',
      '.fallow.toml',
      '.fallow',
      'fallow-baselines',
      '.decisions',
      FANOUT_BASELINE,
      LINES_BASELINE,
      SIZE_BASELINE,
      IMPORT_WALL_BASELINE,
      STRUCTURE_EXEMPT,
      '.devkit/oxc',
      '.devkit/anti-slop',
      'eslint.config.devkit.mjs',
      'biome.devkit.jsonc',
      'oxlint.devkit.json',
      '.anti-slop-baseline.json',
      QAVIS_RECEIPT,
      CORRECTNESS_OVERRIDES_FILE,
      '.co-occurrence-allowlist.json',
      'docs/decisions',
    ]);
  });

  it('enumerates each structure baseline module, not the directory', () => {
    const root = repo();
    const structure = join(root, STRUCTURE_BASELINE_DIR);
    mkdirSync(structure, { recursive: true });
    for (const name of ['web.mjs', 'cli.mjs', 'notes.txt', '.hidden.mjs']) {
      writeFileSync(join(structure, name), '');
    }
    const enumerated = [...gateInputs(root)].filter((input) => input.eachFile);
    expect(enumerated.map((input) => input.path)).toEqual([
      `${STRUCTURE_BASELINE_DIR}/cli.mjs`,
      `${STRUCTURE_BASELINE_DIR}/web.mjs`,
    ]);
    expect(enumerated.every((input) => input.kind === 'file' && input.share === 'branch')).toBe(
      true,
    );
  });

  it('resolves config-driven paths from guard.config.json, including a custom decisionsDir', () => {
    const root = repo(
      JSON.stringify({
        indexPath: '.cache/search.db',
        allowlistPath: '.config/allowlist.json',
        decisionsDir: 'records/why',
      }),
    );
    const configured = [...gateInputs(root)].filter((input) => input.field);
    expect(configured.map(({ field, path, share }) => ({ field, path, share }))).toEqual([
      { field: 'indexPath', path: '.cache/search.db', share: 'clone' },
      { field: 'allowlistPath', path: '.config/allowlist.json', share: 'branch' },
      { field: 'decisionsDir', path: 'records/why', share: 'clone' },
    ]);
  });

  it('skips unset and out-of-repo config paths but keeps a name that starts with two dots', () => {
    const root = repo(
      JSON.stringify({
        indexPath: null,
        allowlistPath: '../outside.json',
        decisionsDir: '..decisions',
      }),
    );
    expect([...gateInputs(root)].filter((input) => input.field).map((input) => input.path)).toEqual(
      ['..decisions'],
    );
    const absolute = repo(JSON.stringify({ allowlistPath: join(tmpdir(), 'elsewhere.json') }));
    expect(paths(absolute)).not.toContain(join(tmpdir(), 'elsewhere.json'));
  });

  it('yields the fixed entries before an unparseable config throws', () => {
    const root = repo();
    writeFileSync(join(root, 'guard.config.json'), '{ not json');
    const seen: string[] = [];
    expect(() => {
      for (const input of gateInputs(root)) seen.push(input.path);
    }).toThrow(/not valid JSON/);
    expect(seen).toContain(CONFIG_FILENAME);
    expect(seen).toContain(CORRECTNESS_OVERRIDES_FILE);
  });

  // These sets are the review projection's drift contract; gateInputFor serves them to runtime.mts.
  it('pins the mutable, source-volatile, cache and local-cache flags, inherited by paths below an entry', () => {
    const flagged = (flag: 'mutable' | 'sourceVolatile' | 'cache' | 'localCache') =>
      paths(repo()).filter((path) => gateInputFor(path)?.[flag]);
    expect(flagged('mutable')).toEqual([
      '.fallow',
      'fallow-baselines',
      '.decisions',
      FANOUT_BASELINE,
      LINES_BASELINE,
      SIZE_BASELINE,
      IMPORT_WALL_BASELINE,
      CORRECTNESS_OVERRIDES_FILE,
    ]);
    expect(flagged('sourceVolatile')).toEqual(['.fallow', '.decisions']);
    expect(flagged('cache')).toEqual([QAVIS_RECEIPT]);
    expect(flagged('localCache')).toEqual(['.fallow', '.decisions', QAVIS_RECEIPT]);
    expect(gateInputFor(`${STRUCTURE_BASELINE_DIR}/cli.mjs`)?.mutable).toBe(true);
    expect(gateInputFor('.fallow/cache.bin')?.path).toBe('.fallow');
    expect(gateInputFor('.anti-slop-baseline.json')?.mutable).toBeUndefined();
    expect(gateInputFor('.fallowrc.jsonc.bak')).toBeUndefined();
  });
});
