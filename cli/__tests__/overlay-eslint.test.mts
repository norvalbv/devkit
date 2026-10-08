import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ESLint } from 'eslint';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ESLINT_OVERLAY_FILE,
  eslintOverlayContent,
  isLegacyEslintOverlay,
  legacyEslintOverlayContent,
  writeBiomeOverlay,
  writeEslintOverlay,
} from '../lib/install/overlay-lint-configs.mts';
import { rootRegistry, testSpawnSync as spawnSync } from './_helpers.mts';

// sc-3791: the overlay eslint layer must never lint a file the repo's own config would not, and
// never weaken a repo rule. Every lint here runs the REAL eslint over the emitted overlay config.

const { mkTmp, cleanup } = rootRegistry();
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

const ESLINT_BIN = join(process.cwd(), 'node_modules', '.bin', 'eslint');

// A consumer repo: its own flat config (source text), plus files, plus the overlay config.
function fixture(repoConfig: string, files: Record<string, string>, repo = 'eslint.config.mjs') {
  const root = mkTmp('overlay-eslint-');
  writeFileSync(join(root, repo), repoConfig);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  writeFileSync(join(root, ESLINT_OVERLAY_FILE), eslintOverlayContent(repo));
  return root;
}

// A function spanning exactly `lines` lines (header + body + closing brace).
const fn = (lines: number, name = 'f') =>
  `export function ${name}() {\n${'  void 0;\n'.repeat(lines - 2)}}\n`;

async function lint(root: string, files: string[], config = ESLINT_OVERLAY_FILE) {
  const eslint = new ESLint({ cwd: root, overrideConfigFile: join(root, config) });
  const results = await eslint.lintFiles(files);
  return results.flatMap((r) => r.messages.map((m) => ({ file: r.filePath, ...m })));
}
const errorsFor = (msgs: Awaited<ReturnType<typeof lint>>, rule?: string) =>
  msgs.filter((m) => (m.severity === 2 || m.fatal) && (rule === undefined || m.ruleId === rule));

const TS_ONLY = 'const n: number = 1;\nexport type T = { a: string };\nexport default n;\n';

