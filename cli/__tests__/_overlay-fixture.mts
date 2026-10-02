/**
 * Shared fixture for the in-process overlay install suites: a consumer repo whose husky owns the
 * hook, and a git-config isolation that keeps the host's ~/.gitconfig out of `applyInit`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';
import { testExecFileSync } from './_helpers.mts';

/** Verbs that DISPATCH A HOOK here: `commit`, and the `ci` heal alias, which re-pins hooksPath and
 *  then commits. Both are process trees; every other git verb is a leaf and stays raw. */
const HOOK_DISPATCHING_GIT_VERBS = new Set(['commit', 'ci']);
/** See suite-hangs-bound-at-the-spawn-site: `workRepo` installs a real `.husky/pre-commit`. */
export const gitVerb = (args: string[]) =>
  HOOK_DISPATCHING_GIT_VERBS.has(args[0]) ? testExecFileSync : execFileSync;

/** A consumer repo with its own eslint and biome configs and husky owning `core.hooksPath`. */
export function workRepo(mkTmp: (prefix: string) => string) {
  const root = mkTmp('overlay-');
  const git = (...a) => gitVerb(a)('git', a, { cwd: root });
  git('init', '-q');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'work', devDependencies: { react: '^18' } }, null, 2),
  );
  mkdirSync(join(root, '.husky'), { recursive: true });
  writeFileSync(join(root, '.husky', 'pre-commit'), '#!/bin/sh\necho team-hook\n');
  writeFileSync(join(root, 'eslint.config.mjs'), 'export default [{ rules: {} }];\n');
  writeFileSync(join(root, 'biome.jsonc'), '{ "linter": { "enabled": true } }\n');
  git('config', 'core.hooksPath', '.husky/_'); // simulate husky owning the hook
  git('add', '-A');
  git('commit', '-qm', 'init');
  return root;
}

export const readCfgComponents = (root) =>
  JSON.parse(readFileSync(join(root, '.devkit', 'config.json'), 'utf8')).components;

/** Register per-test console silence, temp cleanup and git-config isolation: in-process applyInit
 * inherits process.env, so a host's own global `git ci` alias would otherwise skip devkit's. */
export function isolateOverlayTestEnv(cleanup: () => void) {
  const original = {
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
  };
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_SYSTEM = '/dev/null';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}
