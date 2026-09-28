// Loads the SHIPPED electron template against real consumer installs (TS7, no TypeScript, no TS
// parser) and pins which source parser it selects; each fixture withholds or stubs one package.
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const DEVKIT_ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '../..'));
const DEVKIT_MODULES = join(DEVKIT_ROOT, 'node_modules');
const TS_PARSER = 'typescript-eslint/parser';
const BABEL_PARSER = '@babel/eslint-parser';

const DOMAINS = `export const RENDERER_LIB_DOMAINS = [];
export const MAIN_ROOT_FOLDERS = ['lib'];
export const MAIN_LIB_DOMAINS = [];
export const SOCKET_LIB_DOMAINS = [];
export const VERCEL_LIB_DOMAINS = [];
`;

// Prints the `meta.name` of every distinct parser the loaded flat config wires in.
const PROBE = `const { default: config } = await import('./eslint.config.mjs');
const names = new Set((await config).map((block) => block.languageOptions?.parser?.meta?.name).filter(Boolean));
console.log(JSON.stringify([...names]));`;

interface ConsumerInstall {
  typescript: 'real' | 'ts7' | 'absent';
  tsParser: boolean;
}

const roots: string[] = [];

function linkModules(modules: string, install: ConsumerInstall) {
  mkdirSync(modules);
  for (const entry of readdirSync(DEVKIT_MODULES)) {
    if (entry === 'typescript' || entry === '@typescript-eslint' || entry.startsWith('.')) continue;
    symlinkSync(join(DEVKIT_MODULES, entry), join(modules, entry), 'dir');
  }
  mkdirSync(join(modules, '@typescript-eslint'));
  for (const entry of readdirSync(join(DEVKIT_MODULES, '@typescript-eslint'))) {
    if (entry === 'parser' && !install.tsParser) continue;
    const target = join(DEVKIT_MODULES, '@typescript-eslint', entry);
    symlinkSync(target, join(modules, '@typescript-eslint', entry), 'dir');
  }
  if (install.typescript === 'real') {
    symlinkSync(join(DEVKIT_MODULES, 'typescript'), join(modules, 'typescript'), 'dir');
  }
  if (install.typescript === 'ts7') {
    // TypeScript 7's JavaScript entry point: version strings, no compiler API.
    mkdirSync(join(modules, 'typescript'));
    writeFileSync(
      join(modules, 'typescript', 'package.json'),
      '{"name":"typescript","version":"7.0.2","main":"index.js"}\n',
    );
    writeFileSync(
      join(modules, 'typescript', 'index.js'),
      "module.exports = { version: '7.0.2', versionMajorMinor: '7.0' };\n",
    );
  }
}

/** The one source parser the template chose — the structure plugin's own parser is always there too. */
function sourceParser(install: ConsumerInstall): string {
  const chosen = loadedParsers(install).filter(
    (name) => name === TS_PARSER || name === BABEL_PARSER,
  );
  expect(chosen).toHaveLength(1);
  return chosen[0];
}

function loadedParsers(install: ConsumerInstall): string[] {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'electron-structure-parser-')));
  roots.push(root);
  linkModules(join(root, 'node_modules'), install);
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(root, 'guard.config.json'), '{"scanRoots":["src"]}\n');
  mkdirSync(join(root, 'eslint'));
  writeFileSync(join(root, 'eslint', 'domains.mjs'), DOMAINS);
  copyFileSync(
    join(DEVKIT_ROOT, 'templates/electron/eslint.config.mjs'),
    join(root, 'eslint.config.mjs'),
  );
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (result.status !== 0) {
    throw new Error(`the template did not load (status ${result.status}): ${result.stderr}`);
  }
  return JSON.parse(result.stdout.trim());
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('shipped Electron structure parser selection', () => {
  it('uses the TypeScript parser when TypeScript exposes its compiler API', () => {
    expect(sourceParser({ typescript: 'real', tsParser: true })).toBe(TS_PARSER);
  });

  it('falls back to Babel under TypeScript 7, whose entry point carries no compiler API', () => {
    expect(sourceParser({ typescript: 'ts7', tsParser: true })).toBe(BABEL_PARSER);
  });

  it('falls back to Babel instead of crashing when TypeScript is not installed at all', () => {
    expect(sourceParser({ typescript: 'absent', tsParser: true })).toBe(BABEL_PARSER);
  });

  it('falls back to Babel when only TypeScript is installed, without its ESLint parser', () => {
    expect(sourceParser({ typescript: 'real', tsParser: false })).toBe(BABEL_PARSER);
  });
});
