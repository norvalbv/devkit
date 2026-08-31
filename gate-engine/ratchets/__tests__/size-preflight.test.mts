import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    JSON.stringify({
      lineCountVersion: 3,
      maxLines: 50,
      files: { 'src/legacy.ts': 60 },
    }),
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
      JSON.stringify({
        lineCountVersion: 3,
        maxLines: 50,
        files: { 'src/legacy.ts': 80 },
      }),
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
    expect(result.stdout).toContain('src/legacy.ts: 70 lines; max 60; headroom -10');
    expect(result.stdout).not.toContain('working-tree max');
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

  it('reports a newline-terminated file at the exact cap without a phantom line', () => {
    const root = makeRoot();
    write(
      root,
      'guard.config.json',
      JSON.stringify({ scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 }),
    );
    write(root, 'src/exact.ts', `${big(50)}\n`);
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });

    const result = run(root, 'preflight', '--base', 'HEAD', '--', 'src/exact.ts');

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('src/exact.ts: 50 lines; max 50; headroom 0');
  });

  it('anchors legacy baseline conversion to the base ref before checking EOF-shape growth', () => {
    const root = makeRoot();
    write(
      root,
      'guard.config.json',
      JSON.stringify({ scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 }),
    );
    write(root, 'src/legacy.ts', `${big(80)}\n`);
    write(
      root,
      '.devkit/baselines/size-lines.json',
      JSON.stringify({ maxLines: 50, files: { 'src/legacy.ts': 81 } }),
    );
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'legacy split-count baseline'], { cwd: root });
    write(root, 'src/legacy.ts', big(81));

    const result = run(root, 'preflight', '--base', 'HEAD', '--', 'src/legacy.ts');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('src/legacy.ts: 81 lines; max 80; headroom -1');
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
      JSON.stringify({
        lineCountVersion: 3,
        maxLines: 50,
        files: { 'src/legacy.ts': 60, 'src/new.ts': 70 },
      }),
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

  it('rejects a working legacy ceiling whose file is absent from the pinned base', () => {
    const root = makeRoot();
    write(
      root,
      'guard.config.json',
      JSON.stringify({ scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 5 }),
    );
    execFileSync('git', ['add', 'guard.config.json'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'base without source'], { cwd: root });
    write(root, 'src/new.ts', big(7));
    write(
      root,
      '.devkit/baselines/size-lines.json',
      JSON.stringify({ maxLines: 5, files: { 'src/new.ts': 10 } }),
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

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('src/new.ts: 7 lines; max 5; headroom -2');
    expect(result.stderr).toContain('src/new.ts: 7 lines (max 5)');
  });

  it('pins a symbolic base before reading its baseline and source', () => {
    const root = makeRoot();
    seedBaseline(root);
    const original = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['branch', 'moving', original], { cwd: root });
    write(root, 'src/legacy.ts', big(80));
    write(
      root,
      '.devkit/baselines/size-lines.json',
      JSON.stringify({
        lineCountVersion: 3,
        maxLines: 50,
        files: { 'src/legacy.ts': 80 },
      }),
    );
    execFileSync('git', ['add', 'src/legacy.ts', '.devkit/baselines/size-lines.json'], {
      cwd: root,
    });
    execFileSync('git', ['commit', '-qm', 'newer moving base'], { cwd: root });
    const moved = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    write(root, 'src/legacy.ts', big(70));

    const bin = join(root, 'test-bin');
    const wrapper = join(bin, 'git');
    mkdirSync(bin);
    writeFileSync(
      wrapper,
      `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const options = { cwd: process.cwd(), encoding: 'utf8', env: process.env };
const result = spawnSync(process.env.DEVKIT_TEST_REAL_GIT, args, options);
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.status === 0 && args[0] === 'rev-parse' && args.at(-1) === 'moving^{commit}') {
  const move = spawnSync(
    process.env.DEVKIT_TEST_REAL_GIT,
    ['branch', '-f', 'moving', process.env.DEVKIT_TEST_MOVE_TO],
    options,
  );
  if (move.status !== 0) {
    if (move.stderr) process.stderr.write(move.stderr);
    process.exit(move.status ?? 1);
  }
}
process.exit(result.status ?? 1);
`,
    );
    chmodSync(wrapper, 0o755);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();

    const result = spawnSync(
      process.execPath,
      [SCRIPT, 'preflight', '--base', 'moving', '--', 'src/legacy.ts'],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          DEVKIT_TEST_MOVE_TO: moved,
          DEVKIT_TEST_REAL_GIT: realGit,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
        },
      },
    );

    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain('src/legacy.ts: 70 lines; max 60; headroom -10');
    expect(
      execFileSync('git', ['rev-parse', 'moving'], { cwd: root, encoding: 'utf8' }).trim(),
    ).toBe(moved);
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
