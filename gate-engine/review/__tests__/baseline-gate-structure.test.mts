import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { eslintOverlayContent } from '../../../cli/lib/install/overlay-lint-configs.mts';
import {
  baseResolveEnv,
  rebaseParentURL,
  resolveFromBase,
} from '../baseline/base-resolve-hook.mts';
import {
  PACKAGED_REVIEW_RUNTIME_ENTRYPOINT,
  PACKAGED_REVIEW_RUNTIME_MODULE_STEMS,
} from '../runtime.mts';

const DEVKIT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const ESLINT = join(DEVKIT, 'node_modules/.bin/eslint');
const PLUGIN = 'eslint-plugin-project-structure';
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const FINAL_ONLY_DEP = 'devkit-final-only-dep';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const STRUCTURE_BLOCK = `{
  files: ['src/**/*.ts'],
  languageOptions: { parser: projectStructureParser },
  plugins: { 'project-structure': projectStructurePlugin },
  rules: {
    'project-structure/folder-structure': ['error', createFolderStructure({
      structure: [{ name: 'src', children: [{ name: '{PascalCase}.ts' }] }, { name: '*' }],
    })],
  },
}`;
const NAMES = 'createFolderStructure, projectStructureParser, projectStructurePlugin';

interface RepoConfig {
  name: string;
  body: string;
}
const esmConfig = (extra: string): RepoConfig => ({
  name: 'eslint.config.mjs',
  body: `${extra}import { ${NAMES} } from '${PLUGIN}';\nexport default [${STRUCTURE_BLOCK}];\n`,
});
const ESM_CONFIG = esmConfig('');
const FINAL_ONLY_DEP_CONFIG = esmConfig(`import '${FINAL_ONLY_DEP}';\n`);
const CJS_CONFIG: RepoConfig = {
  name: 'eslint.config.js',
  body: `const { ${NAMES} } = require('${PLUGIN}');\nmodule.exports = [${STRUCTURE_BLOCK}];\n`,
};

// Each review worktree owns a private node_modules copy, so the plugin roots at that worktree.
function installPlugin(worktree: string) {
  const modules = join(worktree, 'node_modules');
  cpSync(join(DEVKIT, 'node_modules', PLUGIN), join(modules, PLUGIN), { recursive: true });
  const pkg = JSON.parse(readFileSync(join(modules, PLUGIN, 'package.json'), 'utf8'));
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    mkdirSync(dirname(join(modules, dep)), { recursive: true });
    symlinkSync(join(DEVKIT, 'node_modules', dep), join(modules, dep), 'dir');
  }
}

function installFinalOnlyDep(worktree: string) {
  const dir = join(worktree, 'node_modules', FINAL_ONLY_DEP);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: FINAL_ONLY_DEP, type: 'module', exports: './index.js' }),
  );
  writeFileSync(join(dir, 'index.js'), 'export {};\n');
}

// Review runs a frozen copy of the runtime modules from under TMPDIR, whose path may hold spaces.
function frozenRuntime(parent: string): string {
  const dir = join(parent, 'frozen runtime');
  for (const stem of PACKAGED_REVIEW_RUNTIME_MODULE_STEMS) {
    mkdirSync(dirname(join(dir, stem)), { recursive: true });
    cpSync(join(DEVKIT, `${stem}.mts`), join(dir, `${stem}.mts`));
  }
  return join(dir, `${PACKAGED_REVIEW_RUNTIME_ENTRYPOINT}.mts`);
}

function writeFiles(root: string, files: Record<string, string>) {
  for (const [path, body] of Object.entries(files)) writeFileSync(join(root, path), body);
}

function reviewEslint(finalFiles: Record<string, string>, config = ESM_CONFIG) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'devkit baseline-structure-')));
  roots.push(parent);
  const root = join(parent, 'repo');
  mkdirSync(join(root, 'src'), { recursive: true });
  const git = (cwd: string, args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@test.invalid', '-c', 'user.name=t', ...args], {
      cwd,
      env: { ...process.env, ...GIT_ENV },
    });
  git(root, ['init', '-q', '-b', 'main']);
  writeFileSync(join(root, config.name), config.body);
  writeFileSync(join(root, 'eslint.config.devkit.mjs'), eslintOverlayContent(config.name));
  writeFileSync(join(root, 'src/Ok.ts'), 'export const ok = 1;\n');
  writeFileSync(join(root, 'src/bad-name.ts'), 'export const bad = 1;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'base']);
  const base = join(parent, 'base');
  const final = join(parent, 'final');
  git(root, ['worktree', 'add', '-q', '--detach', base, 'main']);
  git(root, ['worktree', 'add', '-q', '-b', 'feature', final, 'main']);
  installPlugin(base);
  installPlugin(final);
  installFinalOnlyDep(final);
  writeFiles(final, finalFiles);
  git(final, ['add', ...Object.keys(finalFiles)]);
  const runtime = join(parent, 'runtime');
  const script = frozenRuntime(parent);
  execFileSync(process.execPath, [script, 'capture', base, final, runtime]);
  return spawnSync(process.execPath, [script, 'eslint', runtime], {
    cwd: final,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV, DEVKIT_REVIEW_ESLINT_BIN: ESLINT },
  });
}

const TOUCH_INHERITED = { 'src/bad-name.ts': 'export const bad = 2;\n' };

