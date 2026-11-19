/** bashWrites: the paths a Claude Bash call wrote, read from git status after it ran. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bashWrites } from '../../agents-hooks/edit-targets-lib.mjs';
import { rootRegistry } from './_helpers.mts';

const { mkTmp, cleanup } = rootRegistry();
afterEach(() => {
  vi.unstubAllEnvs();
  cleanup();
});

const GIT_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};
const git = (cwd: string, ...args: string[]) =>
  spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
    cwd,
    env: GIT_ENV,
    encoding: 'utf8',
  });

function repo() {
  const root = mkTmp('bash-writes-');
  writeFileSync(join(root, 'tracked.ts'), 'export const t = 1;\n');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base');
  return root;
}

function write(root: string, rel: string) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), 'x\n');
}

const bash = { tool_name: 'Bash', duration_ms: 500 };

describe('bashWrites', () => {
  it('lists new and rewritten files relative to the root, and nothing for other tools', () => {
    const root = repo();
    write(root, 'src/new.ts');
    write(root, 'tracked.ts');
    expect(bashWrites(bash, root).sort()).toEqual(['src/new.ts', 'tracked.ts']);
    expect(bashWrites({ ...bash, tool_name: 'Edit' }, root)).toEqual([]);
    expect(bashWrites({ tool_name: 'Bash' }, root)).toEqual([]);
  });

  it('lists a file the call copied in with its old mtime kept, as cp -p and mv do', () => {
    const root = repo();
    write(root, 'copied.ts');
    const old = Date.now() / 1000 - 3600;
    utimesSync(join(root, 'copied.ts'), old, old);
    expect(bashWrites(bash, root)).toEqual(['copied.ts']);
  });

  it('drops deleted files and paths --files cannot carry', () => {
    const root = repo();
    unlinkSync(join(root, 'tracked.ts'));
    write(root, 'a,b.ts');
    expect(bashWrites(bash, root)).toEqual([]);
  });

  it('keeps only paths under a root below the git toplevel', () => {
    const root = repo();
    write(root, 'packages/app/src/a.ts');
    write(root, 'other/b.ts');
    expect(bashWrites(bash, join(root, 'packages', 'app'))).toEqual(['src/a.ts']);
  });

  it('reads a git status larger than 1 MiB', () => {
    const root = repo();
    const dir = join(root, 'd'.repeat(200));
    mkdirSync(dir);
    for (let i = 0; i < 5000; i += 1) writeFileSync(join(dir, `file-${i}.ts`), '');
    expect(bashWrites(bash, root)).toHaveLength(5000);
  });

  it('never takes the optional index lock a concurrent commit needs', () => {
    const root = repo();
    write(root, 'src/a.ts');
    const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    const bin = mkTmp('bash-writes-bin-');
    const log = join(bin, 'git.log');
    writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$*" >> '${log}'\nexec '${realGit}' "$@"\n`, {
      mode: 0o755,
    });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    expect(bashWrites(bash, root)).toEqual(['src/a.ts']);
    const gitCalls = readFileSync(log, 'utf8').trim().split('\n');
    expect(gitCalls).toHaveLength(2);
    for (const call of gitCalls) expect(call).toMatch(/^--no-optional-locks /);
  });
});
