import {
  copyFileSync,
  existsSync,
  readFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testSpawnSync as spawnSync } from './_helpers.mts';

const DEVKIT_ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '../..'));
const WALL_RULE = 'project-structure/independent-modules';
const BUILTIN_RULE = 'no-restricted-imports';
const FILE_SIZE_RULE = 'max-lines';
const FUNCTION_SIZE_RULE = 'max-lines-per-function';
const GRANDFATHERED = 'src/renderer/lib/tasks/grandfathered-main.ts';
const FILE_SIZE_PROBE = 'src/main/comment-sized-file.ts';
const FUNCTION_SIZE_PROBE = 'src/main/comment-sized-function.ts';
const BLANK_FILE_SIZE_PROBE = 'src/main/blank-sized-file.ts';
const MIXED_FUNCTION_SIZE_PROBE = 'src/main/mixed-sized-function.ts';
const COMMENT_PARAGRAPH = [
  '// The wire format invariant needs a durable explanation here.',
  '// The comment firewall reviews this paragraph independently.',
  '// Its lines must not consume executable-code size budget.',
];

const PROBES = {
  'src/renderer/lib/tasks/import-main.ts': "import '../../../main/index';\nexport {};\n",
  'src/renderer/lib/tasks/import-main-type.ts':
    "import type { AppRouter } from '../../../main/lib/trpc/routers';\nexport type X = AppRouter;\n",
  'src/renderer/lib/tasks/import-main-alias-escape.ts': "import '@/../main/index';\nexport {};\n",
  'src/renderer/features/terminal/import-feature-deep.ts':
    "import '@/features/agents/atoms';\nexport {};\n",
  'src/renderer/features/terminal/import-feature-barrel.ts':
    "import '@/features/changes';\nexport {};\n",
  'src/renderer/features/agents/import-own-feature.ts':
    "import '@/features/agents/atoms';\nexport {};\n",
  'src/renderer/lib/tasks/import-frozen-dir.ts': "import '@/utils/source-filter';\nexport {};\n",
  'src/renderer/utils/import-frozen-sibling.ts': "import './source-filter';\nexport {};\n",
  'src/renderer/components/import-component.ts': "import '@/components/ui/button';\nexport {};\n",
  'src/renderer/lib/tasks/import-worker.ts': "import './worker-target?worker';\nexport {};\n",
  'src/renderer/lib/tasks/import-unresolved.ts': "import './does-not-exist';\nexport {};\n",
  'src/shared/import-main.ts': "import '../main/index';\nexport {};\n",
  'src/shared/import-sibling.ts': "import './detect-language';\nexport {};\n",
  'src/renderer/lib/tasks/import-node-builtin.ts':
    "import path from 'node:path';\nexport const x = path;\n",
  'src/renderer/lib/tasks/import-browser-path.ts':
    "import path from 'path';\nexport const x = path;\n",
  [GRANDFATHERED]: "import '../../../main/index';\nexport {};\n",
  [FILE_SIZE_PROBE]: `${[
    ...Array.from({ length: 498 }, (_, index) => `export const value${index} = ${index};`),
    ...COMMENT_PARAGRAPH,
  ].join('\n')}\n`,
  [FUNCTION_SIZE_PROBE]: `${[
    'export function documentedOperation() {',
    ...Array.from({ length: 197 }, () => '  void 0;'),
    ...COMMENT_PARAGRAPH.map((line) => `  ${line}`),
    '}',
  ].join('\n')}\n`,
  [BLANK_FILE_SIZE_PROBE]: `${[
    ...Array.from({ length: 499 }, (_, index) => `export const blankValue${index} = ${index};`),
    '',
    'export const finalBlankValue = true;',
  ].join('\n')}\n`,
  [MIXED_FUNCTION_SIZE_PROBE]: `${[
    'export function mixedCommentOperation() {',
    ...Array.from({ length: 199 }, () => '  void 0; // explanatory suffix'),
    '}',
  ].join('\n')}\n`,
  'src/renderer/lib/trpc.ts':
    "import type { AppRouter } from '../../main/lib/trpc/routers';\nexport type Router = AppRouter;\n",
};

