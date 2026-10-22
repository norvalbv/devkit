import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { dependencyInstallRemedy, LOCKFILES } from '../../gate-engine/coverage/dependencies.mts';

// agents-hooks are copied into consumer repos and cannot import TS, so resolve_pm keeps its own
// lockfile ladder. These checks fail when it drifts from dependencyInstallRemedy in either direction.
const LIB = resolve(import.meta.dirname, '../../agents-hooks/session-edits-lib.sh');
const PREFLIGHT = resolve(import.meta.dirname, '../lib/ship/dependency-preflight.mts');

const root = mkdtempSync(join(tmpdir(), 'lockfile-ladder-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// Stub managers that exit 0 silently: resolve_pm's packageManager probe reads empty and every
// manager passes its `command -v` check, so only the lockfile ladder decides.
const stubs = join(root, 'bin');
mkdirSync(stubs);
for (const pm of ['bun', 'pnpm', 'yarn', 'npm']) {
  writeFileSync(join(stubs, pm), '#!/bin/sh\nexit 0\n');
  chmodSync(join(stubs, pm), 0o755);
}

function bash(script: string, cwd: string): string {
  const env = { PATH: `${stubs}:/usr/bin:/bin` };
  const r = spawnSync('bash', ['-c', script, 'bash', LIB], { cwd, env, encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
}

const singles = LOCKFILES.map((lockfile) => [lockfile]);
const pairs = LOCKFILES.flatMap((a, i) => LOCKFILES.slice(i + 1).map((b) => [a, b]));

describe('resolve_pm and dependencyInstallRemedy share one lockfile ladder', () => {
  it.each([...singles, ...pairs].map((set) => [set.join(' + '), set] as const))(
    '%s',
    (_, lockfiles) => {
      const dir = mkdtempSync(join(root, 'repo-'));
      for (const lockfile of lockfiles) writeFileSync(join(dir, lockfile), '');
      const pm = dependencyInstallRemedy(dir).split(' ')[0];
      expect(bash('. "$1"; resolve_pm', dir)).toBe(pm);
    },
  );

  // A self-referencing symlink makes stat fail with ELOOP, which bash `-f` also reads as absent.
  it.each([
    ['a directory', (path: string) => mkdirSync(path)],
    ['a symlink loop', (path: string) => symlinkSync(path, path)],
  ])('%s named like a lockfile counts for neither ladder', (_, make) => {
    const dir = mkdtempSync(join(root, 'repo-'));
    make(join(dir, 'bun.lock'));
    writeFileSync(join(dir, 'package-lock.json'), '');
    expect(dependencyInstallRemedy(dir)).toBe('npm ci');
    expect(bash('. "$1"; resolve_pm', dir)).toBe('npm');
  });

  it('resolve_pm tests exactly the lockfiles the TS ladder lists', () => {
    const words = bash('. "$1"; declare -f resolve_pm', root).split(/\s+/);
    const tested = words.flatMap((word, i) => (words[i - 1] === '-f' ? [word] : []));
    expect(new Set(tested)).toEqual(new Set(LOCKFILES));
  });

  // With no lockfile, ship prints a generic sentence; its apostrophe must survive the shell.
  it.each([
    [['yarn.lock'], 'yarn install --immutable'],
    [[], "install dependencies with this repo's package manager"],
  ])('dependency-preflight --remedy with %j prints %s', (lockfiles, remedy) => {
    const dir = mkdtempSync(join(root, 'repo-'));
    for (const lockfile of lockfiles) writeFileSync(join(dir, lockfile), '');
    const r = spawnSync(process.execPath, [PREFLIGHT, '--remedy', dir], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(`${remedy}\n`);
  });
});
