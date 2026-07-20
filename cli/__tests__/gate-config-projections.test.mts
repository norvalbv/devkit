import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { rootRegistry } from './_helpers.mts';

const linkScript = fileURLToPath(new URL('../lib/ship/link-gate-configs.sh', import.meta.url));
const pathScript = fileURLToPath(new URL('../lib/ship/gate-config-paths.mts', import.meta.url));
const { mkTmp, cleanup } = rootRegistry();

afterEach(cleanup);

function fixture() {
  const parent = mkTmp('gate projection-');
  const root = join(parent, 'target repo');
  const worktree = join(parent, 'gate worktree');
  mkdirSync(root);
  mkdirSync(worktree);
  execFileSync('git', ['init', '-q', root]);
  return { root, worktree };
}

function project(
  root: string,
  worktree: string,
  purpose = 'review',
  extraEnv: NodeJS.ProcessEnv = {},
) {
  return spawnSync(
    '/bin/bash',
    [
      '-c',
      'source "$1"; link_untracked_gate_configs "$2" "$3" "$4"',
      'test',
      linkScript,
      worktree,
      root,
      purpose,
    ],
    { encoding: 'utf8', env: { ...process.env, ...extraEnv } },
  );
}

function configuredPaths(root: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [pathScript, root, ...args], {
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

describe('gate config projections', () => {
  it('selects one configured path without emitting the other gate inputs', () => {
    const { root } = fixture();
    writeFileSync(
      join(root, 'guard.config.json'),
      JSON.stringify({
        indexPath: '.cache/search.db',
        allowlistPath: '.config/allowlist.json',
        decisionsDir: '..decisions',
      }),
    );

    expect(configuredPaths(root)).toBe('.cache/search.db\n.config/allowlist.json\n..decisions\n');
    expect(configuredPaths(root, 'indexPath')).toBe('.cache/search.db\n');
    expect(configuredPaths(root, 'indexPath', '--null')).toBe('.cache/search.db\0');
    expect(configuredPaths(root, 'unknown')).toBe('');

    writeFileSync(join(root, 'guard.config.json'), '{"indexPath":"../outside.db"}\n');
    expect(configuredPaths(root, 'indexPath', '--null')).toBe('');
  });

  it('keeps ship projections as symlinks but makes review projections private copies', () => {
    const ship = fixture();
    writeFileSync(join(ship.root, 'guard.config.json'), '{"scanRoots":["src"]}\n');
    expect(project(ship.root, ship.worktree, 'ship').status).toBe(0);
    expect(lstatSync(join(ship.worktree, 'guard.config.json')).isSymbolicLink()).toBe(true);

    const review = fixture();
    const materialized = join(review.root, 'materialized-config.json');
    writeFileSync(materialized, '{"scanRoots":["src"]}\n');
    symlinkSync(materialized, join(review.root, 'guard.config.json'));
    mkdirSync(join(review.root, 'eslint', 'baselines'), { recursive: true });
    writeFileSync(join(review.root, 'eslint', 'baselines', 'size.json'), '{"max":500}\n');
    const result = project(review.root, review.worktree);
    expect(result.status, result.stderr).toBe(0);
    const projected = join(review.worktree, 'guard.config.json');
    expect(lstatSync(projected).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(review.worktree, 'eslint', 'baselines')).isSymbolicLink()).toBe(false);
    writeFileSync(projected, '{"scanRoots":["runtime"]}\n');
    writeFileSync(join(review.worktree, 'eslint', 'baselines', 'size.json'), '{"max":1}\n');
    expect(readFileSync(materialized, 'utf8')).toContain('src');
    expect(readFileSync(join(review.root, 'eslint', 'baselines', 'size.json'), 'utf8')).toContain(
      '500',
    );
    expect(project(review.root, review.worktree, 'typo').status).toBe(2);
  });

  it('fails review projection closed when configured paths cannot be resolved', () => {
    const { root, worktree } = fixture();
    writeFileSync(join(root, 'guard.config.json'), '{ not: valid json');

    const result = project(root, worktree);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('could not resolve gate config paths');
    expect(() => lstatSync(join(worktree, 'guard.config.json'))).toThrow();
  });

  it('copies the complete SQLite family and isolates runtime writes from the target', () => {
    const { root, worktree } = fixture();
    const indexPath = '.search-code/index\nreview.db';
    const source = join(root, indexPath);
    mkdirSync(join(root, '.search-code'));
    writeFileSync(join(root, 'guard.config.json'), `${JSON.stringify({ indexPath })}\n`);
    for (const [suffix, content] of [
      ['', 'main'],
      ['-wal', 'wal'],
      ['-shm', 'shm'],
      ['-journal', 'journal'],
    ]) {
      writeFileSync(`${source}${suffix}`, content);
    }

    const result = project(root, worktree);

    expect(result.status, result.stderr).toBe(0);
    for (const [suffix, content] of [
      ['', 'main'],
      ['-wal', 'wal'],
      ['-shm', 'shm'],
      ['-journal', 'journal'],
    ]) {
      expect(readFileSync(`${join(worktree, indexPath)}${suffix}`, 'utf8')).toBe(content);
    }
    writeFileSync(`${join(worktree, indexPath)}-wal`, 'runtime');
    expect(readFileSync(`${source}-wal`, 'utf8')).toBe('wal');
  });

  it('rejects a SQLite family that changes between the capture hashes', () => {
    const { root, worktree } = fixture();
    const source = join(root, '.search-code', 'index.db');
    mkdirSync(join(root, '.search-code'));
    writeFileSync(join(root, 'guard.config.json'), '{"indexPath":".search-code/index.db"}\n');
    for (const suffix of ['', '-wal', '-shm', '-journal'])
      writeFileSync(`${source}${suffix}`, suffix);

    const bin = join(root, 'fake-bin');
    const count = join(root, 'git-count');
    const realGit = execFileSync('/bin/bash', ['-c', 'command -v git'], {
      encoding: 'utf8',
    }).trim();
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'git'),
      '#!/bin/sh\nn=$(cat "$FAKE_GIT_COUNT" 2>/dev/null || echo 0)\nn=$((n + 1))\nprintf "%s\\n" "$n" > "$FAKE_GIT_COUNT"\n[ "$n" -eq 5 ] && printf mutation >> "$3"\nexec "$REAL_GIT" "$@"\n',
    );
    chmodSync(join(bin, 'git'), 0o755);

    const result = project(root, worktree, 'review', {
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_GIT_COUNT: count,
      REAL_GIT: realGit,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('SQLite gate index changed during capture; retry.');
  });
});