function write(root: string, relativePath: string, content = 'export {};\n') {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function removeTree(path: string, protectedRoot = DEVKIT_ROOT) {
  if (path === protectedRoot) throw new Error(`refusing to remove the protected root: ${path}`);
  rmSync(path, { recursive: true, force: true });
}

function writeTestConfig(repoRoot: string, root: string) {
  write(root, 'package.json', '{"type":"module"}\n');
  write(
    root,
    'guard.config.json',
    JSON.stringify({ scanRoots: ['src'], backends: { socketServer: false, vercel: false } }),
  );
  const configPath = join(root, 'eslint.config.mjs');
  copyFileSync(join(DEVKIT_ROOT, 'templates/electron/eslint.config.mjs'), configPath);
  const config = readFileSync(configPath, 'utf8');
  const fixtureBase = relative(repoRoot, root).replaceAll('\\', '/');
  const isolatedConfig = config.replace(
    "pathAliases: { baseUrl: '.',",
    `pathAliases: { baseUrl: '${fixtureBase}',`,
  );
  if (isolatedConfig === config) throw new Error('Electron template path-alias anchor changed');
  writeFileSync(configPath, isolatedConfig);
  mkdirSync(join(root, 'eslint'), { recursive: true });
  copyFileSync(
    join(DEVKIT_ROOT, 'templates/electron/eslint/domains.mjs'),
    join(root, 'eslint/domains.mjs'),
  );
  mkdirSync(join(root, '.devkit/structure'), { recursive: true });
  write(
    root,
    '.devkit/structure/exempt.mjs',
    `export const rendererStructureExempt = [];
export const mainStructureExempt = [];
export const importWallExempt = [{ name: 'app-router', pattern: 'src/renderer/lib/trpc.ts', allowImportsFrom: ['{renderer_base}', 'src/main/lib/trpc/routers/**'] }];
`,
  );
  write(
    root,
    '.devkit/baselines/imports.mjs',
    `export const rendererImportWallBaseline = [{ name: 'grandfathered', pattern: '${GRANDFATHERED}', allowImportsFrom: ['{renderer_base}', 'src/main/**'] }];\n`,
  );
}

function writeTargetSources(root: string) {
  for (const target of [
    'src/main/index.ts',
    'src/main/lib/trpc/routers/index.ts',
    'src/renderer/features/agents/atoms.ts',
    'src/renderer/features/changes/index.ts',
    'src/renderer/utils/source-filter.ts',
    'src/renderer/components/ui/button.ts',
    'src/renderer/lib/tasks/worker-target.ts',
    'src/shared/detect-language.ts',
  ]) {
    write(root, target);
  }
  for (const [relativePath, content] of Object.entries(PROBES)) write(root, relativePath, content);
}

function collectRuleErrors(repoRoot: string, root: string) {
  const result = spawnSync(
    process.execPath,
    [
      '--preserve-symlinks',
      join(repoRoot, 'node_modules', 'eslint', 'bin', 'eslint.js'),
      '--config',
      join(root, 'eslint.config.mjs'),
      '--format',
      'json',
      ...Object.keys(PROBES),
    ],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (!result.stdout) {
    throw new Error(`Electron import-wall fixture produced no ESLint JSON:\n${result.stderr}`);
  }
  const byFile = new Map(
    JSON.parse(result.stdout).map((file) => [
      relative(root, file.filePath).replaceAll('\\', '/'),
      file.messages ?? [],
    ]),
  );
  const unreported = Object.keys(PROBES).filter((relativePath) => !byFile.has(relativePath));
  if (unreported.length) {
    throw new Error(
      `Electron import-wall fixture: ESLint never reported on ${unreported.length} probe(s), so ` +
        `their zero-error expectations prove nothing: ${unreported.join(', ')}`,
    );
  }
  const count = (relativePath: string, ruleId: string) =>
    (byFile.get(relativePath) ?? []).filter((message) => message.ruleId === ruleId).length;
  const wallErrors = new Map(
    Object.keys(PROBES).map((relativePath) => [relativePath, count(relativePath, WALL_RULE)]),
  );
  const builtinErrors = new Map(
    Object.keys(PROBES).map((relativePath) => [relativePath, count(relativePath, BUILTIN_RULE)]),
  );
  if ([...wallErrors.values()].reduce((total, errors) => total + errors, 0) === 0) {
    throw new Error(
      `Electron import-wall fixture (sc-1991): ${WALL_RULE} reported nothing on ANY probe, so the wall never ran. ` +
        'The structure plugin resolved a project root outside this fixture -- typically a symlinked ' +
        'node_modules realpath-escaping to the owning checkout. Spawn eslint the way ' +
        'gate-engine/structure/run.mts does (--preserve-symlinks, bin resolved from the repo under test).',
    );
  }
  const fileSizeErrors = new Map(
    Object.keys(PROBES).map((relativePath) => [relativePath, count(relativePath, FILE_SIZE_RULE)]),
  );
  const functionSizeErrors = new Map(
    Object.keys(PROBES).map((relativePath) => [
      relativePath,
      count(relativePath, FUNCTION_SIZE_RULE),
    ]),
  );
  return { wallErrors, builtinErrors, fileSizeErrors, functionSizeErrors };
}

function removeLinkedRepoRoot(repoRoot: string) {
  const link = join(repoRoot, 'node_modules');
  if (lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) rmSync(link, { force: true });
  removeTree(repoRoot);
}

const ENVIRONMENTS = [
  {
    name: 'a real checkout',
    createRepoRoot: () => DEVKIT_ROOT,
    removeRepoRoot: (_repoRoot: string) => {},
  },
  {
    name: 'a worktree whose node_modules is a symlink',
    createRepoRoot: () => {
      const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'electron-import-walls-linked-')));
      try {
        const link = join(repoRoot, 'node_modules');
        symlinkSync(join(DEVKIT_ROOT, 'node_modules'), link, 'dir');
        if (!lstatSync(link).isSymbolicLink()) {
          throw new Error(
            `linked environment produced a real node_modules, not a symlink: ${link}`,
          );
        }
      } catch (error) {
        removeLinkedRepoRoot(repoRoot);
        throw error;
      }
      return repoRoot;
    },
    removeRepoRoot: removeLinkedRepoRoot,
  },
];

