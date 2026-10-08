/**
 * sc-4157: an overlay's hooks must run in every linked worktree, not only the checkout it was
 * installed in. Real git throughout — the defect was git silently finding no hooks directory.
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import cleanRun from '../commands/clean.mts';
import doctorRun from '../commands/doctor.mts';
import { applyInit } from '../commands/init.mts';
import { applyOverlayConstraints, defaultSelection } from '../lib/components.mts';
import { nativeHooksDir } from '../lib/doctor/hooks-path.mts';
import { printLegacyEslintOverlays } from '../lib/doctor/overlay-doctor.mts';
import { chainWord } from '../lib/husky/husky-block.mts';
import { healAliasCmd, isHealAlias } from '../lib/husky/overlay/heal-alias.mts';
import {
  isOverlayHooksValue,
  overlayCommandCwd,
  overlayHome,
  unprojectOverlay,
  worktrees,
} from '../lib/husky/overlay/overlay-home.mts';
import {
  ESLINT_OVERLAY_FILE,
  eslintOverlayContent,
  legacyEslintOverlayContent,
} from '../lib/install/overlay-lint-configs.mts';
import { captureOrigHooksPath, syncOverlayHook } from '../lib/overlay.mts';
import { installGlobalHook } from '../lib/overlay-global-hook.mts';
import { shQuote } from '../lib/ship/redact-secrets.mts';
import { overlayHooksPathRejection } from '../lib/ship/review/setup/overlay-hooks-path.mts';
import { devkitHome, rootRegistry, testExecFileSync } from './_helpers.mts';

const { mkTmp, cleanup } = rootRegistry();

// The recommended guards, so the install writes a real selection's exclude lines; every commit here is
// empty, so the hook's observable effect is chaining to the team hook's marker.
const SELECTION = applyOverlayConstraints(
  {
    ...defaultSelection(),
    biome: false,
    skills: false,
    agents: false,
    lineGrowth: false,
  },
  'react-app',
);

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

let marker = '';
let home = '';
const hookEnv = (env: Record<string, string> = {}) => ({
  ...process.env,
  HOME: home,
  DK_TEST_MARKER: marker,
  DEVKIT_NO_TELEMETRY: '1',
  ...env,
});
const commit = (cwd: string, message: string, env?: Record<string, string>) =>
  testExecFileSync('git', ['commit', '-q', '--allow-empty', '-m', message], {
    cwd,
    encoding: 'utf8',
    env: hookEnv(env),
  });
// A plain commit now persists its gate output (sc-2755). Clean keeps a .devkit that still holds a
// gate log — the same rule that keeps ship logs — so "projection gone" means nothing else remains.
const projectionLeftovers = (dir: string) =>
  existsSync(join(dir, '.devkit'))
    ? readdirSync(join(dir, '.devkit')).filter(
        (f) => !/^last-commit-gates-.*\.log$/.test(f) && f !== '.gitignore',
      )
    : [];

/** The stderr of a commit the hook must block. */
function blockedCommit(cwd: string, env?: Record<string, string>): string {
  try {
    commit(cwd, 'blocked', env);
  } catch (e) {
    return e instanceof Error && 'stderr' in e ? String(e.stderr) : String(e);
  }
  throw new Error(`the commit in ${cwd} was not blocked`);
}
const markerLines = () =>
  existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n') : [];
const devkitCalls = () => {
  const log = join(home, 'devkit-calls');
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
};

// The team's committed husky hook records which checkout it ran in.
function workRepo() {
  const root = mkTmp('overlay-wt-');
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 't@t.t');
  git(root, 'config', 'user.name', 't');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'work' }));
  mkdirSync(join(root, '.husky'), { recursive: true });
  writeFileSync(join(root, '.husky', 'pre-commit'), '#!/bin/sh\npwd -P >> "$DK_TEST_MARKER"\n');
  writeFileSync(join(root, 'eslint.config.mjs'), 'export default [];\n');
  git(root, 'config', 'core.hooksPath', '.husky/_');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  return root;
}

const initOverlay = (root: string) =>
  applyInit(root, { stack: 'react-app', selection: SELECTION, overlay: true, devkitRef: 'v0.9.0' });

const addWorktree = (root: string, ...flags: string[]) => {
  const wt = join(mkTmp('overlay-linked-'), 'wt');
  git(root, 'worktree', 'add', '-q', '--detach', ...flags, wt);
  return wt;
};

const exclude = (root: string, ...lines: string[]) =>
  writeFileSync(join(root, '.git', 'info', 'exclude'), `\n${lines.join('\n')}\n`, { flag: 'a' });

// The consumer-owned gate inputs a home holds, each git-ignored by the consumer's own lines.
function withGateInputs(root: string) {
  writeFileSync(join(root, 'guard.config.json'), '{"indexPath": ".search-code/index.db"}\n');
  writeFileSync(join(root, '.fallowrc.jsonc'), '{}\n');
  mkdirSync(join(root, 'docs', 'decisions'), { recursive: true });
  writeFileSync(join(root, 'docs', 'decisions', 'a.md'), '# a\n');
  mkdirSync(join(root, '.search-code'));
  writeFileSync(join(root, '.search-code', 'index.db'), 'db');
  writeFileSync(join(root, '.co-occurrence-allowlist.json'), '{}\n');
  exclude(root, '/.fallowrc.jsonc', '/docs/*', '.search-code', '/.co-occurrence-allowlist.json');
}

/** Run `fn` with the global husky shim's config dir at `xdg`, and return what it returns. */
async function withXdg<T>(xdg: string, fn: () => T | Promise<T>): Promise<T> {
  const saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
  }
}

/** Install the global husky shim into a fresh XDG config dir, and return that dir. */
async function installShim(): Promise<string> {
  const xdg = mkTmp('overlay-xdg-');
  await withXdg(xdg, installGlobalHook);
  return xdg;
}

/** What `husky` (index.js) does on every install: its runner and stubs, and core.hooksPath. */
function huskyReclaim(root: string) {
  const runner = join(root, '.husky', '_');
  mkdirSync(runner, { recursive: true });
  cpSync(join(dirname(fileURLToPath(import.meta.resolve('husky'))), 'husky'), join(runner, 'h'));
  for (const hook of ['pre-commit', 'commit-msg'])
    writeFileSync(join(runner, hook), '#!/usr/bin/env sh\n. "$(dirname "$0")/h"', { mode: 0o755 });
  writeFileSync(join(runner, '.gitignore'), '*');
  git(root, 'config', 'core.hooksPath', '.husky/_');
}