describe('overlay eslint config — linted set', () => {
  it('never parses a .ts file the repo config leaves unmatched (the scripts/**/*.ts parse error)', async () => {
    const root = fixture("export default [{ files: ['src/**/*.js'], rules: {} }];\n", {
      'scripts/build.ts': TS_ONLY,
    });
    expect(errorsFor(await lint(root, ['scripts/build.ts']))).toEqual([]);

    // Control: the legacy appended-`files` overlay DID pull it in and die parsing it.
    writeFileSync(join(root, 'legacy.mjs'), legacyEslintOverlayContent('eslint.config.mjs'));
    const legacy = errorsFor(await lint(root, ['scripts/build.ts'], 'legacy.mjs'));
    expect(legacy.some((m) => m.fatal && /Parsing error/.test(m.message))).toBe(true);
  });

  it("caps only the repo's scoped files, not JS that ESLint's defaults match outside them", async () => {
    const root = fixture("export default [{ files: ['src/**/*.js'], rules: {} }];\n", {
      'src/big.js': fn(320),
      'scripts/big.js': fn(320),
    });
    const errs = errorsFor(await lint(root, ['src/big.js', 'scripts/big.js']));
    expect(errs.map((m) => [m.file.endsWith('src/big.js'), m.ruleId])).toEqual([
      [true, 'max-lines-per-function'],
    ]);
  });

  it("keeps the repo's global ignores in force (prepended caps never un-ignore a file)", async () => {
    const root = fixture("export default [{ ignores: ['dist/**'] }, { rules: {} }];\n", {
      'dist/big.js': fn(400),
    });
    expect(errorsFor(await lint(root, ['dist/big.js']))).toEqual([]);
  });

  it('the hook command exits 0 when a staged path is outside the repo config (it only warns)', () => {
    const root = fixture("export default [{ files: ['src/**/*.js'], rules: {} }];\n", {
      'scripts/build.ts': TS_ONLY,
      'src/ok.js': 'export const ok = 1;\n',
    });
    const r = spawnSync(ESLINT_BIN, ['-c', ESLINT_OVERLAY_FILE, 'scripts/build.ts', 'src/ok.js'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/Parsing error/);
  });

  it('a staged root setup file with TS syntax passes when the repo config covers only src/', () => {
    const root = fixture("export default [{ files: ['src/**/*.js'], rules: {} }];\n", {
      'vitest.setup.ts':
        'const store = new Map<string, string>();\nexport const get = (key: string) => store.get(key);\n',
    });
    const r = spawnSync(ESLINT_BIN, ['-c', ESLINT_OVERLAY_FILE, 'vitest.setup.ts'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/Parsing error/);
  });
});

describe('overlay eslint config — never weakens a repo rule', () => {
  it('a stricter repo max-lines-per-function stays enforced', async () => {
    const root = fixture(
      "export default [{ rules: { 'max-lines-per-function': ['error', { max: 5 }] } }];\n",
      { 'src/a.js': fn(10) },
    );
    expect(errorsFor(await lint(root, ['src/a.js']), 'max-lines-per-function')).toHaveLength(1);
  });

  it("a severity-only repo rule keeps eslint's default (50), not devkit's 300", async () => {
    const root = fixture("export default [{ rules: { 'max-lines-per-function': 'error' } }];\n", {
      'src/a.js': fn(61),
    });
    expect(errorsFor(await lint(root, ['src/a.js']), 'max-lines-per-function')).toHaveLength(1);
  });

  it("a repo that turns a rule 'off' is not overridden by devkit's cap", async () => {
    const root = fixture("export default [{ rules: { 'max-lines-per-function': 'off' } }];\n", {
      'src/a.js': fn(320),
    });
    expect(errorsFor(await lint(root, ['src/a.js']))).toEqual([]);
  });

  it('a repo rule scoped to a narrow glob disables that cap everywhere (errs toward the repo)', async () => {
    const root = fixture(
      "export default [{ files: ['src/**/*.js'], rules: { 'max-lines-per-function': ['error', { max: 400 }] } }, { files: ['lib/**/*.js'] }];\n",
      { 'src/a.js': fn(320), 'lib/b.js': fn(320) },
    );
    expect(errorsFor(await lint(root, ['src/a.js', 'lib/b.js']))).toEqual([]);
  });

  it('caps the rule the repo leaves unset while deferring on the one it sets', async () => {
    const root = fixture(
      "export default [{ rules: { 'max-lines': ['error', { max: 1000 }] } }];\n",
      {
        'src/a.js': fn(320),
      },
    );
    const errs = errorsFor(await lint(root, ['src/a.js']));
    expect(errs.map((m) => m.ruleId)).toEqual(['max-lines-per-function']);
  });
});

describe("overlay eslint config — devkit's caps where the repo sets none", () => {
  it('fires at 301 lines per function, passes at 300 (boundary)', async () => {
    const root = fixture('export default [{ rules: {} }];\n', {
      'src/over.js': fn(301),
      'src/at.js': fn(300),
    });
    const errs = errorsFor(
      await lint(root, ['src/over.js', 'src/at.js']),
      'max-lines-per-function',
    );
    expect(errs.map((m) => m.file)).toEqual([join(root, 'src/over.js')]);
  });

  it('exempts test/spec files from the caps, module-format extensions included', async () => {
    const files = ['src/a.test.js', 'src/b.test.mjs', 'src/c.spec.cjs'];
    const root = fixture(
      "export default [{ files: ['**/*.{js,mjs,cjs}'], rules: {} }];\n",
      Object.fromEntries(files.map((f) => [f, fn(320).replace('export ', '')])),
    );
    expect(errorsFor(await lint(root, files))).toEqual([]);
  });

  it('accepts a repo config exported as a Promise, a single object, or from eslint.config.js', async () => {
    const repoConfigs: Array<[string, string]> = [
      ['export default Promise.resolve([{ rules: {} }]);\n', 'eslint.config.mjs'],
      ['export default { rules: {} };\n', 'eslint.config.mjs'],
      ['export default [{ rules: {} }];\n', 'eslint.config.js'],
    ];
    for (const [text, repo] of repoConfigs) {
      const root = fixture(text, { 'src/a.js': fn(301) }, repo);
      expect(errorsFor(await lint(root, ['src/a.js'])).map((m) => m.ruleId)).toEqual([
        'max-lines-per-function',
      ]);
    }
  });
});

describe('overlay eslint config — real consumer config shapes', () => {
  const TS_PARSER = JSON.stringify(
    join(process.cwd(), 'node_modules/@typescript-eslint/parser/dist/index.js'),
  );

  it('caps a .ts file the repo lints with a TS parser, and leaves an unconfigured root .ts alone', async () => {
    const root = fixture(
      `import tsParser from ${TS_PARSER};\nexport default [{ files: ['src/**/*.ts'], languageOptions: { parser: tsParser } }];\n`,
      {
        'src/big.ts': `export function f(): void {\n${'  const n: number = 1; void n;\n'.repeat(299)}}\n`,
        'vitest.setup.ts': 'export const m = new Map<string, string>();\n',
      },
    );
    const msgs = await lint(root, ['src/big.ts', 'vitest.setup.ts']);
    expect(errorsFor(msgs).map((m) => [m.file.endsWith('big.ts'), m.ruleId])).toEqual([
      [true, 'max-lines-per-function'],
    ]);
  });

  it("keeps a scoped repo object's own ignores: an excluded generated .ts is never parsed or capped", async () => {
    const root = fixture(
      `import tsParser from ${TS_PARSER};\nexport default [{ files: ['src/**/*.ts'], ignores: ['src/generated/**'], languageOptions: { parser: tsParser } }];\n`,
      {
        'src/big.ts': `export function f(): void {\n${'  const n: number = 1; void n;\n'.repeat(299)}}\n`,
        'src/generated/big.ts': `export function g(): void {\n${'  const n: number = 1; void n;\n'.repeat(299)}}\n`,
      },
    );
    const errs = errorsFor(await lint(root, ['src/big.ts', 'src/generated/big.ts']));
    expect(errs.map((m) => [m.file.endsWith('src/big.ts'), m.ruleId])).toEqual([
      [true, 'max-lines-per-function'],
    ]);
  });

  it("honours a scoped repo object's basePath (caps the package tree, not the root's)", async () => {
    const root = fixture(
      "export default [{ basePath: 'packages/app', files: ['src/**/*.js'] }];\n",
      {
        'packages/app/src/big.js': fn(320),
        'src/big.js': fn(320),
      },
    );
    const errs = errorsFor(await lint(root, ['packages/app/src/big.js', 'src/big.js']));
    expect(errs.map((m) => [m.file.includes('packages/app'), m.ruleId])).toEqual([
      [true, 'max-lines-per-function'],
    ]);
  });

  it('keeps the caps for an empty, {} or name-only repo config (none of them are ignores-only)', async () => {
    for (const text of [
      'export default [];\n',
      'export default [{}];\n',
      "export default [{ name: 'base' }];\n",
    ]) {
      const root = fixture(text, { 'src/a.js': fn(301) });
      expect(errorsFor(await lint(root, ['src/a.js'])).map((m) => m.ruleId)).toEqual([
        'max-lines-per-function',
      ]);
    }
  });

  it('extends a CommonJS eslint.config.js (module.exports)', async () => {
    const root = fixture(
      'module.exports = [{ rules: {} }];\n',
      { 'src/a.js': fn(301) },
      'eslint.config.js',
    );
    writeFileSync(join(root, 'package.json'), '{"type":"commonjs"}\n');
    expect(errorsFor(await lint(root, ['src/a.js'])).map((m) => m.ruleId)).toEqual([
      'max-lines-per-function',
    ]);
  });
});

describe('writeEslintOverlay — never overwrites unattended', () => {
  const repoWith = (repo = 'eslint.config.mjs') => {
    const root = mkTmp('overlay-eslint-write-');
    writeFileSync(join(root, repo), 'export default [];\n');
    return root;
  };
  const read = (root: string) => readFileSync(join(root, ESLINT_OVERLAY_FILE), 'utf8');

  it('names the remedy for an outdated devkit overlay and keeps it; deleting it refreshes (both names)', () => {
    for (const repo of ['eslint.config.mjs', 'eslint.config.js']) {
      const root = repoWith(repo);
      writeFileSync(join(root, ESLINT_OVERLAY_FILE), legacyEslintOverlayContent(repo));
      expect(writeEslintOverlay(root, false, false)).toBe(true);
      expect(read(root)).toBe(legacyEslintOverlayContent(repo));
      expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain('delete it and re-run');

      rmSync(join(root, ESLINT_OVERLAY_FILE));
      writeEslintOverlay(root, false, false);
      expect(read(root)).toBe(eslintOverlayContent(repo));
    }
  });

  it('a devkit overlay still pointing at a renamed repo config (mjs → js) gets the same remedy', () => {
    const root = repoWith('eslint.config.js');
    const stale = eslintOverlayContent('eslint.config.mjs');
    writeFileSync(join(root, ESLINT_OVERLAY_FILE), stale);
    writeEslintOverlay(root, false, false);
    expect(read(root)).toBe(stale);
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain('delete it and re-run');
  });

  it('an overlay edited from the outdated template names the cause, not --force; --force replaces it', () => {
    const root = repoWith();
    const legacy = legacyEslintOverlayContent('eslint.config.mjs');
    // Hand-edited and reformatted: no longer byte-identical, still the widening caps block.
    const edited = `${legacy.replace("['**/*.{ts,tsx,js,jsx}']", '["**/*.{ts,tsx,js,jsx}"]')}// team tweak\n`;
    expect(isLegacyEslintOverlay(edited)).toBe(true);
    writeFileSync(join(root, ESLINT_OVERLAY_FILE), edited);
    writeEslintOverlay(root, false, false);
    expect(read(root)).toBe(edited);
    const out = vi.mocked(console.log).mock.calls.flat().join('\n');
    expect(out).toContain('derives from an outdated devkit template');
    expect(out).toContain('delete it and re-run (hand edits are lost)');
    expect(out).not.toContain('--force');

    writeEslintOverlay(root, true, false);
    expect(read(root)).toBe(eslintOverlayContent('eslint.config.mjs'));
  });

  it('preserves an overlay edited from the current template and names --force', () => {
    const root = repoWith();
    const edited = `${eslintOverlayContent('eslint.config.mjs')}// team tweak\n`;
    expect(isLegacyEslintOverlay(edited)).toBe(false);
    writeFileSync(join(root, ESLINT_OVERLAY_FILE), edited);
    writeEslintOverlay(root, false, false);
    expect(read(root)).toBe(edited);
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain('--force');
  });

  it('an unreadable overlay path (a dangling link) gets a remedy that actually works', () => {
    const root = repoWith();
    symlinkSync(join(root, 'gone', ESLINT_OVERLAY_FILE), join(root, ESLINT_OVERLAY_FILE));
    expect(writeEslintOverlay(root, false, false)).toBe(true);
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain('delete it and re-run');

    rmSync(join(root, ESLINT_OVERLAY_FILE));
    writeEslintOverlay(root, false, false);
    expect(read(root)).toBe(eslintOverlayContent('eslint.config.mjs'));
  });

  it('dry-run writes nothing and a repo without a flat config gets no overlay', () => {
    const root = repoWith();
    writeFileSync(join(root, ESLINT_OVERLAY_FILE), legacyEslintOverlayContent('eslint.config.mjs'));
    expect(writeEslintOverlay(root, false, true)).toBe(true);
    expect(read(root)).toBe(legacyEslintOverlayContent('eslint.config.mjs'));

    expect(writeEslintOverlay(mkTmp('overlay-eslint-none-'), false, false)).toBe(false);
  });
});

describe('biome overlay — a consumer copy is kept without --force', () => {
  it('keeps an edited biome.devkit.jsonc, and --force replaces it', () => {
    const root = mkTmp('overlay-biome-');
    writeFileSync(join(root, 'biome.jsonc'), '{}\n');
    const dest = join(root, 'biome.devkit.jsonc');
    writeFileSync(dest, 'edited');
    expect(writeBiomeOverlay(root, 'generic', false, false)).toBe(true);
    expect(readFileSync(dest, 'utf8')).toBe('edited');
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain('use --force');

    writeBiomeOverlay(root, 'generic', true, false);
    expect(JSON.parse(readFileSync(dest, 'utf8')).extends).toEqual([
      './biome.jsonc',
      './.devkit/biome/base.jsonc',
    ]);
  });
});