describe.each(ENVIRONMENTS)(
  'shipped Electron import walls in $name',
  ({ createRepoRoot, removeRepoRoot }) => {
    let repoRoot = '';
    let root = '';
    let wallErrors: Map<string, number>;
    let builtinErrors: Map<string, number>;
    let fileSizeErrors: Map<string, number>;
    let functionSizeErrors: Map<string, number>;

    beforeAll(() => {
      repoRoot = createRepoRoot();
      root = realpathSync(mkdtempSync(join(repoRoot, '.electron-import-walls-')));
      writeTestConfig(repoRoot, root);
      writeTargetSources(root);
      ({ wallErrors, builtinErrors, fileSizeErrors, functionSizeErrors } = collectRuleErrors(
        repoRoot,
        root,
      ));
    }, 120_000);

    afterAll(() => {
      if (root) removeTree(root);
      if (repoRoot) removeRepoRoot(repoRoot);
    });

    it.each([
      'src/renderer/lib/tasks/import-main.ts',
      'src/renderer/lib/tasks/import-main-type.ts',
      'src/renderer/lib/tasks/import-main-alias-escape.ts',
    ])('blocks renderer trust-boundary escape: %s', (relativePath) => {
      expect(wallErrors.get(relativePath)).toBeGreaterThan(0);
    });

    it('keeps the permanent AppRouter exception ahead of the renderer wall', () => {
      expect(wallErrors.get('src/renderer/lib/trpc.ts')).toBe(0);
    });

    it('keeps a generated grandfather entry ahead of the renderer wall', () => {
      expect(wallErrors.get(GRANDFATHERED)).toBe(0);
    });

    it('blocks another feature deep path but allows its barrel and the current feature', () => {
      expect(
        wallErrors.get('src/renderer/features/terminal/import-feature-deep.ts'),
      ).toBeGreaterThan(0);
      expect(wallErrors.get('src/renderer/features/terminal/import-feature-barrel.ts')).toBe(0);
      expect(wallErrors.get('src/renderer/features/agents/import-own-feature.ts')).toBe(0);
    });

    it('blocks frozen-directory consumption, including a fresh sibling import', () => {
      expect(wallErrors.get('src/renderer/lib/tasks/import-frozen-dir.ts')).toBeGreaterThan(0);
      expect(wallErrors.get('src/renderer/utils/import-frozen-sibling.ts')).toBeGreaterThan(0);
    });

    it('allows the renderer base surface and bundler virtual imports', () => {
      expect(wallErrors.get('src/renderer/components/import-component.ts')).toBe(0);
      expect(wallErrors.get('src/renderer/lib/tasks/import-worker.ts')).toBe(0);
    });

    it('reports an unresolvable local import instead of silently allowing it', () => {
      expect(wallErrors.get('src/renderer/lib/tasks/import-unresolved.ts')).toBeGreaterThan(0);
    });

    it('blocks shared imports upward but allows shared siblings', () => {
      expect(wallErrors.get('src/shared/import-main.ts')).toBeGreaterThan(0);
      expect(wallErrors.get('src/shared/import-sibling.ts')).toBe(0);
    });

    it('blocks node: builtins while preserving the browser-aliased bare path import', () => {
      expect(builtinErrors.get('src/renderer/lib/tasks/import-node-builtin.ts')).toBeGreaterThan(0);
      expect(builtinErrors.get('src/renderer/lib/tasks/import-browser-path.ts')).toBe(0);
    });

    it('does not charge comment-only paragraphs to file or function budgets', () => {
      expect(fileSizeErrors.get(FILE_SIZE_PROBE)).toBe(0);
      expect(functionSizeErrors.get(FUNCTION_SIZE_PROBE)).toBe(0);
    });

    it('still charges blank lines and mixed code/comment lines to the ESLint budgets', () => {
      expect(fileSizeErrors.get(BLANK_FILE_SIZE_PROBE)).toBeGreaterThan(0);
      expect(functionSizeErrors.get(MIXED_FUNCTION_SIZE_PROBE)).toBeGreaterThan(0);
    });
  },
);

describe('import-wall fixture teardown', () => {
  it('unlinks a node_modules symlink without touching what it points at', () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'electron-import-walls-teardown-')));
    const target = join(scratch, 'target-node-modules');
    const repoRoot = join(scratch, 'repo');
    mkdirSync(repoRoot, { recursive: true });
    write(target, 'eslint/bin/eslint.js', 'export {};\n');
    symlinkSync(target, join(repoRoot, 'node_modules'), 'dir');

    removeLinkedRepoRoot(repoRoot);

    expect(existsSync(repoRoot)).toBe(false);
    expect(existsSync(join(target, 'eslint/bin/eslint.js'))).toBe(true);
    removeTree(scratch);
  });

  it('refuses to remove the protected root instead of deleting the checkout', () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'electron-import-walls-protected-')));
    write(scratch, 'sentinel.txt', 'keep me\n');

    expect(() => removeTree(scratch, scratch)).toThrow(/refusing to remove the protected root/);

    expect(existsSync(join(scratch, 'sentinel.txt'))).toBe(true);
    rmSync(scratch, { recursive: true, force: true });
  });
});