const ORIGINAL = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_SYSTEM };
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_SYSTEM = '/dev/null';
  marker = join(mkTmp('overlay-marker-'), 'ran');
  home = devkitHome(mkTmp('overlay-home-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  for (const [key, value] of [
    ['GIT_CONFIG_GLOBAL', ORIGINAL.global],
    ['GIT_CONFIG_SYSTEM', ORIGINAL.system],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// A repo whose hooks are git's own: no core.hooksPath, scripts in the common dir's hooks/.
function nativeHooksRepo() {
  const root = mkTmp('overlay-native-');
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 't@t.t');
  git(root, 'config', 'user.name', 't');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'work' }));
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  const hooks = join(root, '.git', 'hooks');
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\npwd -P >> "$DK_TEST_MARKER"\n', {
    mode: 0o755,
  });
  writeFileSync(join(hooks, 'pre-push'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return root;
}

describe('overlay installed from a linked worktree keeps the native hooks', () => {
  it('chains the native pre-commit and wraps pre-push', async () => {
    const wt = addWorktree(nativeHooksRepo());
    await initOverlay(wt);

    commit(wt, 'from the worktree');

    expect(markerLines()).toEqual([realpathSync(wt)]);
    expect(readFileSync(join(wt, '.devkit', 'hooks', 'pre-push'), 'utf8')).toContain(
      chainWord('.git/hooks/pre-push'),
    );
  });

  it('doctor --fix rebuilds the pre-commit with the native chain', async () => {
    const wt = addWorktree(nativeHooksRepo());
    await initOverlay(wt);
    rmSync(join(wt, '.devkit', 'hooks', 'pre-commit'));

    await doctorRun(['--fix'], wt);

    expect(readFileSync(join(wt, '.devkit', 'hooks', 'pre-commit'), 'utf8')).toContain(
      chainWord('.git/hooks/pre-commit'),
    );
  });

  it('nativeHooksDir resolves the common hooks dir from a worktree, and is null outside git', () => {
    const root = nativeHooksRepo();
    expect(realpathSync(nativeHooksDir(addWorktree(root)) ?? '')).toBe(
      realpathSync(join(root, '.git', 'hooks')),
    );
    expect(nativeHooksDir(mkTmp('overlay-nogit-'))).toBeNull();
  });

  it('refuses to sync when git cannot resolve the common dir, rather than dropping the hooks', async () => {
    const root = nativeHooksRepo();
    const wt = addWorktree(root);
    await initOverlay(wt);
    rmSync(join(root, '.git'), { recursive: true, force: true });

    expect(() => syncOverlayHook(wt, wt, { origHooksPath: '' }, { dryRun: true })).toThrow(
      /could not resolve the git common dir/,
    );
  });

  it('warns when the native commit-msg already calls a selected judge', async () => {
    const root = nativeHooksRepo();
    writeFileSync(
      join(root, '.git', 'hooks', 'commit-msg'),
      '#!/bin/sh\nguard-review completeness --gate "$1"\n',
      { mode: 0o755 },
    );
    const wt = addWorktree(root);
    const selection = { ...SELECTION, guards: [...SELECTION.guards, 'review'] };
    await applyInit(wt, { stack: 'react-app', selection, overlay: true, devkitRef: 'v0.9.0' });

    const logged = vi.mocked(console.log).mock.calls.flat().join('\n');
    expect(logged).toMatch(/also appears to call completeness — it will run twice/);
  });

  it('a native hook runs only while executable, as git decides at commit time', async () => {
    const root = nativeHooksRepo();
    const hook = join(root, '.git', 'hooks', 'pre-commit');
    chmodSync(hook, 0o644);
    const wt = addWorktree(root);
    await initOverlay(wt);

    commit(wt, 'disabled at install');
    chmodSync(hook, 0o755);
    commit(wt, 'enabled after install');
    chmodSync(hook, 0o644);
    commit(wt, 'disabled again');

    expect(markerLines()).toEqual([realpathSync(wt)]);
  });

  it('a native hook runs under its own shebang, not sh', async () => {
    const root = nativeHooksRepo();
    const script = `#!${process.execPath}\nrequire('fs').appendFileSync(process.env.DK_TEST_MARKER, 'node\\n');\n`;
    writeFileSync(join(root, '.git', 'hooks', 'pre-commit'), script, { mode: 0o755 });
    const wt = addWorktree(root);
    await initOverlay(wt);

    commit(wt, 'node hook');

    expect(markerLines()).toEqual(['node']);
  });

  it('a native directory named like a hook is never run', async () => {
    const root = nativeHooksRepo();
    rmSync(join(root, '.git', 'hooks', 'pre-commit'));
    mkdirSync(join(root, '.git', 'hooks', 'pre-commit'));
    const wt = addWorktree(root);
    await initOverlay(wt);

    commit(wt, 'directory hook');

    expect(markerLines()).toEqual([]);
  });
});

describe('overlay hooks in linked worktrees (sc-4157)', () => {
  it('a commit in a fresh linked worktree runs the overlay chain and links the overlay in', async () => {
    const root = workRepo();
    await initOverlay(root);
    expect(git(root, 'config', '--get', 'core.hooksPath')).toBe(join(root, '.devkit', 'hooks'));
    const wt = addWorktree(root);

    commit(wt, 'from the worktree');

    expect(markerLines()).toEqual([realpathSync(wt)]);
    expect(lstatSync(join(wt, '.devkit')).isDirectory()).toBe(true);
    expect(lstatSync(join(wt, '.devkit', 'config.json')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(wt, 'eslint.config.devkit.mjs')).isFile()).toBe(true);
    expect(git(wt, 'status', '--porcelain')).toBe('');
    // One projector: the hook delegates to it rather than linking or copying on its own.
    expect(readFileSync(join(root, '.devkit', 'hooks', 'pre-commit'), 'utf8')).not.toMatch(
      /\bln -s\b|\bcp -R\b/,
    );
  });

  it('a linked-worktree commit runs the selected gates from the global devkit install', async () => {
    const root = workRepo();
    const selection = { ...SELECTION, guards: [...SELECTION.guards, 'review'] };
    await applyInit(root, { stack: 'react-app', selection, overlay: true, devkitRef: 'v0.9.0' });
    const wt = addWorktree(root);

    commit(wt, 'gated in the worktree');

    const calls = readFileSync(join(home, 'gate-calls'), 'utf8');
    expect(calls).toContain('guard-deterministic --hook');
    expect(calls).toContain('guard-review --gate');
    expect(markerLines()).toEqual([realpathSync(wt)]);
  });

  it('a --no-checkout worktree is gated too, since linking happens at commit time', async () => {
    const root = workRepo();
    await initOverlay(root);
    const wt = addWorktree(root, '--no-checkout');
    git(wt, 'checkout', '-q', '--detach', 'HEAD');

    commit(wt, 'no-checkout worktree');

    expect(markerLines()).toEqual([realpathSync(wt)]);
  });

  it('a real .devkit holding only ship logs gets the missing entries linked into it', async () => {
    const root = workRepo();
    await initOverlay(root);
    const wt = addWorktree(root);
    mkdirSync(join(wt, '.devkit'));
    writeFileSync(join(wt, '.devkit', 'last-ship-gates-x.log'), 'log\n');

    commit(wt, 'legacy dir');

    expect(lstatSync(join(wt, '.devkit')).isDirectory()).toBe(true);
    expect(lstatSync(join(wt, '.devkit', 'config.json')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(wt, '.devkit', 'last-ship-gates-x.log'), 'utf8')).toBe('log\n');
    expect(markerLines()).toEqual([realpathSync(wt)]);
  });

  it('clean from the home unlinks every worktree before the exclude is pruned', async () => {
    const root = workRepo();
    await initOverlay(root);
    const wt = addWorktree(root);
    commit(wt, 'link it');
    expect(lstatSync(join(wt, '.devkit', 'config.json')).isSymbolicLink()).toBe(true);

    await cleanRun(['--yes'], root);

    expect(projectionLeftovers(wt)).toEqual([]);
    expect(existsSync(join(wt, 'eslint.config.devkit.mjs'))).toBe(false);
    expect(git(wt, 'status', '--porcelain')).toBe('');
    expect(git(root, 'config', '--get', 'core.hooksPath')).toBe('.husky/_');
  });

  it('overlay-owning commands run in the home, never through a worktree’s links', async () => {
    const root = workRepo();
    await initOverlay(root);
    const wt = addWorktree(root);
    commit(wt, 'link it');

    expect(realpathSync(overlayCommandCwd(wt))).toBe(realpathSync(root));
    expect(overlayCommandCwd(root)).toBe(root);
  });

  it('doctor --fix migrates a legacy relative hooksPath and its alias to the absolute path', async () => {
    const root = workRepo();
    await initOverlay(root);
    git(root, 'config', 'core.hooksPath', '.devkit/hooks');
    git(root, 'config', 'alias.ci', '!git config --local core.hooksPath .devkit/hooks; git commit');

    expect(await doctorRun([], root)).toBe(1);
    await doctorRun(['--fix'], root);

    const hooks = realpathSync(join(root, '.devkit', 'hooks'));
    expect(realpathSync(git(root, 'config', '--get', 'core.hooksPath'))).toBe(hooks);
    expect(git(root, 'config', '--get', 'alias.ci')).toContain(hooks);
  });

  it('review accepts the absolute value only when it is this checkout’s own .devkit/hooks', async () => {
    const root = workRepo();
    await initOverlay(root);
    const value = git(root, 'config', '--get', 'core.hooksPath');
    const linked = addWorktree(root);
    commit(linked, 'link it');
    const stale = addWorktree(root);
    mkdirSync(join(stale, '.devkit', 'hooks'), { recursive: true });
    const context = (gitRoot: string) => ({ gitRoot, chain: null, chainPresent: false });

    expect(overlayHooksPathRejection(value, context(root))).toBeNull();
    expect(overlayHooksPathRejection(value, context(linked))).toBeNull();
    expect(overlayHooksPathRejection(value, context(stale))).toContain('expected');
  });

  it('a bare repository’s own entry is never taken as the overlay home', async () => {
    const seed = workRepo();
    const bare = join(mkTmp('overlay-bare-'), 'repo.git');
    git(seed, 'clone', '-q', '--bare', seed, bare);
    const wt = join(mkTmp('overlay-bare-wt-'), 'wt');
    git(bare, 'worktree', 'add', '-q', '--detach', wt);
    git(wt, 'config', 'user.email', 't@t.t');
    git(wt, 'config', 'user.name', 't');
    await initOverlay(wt);

    expect(worktrees(wt)[0].bare).toBe(true);
    expect(realpathSync(overlayHome(wt) ?? '')).toBe(realpathSync(wt));
    expect(realpathSync(git(wt, 'config', '--get', 'core.hooksPath'))).toBe(
      realpathSync(join(wt, '.devkit', 'hooks')),
    );
  });

  it('only this repo’s own worktree .devkit/hooks counts as devkit’s value', async () => {
    const root = workRepo();
    await initOverlay(root);
    const other = workRepo();

    expect(isOverlayHooksValue('.devkit/hooks', root)).toBe(true);
    expect(isOverlayHooksValue(join(root, '.devkit', 'hooks'), root)).toBe(true);
    expect(isOverlayHooksValue('/opt/custom/.devkit/hooks', root)).toBe(false);
    expect(isOverlayHooksValue(join(other, '.devkit', 'hooks'), root)).toBe(false);
    git(other, 'config', 'core.hooksPath', '/opt/custom/.devkit/hooks');
    expect(captureOrigHooksPath(other, other)).toBe('/opt/custom/.devkit/hooks');
  });

  it('the heal alias is recognised only in the exact shape devkit writes', () => {
    const spaced = "/tmp/it's a repo/.devkit/hooks";
    expect(isHealAlias(healAliasCmd(spaced))).toBe(true);
    expect(isHealAlias('!git config --local core.hooksPath .devkit/hooks; git commit')).toBe(true);
    expect(isHealAlias('!echo core.hooksPath /tmp/.devkit/hooks')).toBe(false);
    expect(isHealAlias('!git config --local core.hooksPath /tmp/elsewhere; git commit')).toBe(
      false,
    );
    expect(isHealAlias(`${healAliasCmd('/r/.devkit/hooks')} && rm -rf ~`)).toBe(false);
  });

  it('clean also unlinks a worktree nested inside the home', async () => {
    const root = workRepo();
    await initOverlay(root);
    writeFileSync(join(root, '.git', 'info', 'exclude'), '\n.worktrees/\n', { flag: 'a' });
    const nested = join(root, '.worktrees', 'feature');
    git(root, 'worktree', 'add', '-q', '--detach', nested);
    commit(nested, 'link it');
    expect(lstatSync(join(nested, '.devkit', 'config.json')).isSymbolicLink()).toBe(true);

    await cleanRun(['--yes'], root);

    expect(projectionLeftovers(nested)).toEqual([]);
  });

  it('a real .devkit holding only a LINKED config is borrowed, so commands run in the home', async () => {
    const root = workRepo();
    await initOverlay(root);
    const wt = addWorktree(root);
    mkdirSync(join(wt, '.devkit'));
    commit(wt, 'merge the overlay in');
    expect(lstatSync(join(wt, '.devkit', 'config.json')).isSymbolicLink()).toBe(true);

    expect(realpathSync(overlayCommandCwd(wt))).toBe(realpathSync(root));
  });

  // Node resolves an ESM module at its real path, so a LINKED devkit config would import the home's.
  it('the worktree lints with its own eslint.config.mjs, not the home’s', async () => {
    const root = workRepo();
    await initOverlay(root);
    const wt = addWorktree(root);
    commit(wt, 'link it');
    writeFileSync(join(wt, 'eslint.config.mjs'), "export default ['branch-rules'];\n");

    const first = execFileSync(
      'node',
      [
        '--input-type=module',
        '-e',
        `const m = await import(${JSON.stringify(join(wt, 'eslint.config.devkit.mjs'))}); console.log(m.default.at(-1))`,
      ],
      { encoding: 'utf8' },
    ).trim();

    expect(first).toBe('branch-rules');
  });

  it('ratchet baselines are copied, so a worktree lowering one leaves the home’s alone', async () => {
    const root = workRepo();
    await initOverlay(root);
    mkdirSync(join(root, '.devkit', 'baselines'), { recursive: true });
    writeFileSync(join(root, '.devkit', 'baselines', 'size-lines.json'), '{"a.ts":400}\n');
    mkdirSync(join(root, 'fallow-baselines'));
    writeFileSync(join(root, 'fallow-baselines', 'health.json'), '{}\n');
    writeFileSync(join(root, '.git', 'info', 'exclude'), '\nfallow-baselines\n', { flag: 'a' });
    const wt = addWorktree(root);

    commit(wt, 'link it');
    writeFileSync(join(wt, '.devkit', 'baselines', 'size-lines.json'), '{"a.ts":300}\n');

    expect(lstatSync(join(wt, '.devkit', 'baselines')).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(wt, 'fallow-baselines')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(root, '.devkit', 'baselines', 'size-lines.json'), 'utf8')).toBe(
      '{"a.ts":400}\n',
    );
    expect(git(wt, 'status', '--porcelain')).toBe('');
  });

  it('a worktree whose .devkit holds only a copied hook still borrows, so its baselines are projected', async () => {
    const root = workRepo();
    await initOverlay(root);
    mkdirSync(join(root, '.devkit', 'baselines'), { recursive: true });
    writeFileSync(join(root, '.devkit', 'baselines', 'size-lines.json'), '{"a.ts":400}\n');
    const wt = addWorktree(root);
    // Worktree tooling copies the hook into a real .devkit, then nests its link to the home inside.
    cpSync(join(root, '.devkit', 'hooks'), join(wt, '.devkit', 'hooks'), { recursive: true });
    symlinkSync(join(root, '.devkit'), join(wt, '.devkit', '.devkit'));

    expect(await doctorRun([], root)).toBe(1);
    commit(wt, 'borrows despite the copied hook');

    const baseline = join(wt, '.devkit', 'baselines', 'size-lines.json');
    expect(lstatSync(baseline).isFile()).toBe(true);
    expect(readFileSync(baseline, 'utf8')).toBe('{"a.ts":400}\n');
    expect(git(wt, 'status', '--porcelain')).toBe('');
  });

  it('doctor flags a worktree linked by the first sc-4157 projection, and --fix makes it branch-local', async () => {
    const root = workRepo();
    await initOverlay(root);
    const wt = addWorktree(root);
    symlinkSync(join(root, '.devkit'), join(wt, '.devkit'));
    symlinkSync(join(root, 'eslint.config.devkit.mjs'), join(wt, 'eslint.config.devkit.mjs'));

    expect(await doctorRun([], root)).toBe(1);
    await doctorRun(['--fix'], root);

    expect(lstatSync(join(wt, '.devkit')).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(wt, '.devkit', 'config.json')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(wt, 'eslint.config.devkit.mjs')).isFile()).toBe(true);
    expect(existsSync(join(root, '.devkit', 'config.json'))).toBe(true);
    expect(git(wt, 'status', '--porcelain')).toBe('');
  });

  it('a repo whose own hook lives in .git/hooks still chains to it from a linked worktree', async () => {
    const root = mkTmp('overlay-githooks-');
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 't@t.t');
    git(root, 'config', 'user.name', 't');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'work' }));
    writeFileSync(join(root, 'eslint.config.mjs'), 'export default [];\n');
    git(root, 'add', '-A');
    git(root, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'init');
    const hook = join(root, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\npwd -P >> "$DK_TEST_MARKER"\n');
    chmodSync(hook, 0o755);
    await initOverlay(root);
    const wt = addWorktree(root);

    commit(root, 'from the home');
    commit(wt, 'from the worktree');

    expect(markerLines()).toEqual([realpathSync(root), realpathSync(wt)]);
  });

  it('clean removes only the copies projection made, never a worktree’s own file', async () => {
    const root = workRepo();
    await initOverlay(root);
    mkdirSync(join(root, '.devkit', 'baselines'), { recursive: true });
    writeFileSync(join(root, '.devkit', 'baselines', 'size-lines.json'), '{}\n');
    const wt = addWorktree(root);
    writeFileSync(join(wt, 'eslint.config.devkit.mjs'), '// the worktree’s own\n');

    commit(wt, 'link it');
    expect(lstatSync(join(wt, '.devkit', 'baselines')).isDirectory()).toBe(true);
    await cleanRun(['--yes'], root);

    expect(readFileSync(join(wt, 'eslint.config.devkit.mjs'), 'utf8')).toBe(
      '// the worktree’s own\n',
    );
    expect(projectionLeftovers(wt)).toEqual([]);
  });

  it('clean keeps a baseline the branch changed and lists it, but drops untouched copies', async () => {
    const root = workRepo();
    await initOverlay(root);
    mkdirSync(join(root, '.devkit', 'baselines'), { recursive: true });
    writeFileSync(join(root, '.devkit', 'baselines', 'size-lines.json'), '{"a.ts":400}\n');
    const wt = addWorktree(root);
    commit(wt, 'link it');
    writeFileSync(join(wt, '.devkit', 'baselines', 'size-lines.json'), '{"a.ts":300}\n');

    await cleanRun(['--yes'], root);

    expect(readFileSync(join(wt, '.devkit', 'baselines', 'size-lines.json'), 'utf8')).toBe(
      '{"a.ts":300}\n',
    );
    expect(existsSync(join(wt, 'eslint.config.devkit.mjs'))).toBe(false);
  });

  it('clean removes a copied directory that only a `dir/` line ignores', async () => {
    const root = workRepo();
    await initOverlay(root);
    mkdirSync(join(root, 'fallow-baselines'));
    writeFileSync(join(root, 'fallow-baselines', 'health.json'), '{}\n');
    const exclude = join(root, '.git', 'info', 'exclude');
    const lines = readFileSync(exclude, 'utf8').split('\n');
    writeFileSync(
      exclude,
      `${lines.filter((line) => line !== 'fallow-baselines').join('\n')}\nfallow-baselines/\n`,
    );
    const wt = addWorktree(root);
    await doctorRun(['--fix'], root);
    expect(lstatSync(join(wt, 'fallow-baselines')).isDirectory()).toBe(true);

    await cleanRun(['--yes'], root);

    expect(existsSync(join(wt, 'fallow-baselines'))).toBe(false);
  });

  it('doctor --fix restores a copy a worktree lost', async () => {
    const root = workRepo();
    await initOverlay(root);
    const wt = addWorktree(root);
    commit(wt, 'link it');
    rmSync(join(wt, 'eslint.config.devkit.mjs'));

    expect(await doctorRun([], root)).toBe(1);
    await doctorRun(['--fix'], root);

    expect(lstatSync(join(wt, 'eslint.config.devkit.mjs')).isFile()).toBe(true);
  });

  it('a .git/hooks chain resolves through the common dir, trailing slash or not', () => {
    for (const target of [
      '.git/hooks/pre-commit',
      '.git/hooks//pre-commit',
      './.git/hooks/pre-commit',
    ])
      expect(chainWord(target)).toBe(
        '"$(git rev-parse --path-format=absolute --git-common-dir)/hooks/"pre-commit',
      );
    expect(chainWord('.husky/pre-commit')).toBe('.husky/pre-commit');
    expect(chainWord('.githooks/$(rm -rf ~)')).toBe("'.githooks/$(rm -rf ~)'");
  });

  it('a projection that fails blocks the commit with its remedy, and the next commit retries', async () => {
    const root = workRepo();
    await initOverlay(root);
    mkdirSync(join(root, 'fallow-baselines'));
    const unreadable = join(root, 'fallow-baselines', 'health.json');
    writeFileSync(unreadable, '{}\n');
    chmodSync(unreadable, 0o000);
    writeFileSync(join(root, '.git', 'info', 'exclude'), '\nfallow-baselines\n', { flag: 'a' });
    const wt = addWorktree(root);

    try {
      expect(blockedCommit(wt)).toContain('could not repair the projection');
      expect(existsSync(join(wt, 'fallow-baselines'))).toBe(false);
      expect(markerLines()).toEqual([]);
    } finally {
      chmodSync(unreadable, 0o644);
    }
    commit(wt, 'copy succeeds');

    expect(readFileSync(join(wt, 'fallow-baselines', 'health.json'), 'utf8')).toBe('{}\n');
    expect(lstatSync(join(wt, '.devkit', 'config.json')).isSymbolicLink()).toBe(true);
    expect(markerLines()).toEqual([realpathSync(wt)]);
  });

  it('under the global husky shim a failed projection blocks without running the repo hook', async () => {
    const root = workRepo();
    await initOverlay(root);
    mkdirSync(join(root, 'fallow-baselines'));
    const unreadable = join(root, 'fallow-baselines', 'health.json');
    writeFileSync(unreadable, '{}\n');
    chmodSync(unreadable, 0o000);
    writeFileSync(join(root, '.git', 'info', 'exclude'), '\nfallow-baselines\n', { flag: 'a' });
    const wt = addWorktree(root);

    try {
      expect(() =>
        testExecFileSync('git', ['hook', 'run', 'pre-commit'], {
          cwd: wt,
          encoding: 'utf8',
          env: hookEnv({ DEVKIT_VIA_HUSKY_INIT: '1' }),
        }),
      ).toThrow();
    } finally {
      chmodSync(unreadable, 0o644);
    }
    // husky's own _/h runs the repo hook after the shim; the overlay hook must not run it too.
    expect(markerLines()).toEqual([]);
  });

  it('without devkit on PATH every commit fails closed, in the home and in a linked worktree', async () => {
    const root = workRepo();
    await initOverlay(root);
    const wt = addWorktree(root);
    const gitDir = dirname(execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }));
    const PATH = `${gitDir}:/usr/bin:/bin`;
    expect(() =>
      execFileSync('sh', ['-c', 'command -v guard-deterministic'], { env: { PATH } }),
    ).toThrow();
    const bare = { PATH, HOME: mkTmp('overlay-no-devkit-') };

    for (const checkout of [root, wt])
      expect(blockedCommit(checkout, bare)).toContain('devkit: not installed on PATH');
    expect(markerLines()).toEqual([]);
  });

  it('a complete worktree commits without the projector, and a gate input the home gains is projected', async () => {
    const root = workRepo();
    await initOverlay(root);
    const wt = addWorktree(root);

    commit(wt, 'project it');
    expect(devkitCalls()).toHaveLength(1);
    commit(wt, 'complete');
    expect(devkitCalls()).toHaveLength(1);

    mkdirSync(join(root, '.devkit', 'baselines', 'structure'), { recursive: true });
    writeFileSync(join(root, '.devkit', 'baselines', 'structure', 'app.mjs'), 'export {};\n');
    commit(wt, 'a new baseline');
    rmSync(join(wt, 'eslint.config.devkit.mjs'));
    commit(wt, 'a lost copy');

    expect(devkitCalls()).toHaveLength(3);
    expect(lstatSync(join(wt, '.devkit', 'baselines', 'structure', 'app.mjs')).isFile()).toBe(true);
    expect(lstatSync(join(wt, 'eslint.config.devkit.mjs')).isFile()).toBe(true);
  });

  it('under the global husky shim a projected worktree that lost an input is projected again', async () => {
    const root = workRepo();
    await initOverlay(root);
    const wt = addWorktree(root);
    commit(wt, 'project it');
    rmSync(join(wt, '.devkit', 'config.json'));
    rmSync(join(wt, 'eslint.config.devkit.mjs'));
    const xdg = await installShim();
    // husky's _/h sources init.sh from a script named after the hook, in the committing checkout.
    const driver = join(mkTmp('overlay-husky-'), 'pre-commit');
    writeFileSync(driver, `. ${shQuote(join(xdg, 'husky', 'init.sh'))}\n`);

    testExecFileSync('sh', [driver], { cwd: wt, encoding: 'utf8', env: hookEnv() });

    expect(devkitCalls()).toHaveLength(2);
    expect(lstatSync(join(wt, '.devkit', 'config.json')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(wt, 'eslint.config.devkit.mjs')).isFile()).toBe(true);
  });

  it.each([
    ['the commit-msg judges', [...SELECTION.guards, 'review'], 1],
    ['a pass-through commit-msg', SELECTION.guards.filter((g) => g !== 'review'), 0],
  ])(
    'under the global husky shim a plain commit runs %s once and the repo hooks once',
    async (_, guards, judged) => {
      const root = workRepo();
      writeFileSync(
        join(root, '.husky', 'commit-msg'),
        '#!/bin/sh\necho commit-msg >> "$DK_TEST_MARKER"\n',
      );
      await applyInit(root, {
        stack: 'react-app',
        selection: { ...SELECTION, guards },
        overlay: true,
        devkitRef: 'v0.9.0',
      });
      huskyReclaim(root);

      commit(root, 'plain', { XDG_CONFIG_HOME: await installShim() });

      expect(markerLines()).toEqual([realpathSync(root), 'commit-msg']);
      const calls = readFileSync(join(home, 'gate-calls'), 'utf8');
      expect(calls.match(/^guard-review completeness --gate/gm) ?? []).toHaveLength(judged);
    },
  );

  it('doctor names a shim an older devkit wrote, and --fix refreshes it', async () => {
    const root = workRepo();
    await initOverlay(root);
    const xdg = await installShim();
    const init = join(xdg, 'husky', 'init.sh');
    const current = readFileSync(init, 'utf8');
    writeFileSync(init, current.replace(/commit-msg/g, 'pre-commit'));

    await withXdg(xdg, () => doctorRun([], root));
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain('predates this devkit');
    await withXdg(xdg, () => doctorRun(['--fix'], root));
    expect(readFileSync(init, 'utf8')).toBe(current);
  });

  it('review’s private worktree and ship’s gate worktree run their own hook and are never projected', async () => {
    const root = workRepo();
    await initOverlay(root);
    withGateInputs(root);
    const review = addWorktree(root);
    cpSync(join(root, '.devkit'), join(review, '.devkit'), { recursive: true });
    const ship = addWorktree(root);
    symlinkSync(join(root, '.devkit'), join(ship, '.devkit'));
    const runHook = (wt: string, hooksPath: string) =>
      testExecFileSync('git', ['-c', `core.hooksPath=${hooksPath}`, 'hook', 'run', 'pre-commit'], {
        cwd: wt,
        encoding: 'utf8',
        env: hookEnv({ DEVKIT_SHIP: '1' }),
      });

    runHook(review, '.devkit/hooks');
    runHook(ship, join(ship, '.devkit', 'hooks'));

    expect(devkitCalls()).toEqual([]);
    for (const wt of [review, ship]) expect(existsSync(join(wt, 'guard.config.json'))).toBe(false);
    expect(lstatSync(join(ship, '.devkit')).isSymbolicLink()).toBe(true);
    expect(markerLines()).toEqual([realpathSync(review), realpathSync(ship)]);
  });

  it('clean never deletes the home’s baselines through a legacy linked .devkit', async () => {
    const root = workRepo();
    await initOverlay(root);
    mkdirSync(join(root, '.devkit', 'baselines'), { recursive: true });
    writeFileSync(join(root, '.devkit', 'baselines', 'size-lines.json'), '{}\n');
    const wt = addWorktree(root);
    symlinkSync(join(root, '.devkit'), join(wt, '.devkit'));

    unprojectOverlay(root, '');

    expect(readFileSync(join(root, '.devkit', 'baselines', 'size-lines.json'), 'utf8')).toBe(
      '{}\n',
    );
    expect(() => lstatSync(join(wt, '.devkit'))).toThrow(); // the link itself is gone
  });

  it('doctor fails until a fresh worktree is projected, and --fix projects every registry input', async () => {
    const root = workRepo();
    await initOverlay(root);
    withGateInputs(root);
    const wt = addWorktree(root);

    expect(await doctorRun([], root)).toBe(1);
    expect(await doctorRun(['--fix'], root)).toBe(0);

    for (const rel of [
      '.devkit/config.json',
      'guard.config.json',
      '.fallowrc.jsonc',
      'docs/decisions',
      '.search-code/index.db',
    ])
      expect(lstatSync(join(wt, rel)).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(wt, '.co-occurrence-allowlist.json')).isFile()).toBe(true);
    expect(lstatSync(join(wt, 'eslint.config.devkit.mjs')).isFile()).toBe(true);
    expect(git(wt, 'status', '--porcelain')).toBe('');
  });

  it('a directory ignored only by a `dir/` line is copied when branch-local and reported when linked', async () => {
    const root = workRepo();
    await initOverlay(root);
    writeFileSync(join(root, 'guard.config.json'), '{}\n');
    for (const dir of ['docs/decisions', '.fallow', 'fallow-baselines']) {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, 'a'), 'a\n');
    }
    const excludeFile = join(root, '.git', 'info', 'exclude');
    const lines = readFileSync(excludeFile, 'utf8').replace(/^fallow-baselines$/m, '');
    writeFileSync(excludeFile, `${lines}\ndocs/decisions/\n.fallow/\n`);
    const wt = addWorktree(root);

    expect(await doctorRun([], root)).toBe(1);
    expect(await doctorRun(['--fix'], root)).toBe(1);

    expect(lstatSync(join(wt, 'fallow-baselines')).isDirectory()).toBe(true);
    for (const rel of ['docs/decisions', '.fallow']) expect(existsSync(join(wt, rel))).toBe(false);
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain(
      '.fallow, docs/decisions cannot be linked from the overlay',
    );
    expect(git(wt, 'status', '--porcelain')).toBe('');

    exclude(root, '/docs/decisions', '.fallow');
    expect(await doctorRun(['--fix'], root)).toBe(0);
    for (const rel of ['docs/decisions', '.fallow'])
      expect(lstatSync(join(wt, rel)).isSymbolicLink()).toBe(true);
    expect(git(wt, 'status', '--porcelain')).toBe('');
  });

  it('a projected worktree that lacks guard.config.json is a gap, and --fix links it', async () => {
    const root = workRepo();
    await initOverlay(root);
    writeFileSync(join(root, 'guard.config.json'), '{}\n');
    const wt = addWorktree(root);
    commit(wt, 'link it');
    rmSync(join(wt, 'guard.config.json'));

    expect(await doctorRun([], root)).toBe(1);
    await doctorRun(['--fix'], root);

    expect(lstatSync(join(wt, 'guard.config.json')).isSymbolicLink()).toBe(true);
  });

  it('a worktree with a legacy linked .devkit and no guard.config.json is a gap, and --fix links it', async () => {
    const root = workRepo();
    await initOverlay(root);
    writeFileSync(join(root, 'guard.config.json'), '{}\n');
    const wt = addWorktree(root);
    symlinkSync(join(root, '.devkit'), join(wt, '.devkit'));

    expect(await doctorRun([], root)).toBe(1);
    expect(await doctorRun(['--fix'], root)).toBe(0);

    expect(lstatSync(join(wt, '.devkit')).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(wt, 'guard.config.json')).isSymbolicLink()).toBe(true);
  });

  it('doctor leaves a sibling checkout with its own overlay unprojected', async () => {
    const root = workRepo();
    await initOverlay(root);
    writeFileSync(join(root, 'guard.config.json'), '{}\n');
    const wt = addWorktree(root);
    mkdirSync(join(wt, '.devkit', 'hooks'), { recursive: true });
    writeFileSync(join(wt, '.devkit', 'hooks', 'pre-commit'), '#!/bin/sh\n', { mode: 0o755 });
    writeFileSync(join(wt, '.devkit', 'config.json'), '{"overlay":true}\n');

    expect(await doctorRun([], root)).toBe(0);
    expect(existsSync(join(wt, 'guard.config.json'))).toBe(false);
  });

  it('projection never links the home’s per-checkout runtime state', async () => {
    const root = workRepo();
    await initOverlay(root);
    const state = [
      'last-ship-gates-x.log',
      'comment-firewall-receipts.json',
      'comment-firewall-receipts.json.generation',
    ];
    for (const name of state) writeFileSync(join(root, '.devkit', name), 'x\n');
    mkdirSync(join(root, '.devkit', 'review-runs'));
    const wt = addWorktree(root);

    await doctorRun(['--fix'], root);

    expect(lstatSync(join(wt, '.devkit', 'config.json')).isSymbolicLink()).toBe(true);
    for (const name of [...state, 'review-runs'])
      expect(existsSync(join(wt, '.devkit', name))).toBe(false);
  });

  it('a hand-made decisions link in the worktree is left as it is', async () => {
    const root = workRepo();
    await initOverlay(root);
    withGateInputs(root);
    const wt = addWorktree(root);
    const elsewhere = mkTmp('overlay-own-decisions-');
    mkdirSync(join(wt, 'docs'), { recursive: true });
    symlinkSync(elsewhere, join(wt, 'docs', 'decisions'));

    expect(await doctorRun(['--fix'], root)).toBe(0);

    expect(readlinkSync(join(wt, 'docs', 'decisions'))).toBe(elsewhere);
    expect(await doctorRun([], root)).toBe(0);
  });

  it('clean unprojects every registry input and keeps a copy the branch changed', async () => {
    const root = workRepo();
    await initOverlay(root);
    withGateInputs(root);
    const wt = addWorktree(root);
    commit(wt, 'link it');
    writeFileSync(join(wt, '.co-occurrence-allowlist.json'), '{"branch": true}\n');

    await cleanRun(['--yes'], root);

    for (const rel of ['.fallowrc.jsonc', 'docs/decisions'])
      expect(existsSync(join(wt, rel))).toBe(false);
    expect(projectionLeftovers(wt)).toEqual([]);
    expect(readFileSync(join(wt, '.co-occurrence-allowlist.json'), 'utf8')).toBe(
      '{"branch": true}\n',
    );
  });

  it('clean never deletes a gate input the worktree’s branch tracks', async () => {
    const root = workRepo();
    writeFileSync(join(root, '.co-occurrence-allowlist.json'), '{}\n');
    git(root, 'add', '.co-occurrence-allowlist.json');
    commit(root, 'track the allowlist');
    await initOverlay(root);
    const wt = addWorktree(root);
    commit(wt, 'link it');

    await cleanRun(['--yes'], root);

    expect(git(wt, 'status', '--porcelain')).toBe('');
  });

  it('clean unprojects worktrees even when guard.config.json does not parse', async () => {
    const root = workRepo();
    await initOverlay(root);
    const wt = addWorktree(root);
    commit(wt, 'link it');
    rmSync(addWorktree(root), { recursive: true, force: true }); // pruned: its path is gone
    writeFileSync(join(root, 'guard.config.json'), '{ not json');

    expect(await cleanRun(['--yes'], root)).toBe(0);

    expect(projectionLeftovers(wt)).toEqual([]);
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toMatch(
      /not valid JSON.* — links to the paths it configures .* delete them by hand/,
    );
  });
});