describe('review eslint baseline with a plugin rooted at its own install', () => {
  it('counts an inherited folder-structure violation in a touched file as inherited', () => {
    const result = reviewEslint(TOUCH_INHERITED);
    expect(result.stderr).not.toContain('new error');
    expect(result.stdout).toContain('no new errors (1 inherited)');
    expect(result.status).toBe(0);
  });

  it('still reports a violation the branch introduces', () => {
    const result = reviewEslint({
      ...TOUCH_INHERITED,
      'src/other-bad.ts': 'export const other = 1;\n',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('1 new error(s)');
    expect(result.stderr).toContain('src/other-bad.ts');
    expect(result.stderr).not.toContain('src/bad-name.ts');
  });

  it('resolves a package only the final tree has from the final tree', () => {
    const result = reviewEslint(TOUCH_INHERITED, FINAL_ONLY_DEP_CONFIG);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('no new errors (1 inherited)');
  });

  it('roots the plugin at the base tree for a CommonJS repo config', () => {
    const result = reviewEslint(TOUCH_INHERITED, CJS_CONFIG);
    expect(result.stdout).toContain('no new errors (1 inherited)');
    expect(result.status).toBe(0);
  });
});

describe('rebaseParentURL', () => {
  const from = '/x/final';
  const to = '/x/base';
  const url = (path: string) => pathToFileURL(path).href;

  it('maps a final-tree file onto the base tree', () => {
    expect(rebaseParentURL(url('/x/final/eslint.config.mjs'), from, to)).toBe(
      url('/x/base/eslint.config.mjs'),
    );
  });

  it('keeps percent-encoding and drops a query suffix', () => {
    const parent = `${url('/x/my final/a b.mjs')}?mtime=123`;
    expect(rebaseParentURL(parent, '/x/my final', '/x/my base')).toBe(url('/x/my base/a b.mjs'));
  });

  it.each([
    ['a sibling directory sharing the prefix', url('/x/final2/eslint.config.mjs')],
    ['the root itself', url('/x/final')],
    ['a file inside node_modules', url('/x/final/node_modules/pkg/index.js')],
    ['a file outside the tree', url('/y/eslint.config.mjs')],
    ['a non-file URL', 'node:fs'],
    ['no parent', undefined],
  ])('leaves %s alone', (_label, parent) => {
    expect(rebaseParentURL(parent, from, to)).toBeUndefined();
  });
});

describe('resolveFromBase', () => {
  const resolve = resolveFromBase('/x/final', '/x/base');
  const parentURL = pathToFileURL('/x/final/eslint.config.mjs').href;
  const context = { conditions: ['node', 'import'], importAttributes: {}, parentURL };
  const fake = (urls: Record<string, string | Error>) => {
    const calls: (string | undefined)[] = [];
    const next = (_specifier: string, ctx: { parentURL?: string } = {}) => {
      calls.push(ctx.parentURL);
      const result = urls[String(ctx.parentURL)];
      if (result instanceof Error) throw result;
      return { url: String(result) };
    };
    return { calls, next };
  };
  const baseParent = pathToFileURL('/x/base/eslint.config.mjs').href;
  const notFound = Object.assign(new Error('missing'), { code: 'ERR_MODULE_NOT_FOUND' });

  it('loads a bare package from the base tree', () => {
    const { calls, next } = fake({ [baseParent]: 'file:///x/base/node_modules/pkg/index.js' });
    expect(resolve('pkg', context, next).url).toBe('file:///x/base/node_modules/pkg/index.js');
    expect(calls).toEqual([baseParent]);
  });

  it('keeps the final resolution when the base one lands on workspace source', () => {
    const { calls, next } = fake({
      [baseParent]: 'file:///x/base/packages/eslint-config/index.js',
      [parentURL]: 'file:///x/final/packages/eslint-config/index.js',
    });
    expect(resolve('@acme/eslint-config', context, next).url).toContain('/x/final/packages/');
    expect(calls).toEqual([baseParent, parentURL]);
  });

  it('falls back to the final tree when the base tree lacks the package', () => {
    const { next } = fake({
      [baseParent]: notFound,
      [parentURL]: 'file:///x/final/node_modules/new/i.js',
    });
    expect(resolve('new', context, next).url).toBe('file:///x/final/node_modules/new/i.js');
  });

  it('rethrows a resolution error that is not a missing package', () => {
    const { next } = fake({
      [baseParent]: Object.assign(new Error('bad'), { code: 'ERR_INVALID_PACKAGE_CONFIG' }),
    });
    expect(() => resolve('pkg', context, next)).toThrow('bad');
  });

  it.each(['./local.mjs', 'node:fs', 'fs', '#internal'])(
    'passes %s through untouched',
    (specifier) => {
      const { calls, next } = fake({ [parentURL]: 'file:///x/final/whatever.js' });
      resolve(specifier, context, next);
      expect(calls).toEqual([parentURL]);
    },
  );
});

describe('baseResolveEnv', () => {
  it('appends a preload of the hook to existing NODE_OPTIONS and names both trees', () => {
    const previous = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = '--max-old-space-size=4096';
    try {
      const env = baseResolveEnv('/x/final', '/x/base');
      const hook = pathToFileURL(
        join(DEVKIT, 'gate-engine/review/baseline/base-resolve-hook.mts'),
      ).href;
      expect(env.NODE_OPTIONS).toBe(`--max-old-space-size=4096 --import ${hook}`);
      expect(env.DEVKIT_REVIEW_RESOLVE_FROM).toBe('/x/final');
      expect(env.DEVKIT_REVIEW_RESOLVE_TO).toBe('/x/base');
    } finally {
      if (previous === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previous;
    }
  });
});
