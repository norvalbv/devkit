import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { catBlobs } from '../tree-blobs.mts';

const SIZE_GATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'size-disable.mts');

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'tree-blobs-'));
  roots.push(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'blobs@example.test']);
  git(root, ['config', 'user.name', 'Blob Test']);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(root, dirname(file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  git(root, ['add', '-A']);
  return root;
}

describe('catBlobs', () => {
  it('answers every name in input order, null for missing, non-blob and newline names', () => {
    const root = repo({ 'a.ts': 'alpha\n', 'dir/b ts.ts': 'beta\r\n' });
    git(root, ['commit', '-qm', 'base']);
    const read = catBlobs(root, [
      'HEAD:dir/b ts.ts',
      ':a.ts',
      'HEAD:missing.ts',
      'HEAD:dir',
      'HEAD:a\n.ts',
      ':a.ts',
    ]);
    expect(read?.map((blob) => blob?.toString('utf8') ?? null)).toEqual([
      'beta\r\n',
      'alpha\n',
      null,
      null,
      null,
      'alpha\n',
    ]);
  });

  it('reads a name whose path holds a newline, which the batch protocol cannot carry', () => {
    const root = repo({ 'src/a\nb.ts': 'newline\n' });
    git(root, ['commit', '-qm', 'base']);
    const read = catBlobs(root, ['HEAD:src/a\nb.ts', ':src/a\nb.ts', 'HEAD:src/a\nc.ts']);
    expect(read?.map((blob) => blob?.toString('utf8') ?? null)).toEqual([
      'newline\n',
      'newline\n',
      null,
    ]);
  });

  it('is null when git cannot answer at all', () => {
    const root = mkdtempSync(join(tmpdir(), 'tree-blobs-nogit-'));
    roots.push(root);
    expect(catBlobs(root, ['HEAD:a.ts'])).toBeNull();
  });
});

describe('guard-size line ratchet on a large staged file', () => {
  it('measures an in-scope file larger than one MiB instead of skipping it', () => {
    const root = repo({
      'guard.config.json': `${JSON.stringify({ scanRoots: ['src'], maxLines: 500 })}\n`,
      'src/index.ts': 'export const index = 1;\n',
    });
    git(root, ['commit', '-qm', 'base']);
    const lines = Array.from({ length: 60_000 }, (_, i) => `export const value${i} = ${i};`);
    writeFileSync(join(root, 'src/big.ts'), `${lines.join('\n')}\n`);
    git(root, ['add', 'src/big.ts']);
    const run = spawnSync(process.execPath, [SIZE_GATE, 'gate'], { cwd: root, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(1);
    expect(run.stderr).toContain('src/big.ts: 60000 lines (max 500)');
  });

  it('blocks an over-cap staged file whose name holds a newline', () => {
    const root = repo({
      'guard.config.json': `${JSON.stringify({ scanRoots: ['src'], maxLines: 500 })}\n`,
      'src/index.ts': 'export const index = 1;\n',
    });
    git(root, ['commit', '-qm', 'base']);
    const lines = Array.from({ length: 600 }, (_, i) => `export const value${i} = ${i};`);
    writeFileSync(join(root, 'src/a\nb.ts'), `${lines.join('\n')}\n`);
    git(root, ['add', '-A']);
    const run = spawnSync(process.execPath, [SIZE_GATE, 'gate'], { cwd: root, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(1);
    expect(run.stderr).toContain('600 lines (max 500)');
  });

  it('lowers, never drops, the recorded ceiling of a shrinking file whose name holds a newline', () => {
    const file = 'src/a\nb.ts';
    const body = (n: number) =>
      `${Array.from({ length: n }, (_, i) => `const v${i} = ${i};`).join('\n')}\n`;
    const root = repo({
      'guard.config.json': `${JSON.stringify({ scanRoots: ['src'], maxLines: 50 })}\n`,
      [file]: body(80),
    });
    expect(spawnSync(process.execPath, [SIZE_GATE, 'freeze'], { cwd: root }).status).toBe(0);
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', 'base']);
    writeFileSync(join(root, file), body(60));
    git(root, ['add', '-A']);
    const run = spawnSync(process.execPath, [SIZE_GATE, 'gate'], { cwd: root, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    const baseline = JSON.parse(
      readFileSync(join(root, '.devkit/baselines/size-lines.json'), 'utf8'),
    );
    expect(baseline).toMatchObject({ files: { [file]: 60 } });
  });
});
