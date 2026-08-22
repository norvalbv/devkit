import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'size-disable.mts');
const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'size-preflight-'));
  roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
  return root;
}

function write(root: string, rel: string, content: string): void {
  mkdirSync(join(root, dirname(rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

function big(lines: number): string {
  return Array(lines).fill('const x = 1;').join('\n');
}

function seedBaseline(root: string): void {
  write(
    root,
    'guard.config.json',
    JSON.stringify({ scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 }),
  );
  write(root, 'src/legacy.ts', big(60));
  write(
    root,
    '.devkit/baselines/size-lines.json',
    JSON.stringify({ maxLines: 50, files: { 'src/legacy.ts': 60 } }),
  );
  execFileSync(
    'git',
    ['add', 'guard.config.json', 'src/legacy.ts', '.devkit/baselines/size-lines.json'],
    { cwd: root },
  );
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
}

function run(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: 'utf8' });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('guard-size base-aware preflight', () => {
  it('rejects growth hidden by a stale working-tree baseline', () => {
    const root = makeRoot();
    seedBaseline(root);
    write(root, 'src/legacy.ts', big(70));
    write(
      root,
      '.devkit/baselines/size-lines.json',
      JSON.stringify({ maxLines: 50, files: { 'src/legacy.ts': 80 } }),
    );

    const result = run(root, 'preflight', '--base', 'HEAD', '--', 'src/legacy.ts');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('max 60; headroom -10; working-tree max 80 differs by 20');
    expect(result.stderr).toContain('working-tree baseline would allow 80');
  });

  it('reads a legacy baseline from a pre-migration base ref', () => {
    const root = makeRoot();
    write(
      root,
      'guard.config.json',
      JSON.stringify({ scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 }),
    );
    write(root, 'src/legacy.ts', big(60));
    write(
      root,
      'eslint/baselines/size-lines.json',
      JSON.stringify({ maxLines: 50, files: { 'src/legacy.ts': 60 } }),
    );
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'legacy base'], { cwd: root });
    rmSync(join(root, 'eslint/baselines/size-lines.json'));
    write(root, 'src/legacy.ts', big(70));
    write(
      root,
      '.devkit/baselines/size-lines.json',
      JSON.stringify({ maxLines: 50, files: { 'src/legacy.ts': 80 } }),
    );

    const result = run(root, 'preflight', '--base', 'HEAD', '--', 'src/legacy.ts');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('max 60; headroom -10; working-tree max 80 differs by 20');
  });

  it('defaults to staged source files and prints remaining headroom', () => {
    const root = makeRoot();
    seedBaseline(root);
    write(root, 'src/legacy.ts', big(55));
    execFileSync('git', ['add', 'src/legacy.ts'], { cwd: root });

    const result = run(root, 'preflight', '--base', 'HEAD');

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('src/legacy.ts: 55 lines; max 60; headroom 5');
  });

  it('ignores files governed by a disabled zero cap', () => {
    const root = makeRoot();
    write(
      root,
      'guard.config.json',
      JSON.stringify({
        scanRoots: ['src'],
        sourceExtensions: ['ts'],
        maxLines: 50,
        maxTestLines: 0,
      }),
    );
    write(root, 'src/example.test.ts', big(5));
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });

    const result = run(root, 'preflight', '--base', 'HEAD', '--', 'src/example.test.ts');

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('no source files in scope: src/example.test.ts');
  });

  it('uses a working baseline that is explicitly included in the ship', () => {
    const root = makeRoot();
    seedBaseline(root);
    write(root, 'src/new.ts', big(70));
    write(
      root,
      '.devkit/baselines/size-lines.json',
      JSON.stringify({ maxLines: 50, files: { 'src/legacy.ts': 60, 'src/new.ts': 70 } }),
    );

    const result = run(
      root,
      'preflight',
      '--base',
      'HEAD',
      '--',
      'src/new.ts',
      '.devkit/baselines/size-lines.json',
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('effective ceilings from working tree');
    expect(result.stdout).toContain('src/new.ts: 70 lines; max 70; headroom 0');
  });

  it('matches the gate by excluding skipped directories and names unmatched paths', () => {
    const root = makeRoot();
    write(
      root,
      'guard.config.json',
      JSON.stringify({ scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 }),
    );
    write(root, 'src/_shared/big.ts', big(70));
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });

    const result = run(root, 'preflight', '--base', 'HEAD', '--', 'src/_shared/big.ts');

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('no source files in scope: src/_shared/big.ts');
  });

  it('classifies source read failures as unavailable instead of a size violation', () => {
    const root = makeRoot();
    write(
      root,
      'guard.config.json',
      JSON.stringify({ scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 }),
    );
    execFileSync('git', ['add', 'guard.config.json'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
    mkdirSync(join(root, 'src/unreadable.ts'), { recursive: true });

    const result = run(root, 'preflight', '--base', 'HEAD', '--', 'src/unreadable.ts');

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('preflight unavailable while reading source files');
  });
});