describe('overlay eslint config across re-init (sc-3791)', () => {
  it('a re-run keeps an outdated or edited overlay, and recreates a deleted one', async () => {
    const root = workRepo();
    const overlayCfg = join(root, ESLINT_OVERLAY_FILE);
    writeFileSync(overlayCfg, legacyEslintOverlayContent('eslint.config.mjs'));
    await initOverlay(root); // non-force, as `devkit upgrade`'s overlay re-sync runs it
    expect(readFileSync(overlayCfg, 'utf8')).toBe(legacyEslintOverlayContent('eslint.config.mjs'));
    rmSync(overlayCfg);
    await initOverlay(root);
    expect(readFileSync(overlayCfg, 'utf8')).toBe(eslintOverlayContent('eslint.config.mjs'));

    const edited = `${eslintOverlayContent('eslint.config.mjs')}// team tweak\n`;
    writeFileSync(overlayCfg, edited);
    await initOverlay(root);
    expect(readFileSync(overlayCfg, 'utf8')).toBe(edited);
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  // The frink-oss shape: the outdated template plus a hand-added block, so init never refreshes it.
  const HAND_EDITED_LEGACY = `${legacyEslintOverlayContent('eslint.config.mjs')}// team tweak\n`;
  const doctorOut = async (root: string) => {
    vi.mocked(console.log).mockClear();
    const code = await doctorRun([], root);
    return { code, out: vi.mocked(console.log).mock.calls.flat().join('\n') };
  };

  it('doctor names a home overlay edited from the outdated template, home remedy first', async () => {
    const root = workRepo();
    await initOverlay(root);
    const healthy = await doctorOut(root);
    expect(healthy.out).not.toContain('outdated devkit template');

    writeFileSync(join(root, ESLINT_OVERLAY_FILE), HAND_EDITED_LEGACY);
    const { code, out } = await doctorOut(root);
    expect(code).toBe(healthy.code); // advisory: never in the exit code
    expect(out).toMatch(
      /eslint\.config\.devkit\.mjs derives from an outdated devkit template.*run `devkit upgrade`; then delete each linked worktree's copy/,
    );

    rmSync(join(root, ESLINT_OVERLAY_FILE));
    await initOverlay(root); // what `devkit upgrade` re-runs
    expect(readFileSync(join(root, ESLINT_OVERLAY_FILE), 'utf8')).toBe(
      eslintOverlayContent('eslint.config.mjs'),
    );
    expect((await doctorOut(root)).out).not.toContain('outdated devkit template');
  });

  it('doctor names a worktree copy left on the outdated template; deleting it and --fix heals', async () => {
    const root = workRepo();
    await initOverlay(root);
    const wt = addWorktree(root);
    commit(wt, 'link it');
    const healthy = await doctorOut(root);
    writeFileSync(join(wt, ESLINT_OVERLAY_FILE), HAND_EDITED_LEGACY);

    const { code, out } = await doctorOut(root);
    expect(code).toBe(healthy.code);
    expect(out).toContain(`${ESLINT_OVERLAY_FILE} in ${realpathSync(wt)} derives from`);
    expect(out).toContain('delete each copy and run `devkit doctor --fix`');

    rmSync(join(wt, ESLINT_OVERLAY_FILE));
    await doctorRun(['--fix'], root);
    expect(readFileSync(join(wt, ESLINT_OVERLAY_FILE), 'utf8')).toBe(
      eslintOverlayContent('eslint.config.mjs'),
    );
    expect((await doctorOut(root)).out).not.toContain('outdated devkit template');

    // Home legacy too: only the home row, because --fix would re-project the home's legacy bytes.
    writeFileSync(join(wt, ESLINT_OVERLAY_FILE), HAND_EDITED_LEGACY);
    writeFileSync(join(root, ESLINT_OVERLAY_FILE), HAND_EDITED_LEGACY);
    const both = (await doctorOut(root)).out;
    expect(both).toContain("run `devkit upgrade`; then delete each linked worktree's copy");
    expect(both).not.toContain('delete each copy and run `devkit doctor --fix`');
  });

  it('a monorepo package reads the overlay under the package, not the git root', () => {
    const root = mkTmp('overlay-legacy-pkg-');
    git(root, 'init', '-q');
    mkdirSync(join(root, 'pkg'));
    writeFileSync(join(root, ESLINT_OVERLAY_FILE), HAND_EDITED_LEGACY); // not the package's
    printLegacyEslintOverlays(root, 'pkg');
    expect(vi.mocked(console.log)).not.toHaveBeenCalled();

    writeFileSync(join(root, 'pkg', ESLINT_OVERLAY_FILE), HAND_EDITED_LEGACY);
    printLegacyEslintOverlays(root, 'pkg');
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain('derives from');
  });

  it('a sibling checkout with its own overlay is told to upgrade there, not to doctor --fix', async () => {
    const root = workRepo();
    await initOverlay(root);
    const wt = addWorktree(root);
    mkdirSync(join(wt, '.devkit', 'hooks'), { recursive: true });
    writeFileSync(join(wt, '.devkit', 'hooks', 'pre-commit'), '#!/bin/sh\n', { mode: 0o755 });
    writeFileSync(join(wt, '.devkit', 'config.json'), '{"overlay":true}\n');
    writeFileSync(join(wt, ESLINT_OVERLAY_FILE), HAND_EDITED_LEGACY);

    const { out } = await doctorOut(root);
    expect(out).toContain(`${ESLINT_OVERLAY_FILE} in ${realpathSync(wt)} derives from`);
    expect(out).toContain('run `devkit upgrade` there');
    expect(out).not.toContain('devkit doctor --fix`');
  });
});
