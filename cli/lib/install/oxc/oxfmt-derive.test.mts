import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { digest } from '../../fs-helpers.mts';
import { checkOxcCapability, syncOxcCapability } from './lifecycle.mts';
import { deriveOxfmtConfig, LEGACY_OXFMT_STARTER } from './oxfmt-derive.mts';
import { ownershipFor } from './ownership.mts';
import { resolveOxcRuntime } from './runtime.mts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'devkit-oxfmt-derive-'));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const derived = (root: string) => JSON.parse(deriveOxfmtConfig(root));
const EXTENDS_BASE = '{ "extends": ["@norvalbv/devkit/biome/base"] }\n';

function oxfmtCheck(root: string) {
  const { binPath } = resolveOxcRuntime('fmt');
  const run = spawnSync(process.execPath, [binPath, '--check', '.'], {
    cwd: root,
    encoding: 'utf8',
  });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

describe('deriveOxfmtConfig — the repo Biome style, as Oxfmt options', () => {
  it('a repo extending the devkit preset gets its single-quote / 2-space / width-100 style', () => {
    expect(derived(repo({ 'biome.jsonc': EXTENDS_BASE }))).toMatchObject({
      useTabs: false,
      tabWidth: 2,
      printWidth: 100,
      singleQuote: true,
      trailingComma: 'all',
      semi: true,
    });
  });

  it('a file two parents share is applied by both, so the later parent wins', () => {
    const root = repo({
      'biome.json': '{ "extends": ["./b.json", "./c.json"] }\n',
      'b.json': '{ "extends": ["./d.json"], "formatter": { "lineWidth": 80 } }\n',
      'c.json': '{ "extends": ["./d.json"] }\n',
      'd.json': '{ "formatter": { "lineWidth": 100 } }\n',
    });
    expect(derived(root)).toMatchObject({ printWidth: 100 });
  });

  it('an extends cycle terminates instead of recursing forever', () => {
    const root = repo({
      'biome.json': '{ "extends": ["./a.json"], "formatter": { "lineWidth": 90 } }\n',
      'a.json': '{ "extends": ["./biome.json"] }\n',
    });
    expect(derived(root)).toMatchObject({ printWidth: 90 });
  });

  it('resolves extends recursively, through a local file and the vendored preset path', () => {
    const root = repo({
      'biome.json': '{ "extends": ["./shared.json"] }\n',
      'shared.json':
        '{ "extends": ["./.devkit/biome/react.jsonc"], "formatter": { "lineWidth": 80 } }\n',
    });
    expect(derived(root)).toMatchObject({ printWidth: 80, singleQuote: true });
  });

  it("the repo's own setting wins over the preset it extends", () => {
    const root = repo({
      'biome.jsonc': `{
        // a repo that overrides devkit's quote style
        "extends": ["@norvalbv/devkit/biome/base"],
        "javascript": { "formatter": { "quoteStyle": "double" } },
      }\n`,
    });
    expect(derived(root)).toMatchObject({ singleQuote: false, printWidth: 100 });
  });

  it('a repo that turned its Biome formatter off gets an Oxfmt config that formats nothing', () => {
    const root = repo({
      'biome.jsonc':
        '{ "extends": ["@norvalbv/devkit/biome/base"], "formatter": { "enabled": false } }\n',
    });
    expect(deriveOxfmtConfig(root)).toBe('{ "ignorePatterns": ["**"] }\n');
  });

  it('a repo with no Biome config gets the house style, identical to the preset', () => {
    expect(deriveOxfmtConfig(repo())).toBe(
      deriveOxfmtConfig(repo({ 'biome.jsonc': EXTENDS_BASE })),
    );
  });

  it('keeps package.json order, JSON commas, CSS double quotes, and never formats Markdown', () => {
    expect(derived(repo())).toMatchObject({
      sortPackageJson: false,
      overrides: [
        { files: ['**/*.json', '**/*.jsonc'], options: { trailingComma: 'none' } },
        { files: ['**/*.css', '**/*.scss', '**/*.less'], options: { singleQuote: false } },
      ],
      ignorePatterns: expect.arrayContaining(['**/*.md']),
    });
  });
});

describe('deriveOxfmtConfig — Oxfmt leaves Biome-formatted bytes unchanged', () => {
  it('passes --check on Biome output for every staged extension, and on the config itself', () => {
    const root = repo({
      'biome.jsonc': EXTENDS_BASE,
      'package.json': '{\n  "version": "1.0.0",\n  "name": "fx"\n}\n',
      'settings.jsonc': '{\n  "a": 1,\n  "b": [1, 2]\n}\n',
      'site.css': 'a {\n  font-family: "Inter";\n}\n',
      'src/x.ts': "export const x = { a: 'b', c: [1, 2] };\n",
      'src/y.tsx': 'export const Y = () => <div className="y">hi</div>;\n',
      'NOTES.md': '#   Not   formatted\n\n* item\n',
    });
    writeFileSync(join(root, '.oxfmtrc.json'), deriveOxfmtConfig(root));
    const result = oxfmtCheck(root);
    expect(result.status, result.out).toBe(0);
  });
});

describe('Oxc lifecycle — the derived starter replaces the old {} one', () => {
  const recordOxfmt = (root: string, createdDigest: string) => {
    const path = join(root, '.devkit/oxc/manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.configs.oxfmt.createdDigest = createdDigest;
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  };
  const oxfmtDigest = (root: string) =>
    JSON.parse(readFileSync(join(root, '.devkit/oxc/manifest.json'), 'utf8')).configs.oxfmt
      .createdDigest;

  it('a fresh install writes the derived config and records its digest', () => {
    const root = repo({ 'biome.jsonc': EXTENDS_BASE });
    syncOxcCapability(root);
    const text = readFileSync(join(root, '.oxfmtrc.json'), 'utf8');
    expect(text).toBe(deriveOxfmtConfig(root));
    expect(oxfmtDigest(root)).toBe(digest(text));
  });

  it('an untouched {} starter from an older devkit is replaced, and doctor reads it as the starter', () => {
    const root = repo({ 'biome.jsonc': EXTENDS_BASE });
    syncOxcCapability(root);
    writeFileSync(join(root, '.oxfmtrc.json'), LEGACY_OXFMT_STARTER);
    recordOxfmt(root, digest(LEGACY_OXFMT_STARTER));

    syncOxcCapability(root);

    const text = readFileSync(join(root, '.oxfmtrc.json'), 'utf8');
    expect(text).toBe(deriveOxfmtConfig(root));
    expect(oxfmtDigest(root)).toBe(digest(text));
    const row = checkOxcCapability(root).find((r) => r.name === 'oxfmt config');
    expect(row?.detail).toContain('(Devkit starter)');
  });

  it('a starter the consumer edited is kept byte for byte', () => {
    const root = repo({ 'biome.jsonc': EXTENDS_BASE });
    syncOxcCapability(root);
    const edited = '{ "printWidth": 80 }\n';
    writeFileSync(join(root, '.oxfmtrc.json'), edited);
    recordOxfmt(root, digest(LEGACY_OXFMT_STARTER));

    syncOxcCapability(root);

    expect(readFileSync(join(root, '.oxfmtrc.json'), 'utf8')).toBe(edited);
  });

  it('a ship publish (pinRoot set) never rewrites a tracked {} starter', () => {
    const root = repo({ 'biome.jsonc': EXTENDS_BASE });
    syncOxcCapability(root);
    writeFileSync(join(root, '.oxfmtrc.json'), LEGACY_OXFMT_STARTER);
    recordOxfmt(root, digest(LEGACY_OXFMT_STARTER));

    syncOxcCapability(root, { pinRoot: root });

    expect(readFileSync(join(root, '.oxfmtrc.json'), 'utf8')).toBe(LEGACY_OXFMT_STARTER);
  });
});

// Deriving a starter spawns oxfmt twice, so a consumer can save the file in between; their edit wins.
describe('ownershipFor — a consumer edit made while the starter is derived is kept', () => {
  const NAMES = ['.oxfmtrc.json', '.oxfmtrc.jsonc'];
  const edited = '{ "printWidth": 80 }\n';

  it('an untouched {} edited during the derivation is not replaced', () => {
    const root = repo({ '.oxfmtrc.json': LEGACY_OXFMT_STARTER });
    const previous = { path: '.oxfmtrc.json', createdDigest: digest(LEGACY_OXFMT_STARTER) };
    const starter = () => {
      writeFileSync(join(root, '.oxfmtrc.json'), edited);
      return 'derived\n';
    };
    const plan = { starterPath: '.oxfmtrc.json', starter, replaces: LEGACY_OXFMT_STARTER };

    expect(ownershipFor(root, NAMES, plan, previous, false)).toEqual(previous);
    expect(readFileSync(join(root, '.oxfmtrc.json'), 'utf8')).toBe(edited);
  });

  it('a config the consumer creates during the derivation is adopted, not overwritten', () => {
    const root = repo();
    const starter = () => {
      writeFileSync(join(root, '.oxfmtrc.jsonc'), edited);
      return 'derived\n';
    };

    expect(
      ownershipFor(root, NAMES, { starterPath: '.oxfmtrc.json', starter }, undefined, false),
    ).toEqual({ path: '.oxfmtrc.jsonc', createdDigest: null });
    expect(readFileSync(join(root, '.oxfmtrc.jsonc'), 'utf8')).toBe(edited);
  });
});
