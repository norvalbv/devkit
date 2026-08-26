/**
 * devkit migrate — reconciles a consumer's EMITTED snapshot files (eslint.config.mjs, guard.config.json)
 * with the installed devkit. Pins: devkit-owned eslint.config is REPLACED when stale; guard.config is
 * MERGED (missing keys added, existing values never clobbered); a clean repo plans nothing.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { computeMigration } from '../commands/migrate-config.mts';
import { packageDir, readJson } from '../lib/fs-helpers.mts';
import { resolveOxcRuntime } from '../lib/install/oxc/runtime.mts';
import { structFixtures } from './_helpers.mts';

interface OxfmtContract {
  printWidth: number;
  tabWidth: number;
  useTabs: boolean;
  bracketSpacing: boolean;
  singleQuote: boolean;
  jsxSingleQuote: boolean;
  semi: boolean;
  arrowParens: string;
  bracketSameLine: boolean;
  quoteProps: string;
}

interface BiomePreset {
  formatter: {
    lineWidth: number;
    indentWidth: number;
    indentStyle: string;
    bracketSpacing: boolean;
  };
  javascript: {
    formatter: {
      quoteStyle: string;
      jsxQuoteStyle: string;
      semicolons: string;
      arrowParentheses: string;
      bracketSameLine: boolean;
      quoteProperties: string;
    };
  };
}

const { tmpRepo, write, cleanup } = structFixtures('migrate-');
afterEach(cleanup);

const shim = () =>
  readFileSync(join(packageDir(), 'templates', '_shared', 'eslint.config.mjs'), 'utf8');

describe('computeMigration (react-app: 0.12-era snapshot → current model)', () => {
  it('plans an eslint.config REPLACE + a guard.config MERGE when the emitted files are stale', () => {
    const root = tmpRepo();
    write(root, 'eslint.config.mjs', '// OLD hand-written react-app preset\nexport default [];\n');
    write(root, 'guard.config.json', JSON.stringify({ scanRoots: ['src'], fanoutCap: 12 }));
    const byFile = Object.fromEntries(computeMigration(root, 'react-app').map((c) => [c.file, c]));
    expect(byFile['eslint.config.mjs'].kind).toBe('replace');
    expect(byFile['guard.config.json'].kind).toBe('merge');
    expect(byFile['guard.config.json'].why).toMatch(/structure/);
  });

  it('applying writes the shim + adds the structure block WITHOUT clobbering existing keys', () => {
    const root = tmpRepo();
    write(root, 'eslint.config.mjs', '// OLD\n');
    write(root, 'guard.config.json', JSON.stringify({ scanRoots: ['custom/src'], fanoutCap: 99 }));
    for (const c of computeMigration(root, 'react-app')) c.write();
    expect(readFileSync(join(root, 'eslint.config.mjs'), 'utf8')).toBe(shim());
    const gc = JSON.parse(readFileSync(join(root, 'guard.config.json'), 'utf8'));
    expect(gc.scanRoots).toEqual(['custom/src']); // preserved
    expect(gc.fanoutCap).toBe(99); // preserved
    expect(gc.structure.trees.map((t) => t.name)).toEqual(['components', 'pages']); // added
    // Line caps are NOT template-merged (they need a grandfather freeze) — upgrade offers them.
    expect(gc.maxLines).toBeUndefined();
    expect(gc.maxTestLines).toBeUndefined();
  });

  it('plans NOTHING when already on the current shim + full guard.config', () => {
    const root = tmpRepo();
    write(root, 'eslint.config.mjs', shim());
    const tpl = readFileSync(
      join(packageDir(), 'templates', 'react-app', 'guard.config.json'),
      'utf8',
    );
    write(root, 'guard.config.json', tpl);
    expect(computeMigration(root, 'react-app')).toEqual([]);
  });
});

// The electron eslint.config is regenerated wholesale on migrate, but WHICH backends it
// structure-lints lives in guard.config.json `backends` (merge-preserved) — never in the
// regenerated file. So migrate can no longer silently re-disable a consumer's backend
// governance: it preserves an explicit choice, and a consumer missing the key gets the
// both-on default (never both-off). This is the regression guard for that contract.
describe('computeMigration (electron: backend governance survives the eslint regen)', () => {
  it('preserves a consumer’s explicit backends choice — never clobbers it', () => {
    const root = tmpRepo();
    write(root, 'eslint.config.mjs', '// OLD electron preset\nexport default [];\n');
    write(
      root,
      'guard.config.json',
      JSON.stringify({ scanRoots: ['src'], backends: { socketServer: true, vercel: false } }),
    );
    for (const c of computeMigration(root, 'electron')) c.write();
    const gc = JSON.parse(readFileSync(join(root, 'guard.config.json'), 'utf8'));
    expect(gc.backends).toEqual({ socketServer: true, vercel: false }); // preserved, not reset
  });

  it('adds backends with the both-on default when an electron consumer lacks the key', () => {
    const root = tmpRepo();
    write(root, 'eslint.config.mjs', '// OLD\n');
    write(root, 'guard.config.json', JSON.stringify({ scanRoots: ['src'], fanoutCap: 12 }));
    for (const c of computeMigration(root, 'electron')) c.write();
    const gc = JSON.parse(readFileSync(join(root, 'guard.config.json'), 'utf8'));
    expect(gc.backends).toEqual({ socketServer: true, vercel: true }); // default, never both-off
    expect(gc['//backends']).toBeDefined(); // the explanatory comment sibling rides along
  });
});

// sc-1962. eslintChange compares the consumer's file to the template BYTE-FOR-BYTE, and the
// devkit-managed consumer pre-commit hook formats staged files. So a template that is not already
// formatter-canonical is unreconcilable: upgrade writes the template bytes, the hook rewrites them,
// and the next `upgrade --dry-run` proposes the same [replace] forever. The templates must therefore
// be a FIXED POINT of the formatting contract. package.json's format:check globs enforce this in CI;
// this test enforces it independently, so dropping the glob (or re-adding a blanket `templates`
// ignore) can't silently reopen the drift.
describe('emitted templates are formatter-canonical (upgrade idempotence)', () => {
  it('leaves every shipped .mjs template unchanged under devkit’s pinned Oxfmt', () => {
    const { binPath } = resolveOxcRuntime('fmt');
    const result = spawnSync(process.execPath, [binPath, '--check', 'templates/**/*.mjs'], {
      cwd: packageDir(),
      encoding: 'utf8',
    });
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/Format issues found/);
    expect(result.status).toBe(0);
  });

  // A passing --check proves nothing about the files the glob never selected, so pin the count
  // against the tree: a pattern that silently stops matching (e.g. the dot-directory template)
  // would otherwise leave a template free to rot while this suite stayed green.
  it('selects every .mjs template on disk, so a narrowed glob cannot silently under-cover', () => {
    const onDisk = readdirSync(join(packageDir(), 'templates'), { recursive: true })
      .map(String)
      .filter((f) => f.endsWith('.mjs'));
    expect(onDisk.length).toBeGreaterThan(0);

    const { binPath } = resolveOxcRuntime('fmt');
    const result = spawnSync(process.execPath, [binPath, '--check', 'templates/**/*.mjs'], {
      cwd: packageDir(),
      encoding: 'utf8',
    });
    expect(result.stdout).toContain(`on ${onDisk.length} files`);
  });

  // guardConfigChange merges by reading the templates' `//`-prefixed comment keys, which a JSON
  // formatter pass would reflow or drop. Narrowing the ignore from a blanket `templates` is exactly
  // the edit that could expose them, so assert Oxfmt still refuses every JSON template.
  it('still excludes the JSON templates whose //-comment keys guardConfigChange reads', () => {
    const { binPath } = resolveOxcRuntime('fmt');
    const result = spawnSync(
      process.execPath,
      [binPath, '--check', 'templates/**/*.json', 'templates/**/*.jsonc'],
      { cwd: packageDir(), encoding: 'utf8' },
    );
    expect(`${result.stdout}${result.stderr}`).toMatch(/excluded by ignore rules/);

    const raw = readFileSync(
      join(packageDir(), 'templates', 'electron', 'guard.config.json'),
      'utf8',
    );
    expect(raw).toMatch(/^\s*"\/\/\w/m);
  });

  // The canonical form only stops the drift while devkit's own formatter and the Biome preset it
  // still ships to consumers agree. Nothing else couples them: raising biome/base's lineWidth
  // without .oxfmtrc.json would make every consumer's hook rewrite the template again.
  it('keeps devkit’s Oxfmt contract and the shipped consumer Biome preset in agreement', () => {
    const oxfmt = readJson<OxfmtContract>(join(packageDir(), '.oxfmtrc.json'));
    // SAFETY: biome/base.jsonc is devkit's own committed preset, and the two field accesses below
    // are the only ones read — a missing key surfaces as an undefined mismatch, failing this test.
    const biome = JSON.parse(
      readFileSync(join(packageDir(), 'biome', 'base.jsonc'), 'utf8')
        .split('\n')
        .filter((l) => !l.trimStart().startsWith('//'))
        .join('\n'),
    ) as BiomePreset;
    const fmt = biome.formatter;
    const js = biome.javascript.formatter;

    expect(oxfmt?.printWidth).toBe(fmt.lineWidth);
    expect(oxfmt?.tabWidth).toBe(fmt.indentWidth);
    expect(oxfmt?.useTabs).toBe(fmt.indentStyle === 'tab');
    expect(oxfmt?.bracketSpacing).toBe(fmt.bracketSpacing);
    expect(oxfmt?.singleQuote).toBe(js.quoteStyle === 'single');
    expect(oxfmt?.jsxSingleQuote).toBe(js.jsxQuoteStyle === 'single');
    expect(oxfmt?.semi).toBe(js.semicolons === 'always');
    expect(oxfmt?.arrowParens).toBe(js.arrowParentheses);
    expect(oxfmt?.bracketSameLine).toBe(js.bracketSameLine);
    expect(oxfmt?.quoteProps).toBe('as-needed');
    expect(js.quoteProperties).toBe('asNeeded');
  });
});

// The flip side of the same contract: tolerating a FORMATTING difference must never grow into
// tolerating a CONTENT difference. eslint.config.mjs stays devkit-owned and full-replaceable
// (docs/decisions/electron-backends-toggle-externalised.md), so a real hand-edit is still reported.
describe('computeMigration (devkit-owned eslint.config stays full-replaceable)', () => {
  it('still plans a REPLACE when the consumer semantically hand-edits the emitted config', () => {
    const root = tmpRepo();
    write(
      root,
      'eslint.config.mjs',
      shim().replace('export default', 'export const hand = 1;\nexport default'),
    );
    write(root, 'guard.config.json', JSON.stringify({ scanRoots: ['src'] }));
    const byFile = Object.fromEntries(computeMigration(root, 'react-app').map((c) => [c.file, c]));
    expect(byFile['eslint.config.mjs'].kind).toBe('replace');
    byFile['eslint.config.mjs'].write();
    expect(readFileSync(join(root, 'eslint.config.mjs'), 'utf8')).toBe(shim()); // devkit wins
  });
});
