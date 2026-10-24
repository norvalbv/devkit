import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupHomes, homes, overlayStagedStep, runHookFragment } from './_husky-hook-harness.mts';

// The overlay eslint step hands each staged path to eslint as ONE exact argument. Without `-z` git
// C-quotes `café.ts`, and `echo | xargs` split `a b.ts` into two paths that do not exist.

afterEach(cleanupHomes);

const HOSTILE_NAMES = ['café.ts', ' lead.ts', 'a b.ts', 'tab\tname.ts', `it's "q".ts`];

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd });

function overlayRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'dk-staged-paths-'));
  homes.push(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'core.quotePath', 'true');
  writeFileSync(join(repo, 'eslint.config.devkit.mjs'), 'export default [];\n');
  const bin = join(repo, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  const log = join(repo, 'eslint.argv');
  writeFileSync(
    join(bin, 'eslint'),
    `#!/bin/sh\nfor a in "$@"; do printf 'ARG[%s]\\n' "$a" >> '${log}'; done\n`,
  );
  chmodSync(join(bin, 'eslint'), 0o755);
  return repo;
}

function stage(repo: string, ...names: string[]) {
  for (const name of names) writeFileSync(join(repo, name), 'export const a = 1;\n');
  git(repo, 'add', '--', ...names);
}

const argvOf = (repo: string) => {
  const log = join(repo, 'eslint.argv');
  return existsSync(log) ? readFileSync(log, 'utf8') : '';
};

describe('overlay eslint step passes staged paths intact (real git, core.quotePath=true)', () => {
  it.each(HOSTILE_NAMES)('%j reaches eslint as one argument', (name) => {
    const repo = overlayRepo();
    stage(repo, name);
    const r = runHookFragment(overlayStagedStep(), { cwd: repo });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(argvOf(repo)).toContain(`ARG[${name}]\n`);
  });

  it('runs eslint not at all when no staged path matches its extensions', () => {
    const repo = overlayRepo();
    stage(repo, 'notes.md');
    const r = runHookFragment(overlayStagedStep(), { cwd: repo });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout).not.toContain('overlay (staged)');
    expect(argvOf(repo)).toBe('');
  });

  // `--relative` scopes the set to a monorepo package the hook has cd'd into.
  it('ignores a staged path outside the package directory it runs from', () => {
    const repo = overlayRepo();
    const pkg = join(repo, 'pkg');
    mkdirSync(pkg);
    for (const f of ['eslint.config.devkit.mjs', 'node_modules']) {
      execFileSync('cp', ['-R', join(repo, f), pkg]);
    }
    stage(repo, 'root.ts');
    const r = runHookFragment(overlayStagedStep(), { cwd: pkg });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(argvOf(repo)).toBe('');
  });
});
