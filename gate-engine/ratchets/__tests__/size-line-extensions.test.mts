import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { countDisables, countOversized, freezeLines } from '../size-disable.mts';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'size-disable.mts');
const LINES = '.devkit/baselines/size-lines.json';
const roots: string[] = [];

function write(root: string, rel: string, content: string): void {
  mkdirSync(join(root, dirname(rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

function script(lines: number): string {
  return `${Array(lines).fill('echo hi').join('\n')}\n`;
}

/** A committed repo whose 60-line shell script sits over a 50-line cap, baselined at 60. */
function seed(
  maxLinesExtensions?: string[],
  files: Record<string, number> = { 'src/big.sh': 60 },
): string {
  const root = mkdtempSync(join(tmpdir(), 'size-line-ext-'));
  roots.push(root);
  const config = { scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50, maxLinesExtensions };
  write(root, 'guard.config.json', JSON.stringify(config));
  write(root, 'src/big.sh', script(60));
  write(root, LINES, JSON.stringify({ lineCountVersion: 2, maxLines: 50, files }));
  for (const args of [
    ['init', '-q'],
    ['add', '-A'],
    ['-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-qm', 'base'],
  ]) {
    execFileSync('git', args, { cwd: root });
  }
  return root;
}

function run(root: string, ...args: string[]) {
  const { DEVKIT_OVERLAY: _overlay, GUARD_RATCHET_BASE: _base, ...env } = process.env;
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: 'utf8', env });
}

function stage(root: string, rel: string, content: string): void {
  write(root, rel, content);
  execFileSync('git', ['add', rel], { cwd: root });
}

const baseline = (root: string): string => readFileSync(join(root, LINES), 'utf8');

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('maxLinesExtensions', () => {
  it('blocks one added line on a grandfathered oversized shell script', () => {
    const root = seed(['sh']);
    stage(root, 'src/big.sh', script(61));

    const gate = run(root, 'gate');
    expect(gate.status, gate.stdout).toBe(1);
    expect(gate.stdout + gate.stderr).toContain('src/big.sh');

    const preflight = run(root, 'preflight', '--base', 'HEAD');
    expect(preflight.status).toBe(1);
    expect(preflight.stdout).toContain('src/big.sh: 61 lines; max 60; headroom -1');
  });

  it('leaves shell scripts ungoverned when the key is unset', () => {
    const root = seed();
    stage(root, 'src/big.sh', script(61));

    const gate = run(root, 'gate');
    expect(gate.status, gate.stderr).toBe(0);
  });

  it('keeps shell and source entries through a freeze', () => {
    const root = seed(['sh']);
    write(root, 'src/big.ts', script(70));

    expect(countOversized(root)).toEqual([
      { file: 'src/big.sh', lines: 60 },
      { file: 'src/big.ts', lines: 70 },
    ]);
    expect(freezeLines(root, 'refresh')).toBe(2);
    expect(JSON.parse(baseline(root)).files).toEqual({ 'src/big.sh': 60, 'src/big.ts': 70 });
  });

  it('counts no eslint-disable debt in a shell script', () => {
    const root = seed(['sh']);
    write(root, 'src/big.sh', `# eslint-disable max-lines\n${script(59)}`);

    expect(countDisables(root).perFile).toEqual({});
    expect(run(root, 'freeze').status).toBe(0);
    expect(existsSync(join(root, '.devkit/baselines/size.json'))).toBe(false);
  });

  it('lowers the ceiling when a grandfathered shell script shrinks', () => {
    const root = seed(['sh']);
    stage(root, 'src/big.sh', script(55));

    const gate = run(root, 'gate');
    expect(gate.status, gate.stderr).toBe(0);
    expect(JSON.parse(baseline(root)).files).toEqual({ 'src/big.sh': 55 });
  });

  it('blocks an edit to an unlisted oversized script until a freeze lists it', () => {
    const root = seed(['sh'], { 'src/other.ts': 60 });
    stage(root, 'src/big.sh', script(60).replace('echo hi', 'echo yo'));
    expect(run(root, 'gate').status).toBe(1);

    expect(run(root, 'freeze').status).toBe(0);
    execFileSync('git', ['add', LINES], { cwd: root });
    const gate = run(root, 'gate');
    expect(gate.status, gate.stdout + gate.stderr).toBe(0);
  });

  it('enforces a committed overgrowth on a clean-index audit', () => {
    const root = seed(['sh']);
    stage(root, 'src/big.sh', script(61));
    execFileSync('git', ['-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-qm', 'grow'], {
      cwd: root,
    });

    const gate = run(root, 'gate');
    expect(gate.status, gate.stdout).toBe(1);
    expect(gate.stdout + gate.stderr).toContain('src/big.sh');
  });
});
