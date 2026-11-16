import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import antiSlop from '../../../commands/oxc/anti-slop.mts';
import { OVERLAY_ENTRY_REL, syncOxcCapability } from '../oxc/lifecycle.mts';
import { ANTI_SLOP_BASELINE_REL } from './constants.mts';
import { syncAntiSlopCapability } from './lifecycle.mts';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cwd of roots.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

/** One error-severity finding per name; distinct names keep path-free relocation keys distinct. */
const bad = (name: string) => `export function ${name}(value: object) { return value; }\n`;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@test.invalid', ...args], {
    cwd,
    stdio: 'ignore',
  });
}

function repo(files: Record<string, string>, overlay = false): string {
  const cwd = mkdtempSync(join(tmpdir(), 'devkit-anti-slop-prune-'));
  roots.push(cwd);
  git(cwd, 'init', '-q');
  if (overlay) {
    mkdirSync(join(cwd, '.devkit'));
    writeFileSync(join(cwd, '.devkit', 'config.json'), `${JSON.stringify({ overlay: true })}\n`);
    writeFileSync(
      join(cwd, '.git', 'info', 'exclude'),
      `.devkit/\n${OVERLAY_ENTRY_REL}\n${ANTI_SLOP_BASELINE_REL}\n`,
    );
  }
  vi.spyOn(console, 'log').mockImplementation(() => {});
  syncAntiSlopCapability(cwd);
  syncOxcCapability(cwd, { antiSlop: true, overlay });
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(cwd, file, '..'), { recursive: true });
    writeFileSync(join(cwd, file), content);
  }
  expect(run(cwd, 'create').status).toBe(0);
  return cwd;
}

function commit(cwd: string): void {
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', 'base');
}

function run(cwd: string, ...args: string[]) {
  const output: string[] = [];
  const capture = (...parts: unknown[]) => {
    output.push(parts.map(String).join(' '));
  };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
  const status = antiSlop(args, cwd);
  vi.restoreAllMocks();
  return { status, out: output.join('\n') };
}

const files = (cwd: string): string[] => {
  const baseline = JSON.parse(readFileSync(join(cwd, ANTI_SLOP_BASELINE_REL), 'utf8'));
  return baseline.entries.map((entry: { file: string }) => entry.file);
};

describe('anti-slop prune of deleted-file debt', () => {
  it('drops a deleted file while unrelated inherited debt refuses the rest', () => {
    const cwd = repo({ 'gone.ts': bad('gone'), 'kept.ts': bad('kept') });
    writeFileSync(join(cwd, 'untouched.ts'), bad('untouched'));
    commit(cwd);
    git(cwd, 'rm', '-q', 'gone.ts');

    const prune = run(cwd, 'prune');

    expect(prune.status, prune.out).toBe(1);
    expect(prune.out).toContain(
      `dropped 1 finding(s) for deleted file(s); stage ${ANTI_SLOP_BASELINE_REL}`,
    );
    expect(files(cwd)).toEqual(['kept.ts']);
    git(cwd, 'add', ANTI_SLOP_BASELINE_REL);
    const staged = run(cwd, 'check', '--staged');
    expect(staged.status, staged.out).toBe(0);

    writeFileSync(join(cwd, 'gone.ts'), bad('gone'));
    expect(run(cwd, 'check', 'gone.ts').status).toBe(1);
  });

  it('keeps the debt of a pending rename for adopt-renames', () => {
    const cwd = repo({ 'debt.ts': bad('debt') });
    commit(cwd);
    git(cwd, 'mv', 'debt.ts', 'renamed.ts');

    const prune = run(cwd, 'prune');

    expect(prune.status, prune.out).toBe(1);
    expect(prune.out).toContain('baseline unchanged');
    expect(files(cwd)).toEqual(['debt.ts']);
    expect(run(cwd, 'adopt-renames').status).toBe(0);
    expect(files(cwd)).toEqual(['renamed.ts']);
    git(cwd, 'add', ANTI_SLOP_BASELINE_REL);
    expect(run(cwd, 'check', '--staged').status).toBe(0);
  });

  it('keeps the debt of a pending move for adopt-relocations', () => {
    const cwd = repo({ 'source.ts': bad('moved'), 'destination.ts': 'export const d = 1;\n' });
    commit(cwd);
    git(cwd, 'rm', '-q', 'source.ts');
    writeFileSync(join(cwd, 'destination.ts'), `export const d = 1;\n${bad('moved')}`);
    git(cwd, 'add', 'destination.ts');

    const prune = run(cwd, 'prune');

    expect(prune.status, prune.out).toBe(1);
    expect(files(cwd)).toEqual(['source.ts']);
    const adopted = run(cwd, 'adopt-relocations');
    expect(adopted.status, adopted.out).toBe(0);
    expect(files(cwd)).toEqual(['destination.ts']);
    git(cwd, 'add', ANTI_SLOP_BASELINE_REL);
    expect(run(cwd, 'check', '--staged').status).toBe(0);
  });

  it('in overlay, drops a deleted file and keeps a pending move in one write, with no stage hint', () => {
    const cwd = repo(
      {
        'gone.ts': bad('gone'),
        'source.ts': bad('moved'),
        'destination.ts': 'export const d = 1;\n',
      },
      true,
    );
    commit(cwd);
    git(cwd, 'rm', '-q', 'gone.ts', 'source.ts');
    writeFileSync(join(cwd, 'destination.ts'), `export const d = 1;\n${bad('moved')}`);
    git(cwd, 'add', 'destination.ts');

    const prune = run(cwd, 'prune');

    expect(prune.status, prune.out).toBe(1);
    expect(prune.out).toContain(
      'dropped 1 finding(s) for deleted file(s); prune of fixed findings',
    );
    expect(files(cwd)).toEqual(['source.ts']);
    const adopted = run(cwd, 'adopt-relocations');
    expect(adopted.status, adopted.out).toBe(0);
    expect(files(cwd)).toEqual(['destination.ts']);
    const staged = run(cwd, 'check', '--staged');
    expect(staged.status, staged.out).toBe(0);
  });

  it('never drops on a scoped prune, which cannot see a rename leaving its paths', () => {
    const cwd = repo({ 'src/a.ts': bad('a') });
    writeFileSync(join(cwd, 'src/new.ts'), bad('fresh'));
    commit(cwd);
    mkdirSync(join(cwd, 'lib'));
    git(cwd, 'mv', 'src/a.ts', 'lib/a.ts');

    const prune = run(cwd, 'prune', 'src');

    expect(prune.status, prune.out).toBe(1);
    expect(prune.out).toContain('baseline unchanged');
    expect(files(cwd)).toEqual(['src/a.ts']);
  });

  it('still prunes a deleted file normally when no new error exists', () => {
    const cwd = repo({ 'gone.ts': bad('gone'), 'kept.ts': bad('kept') });
    commit(cwd);
    git(cwd, 'rm', '-q', 'gone.ts');

    const prune = run(cwd, 'prune');

    expect(prune.status, prune.out).toBe(0);
    expect(prune.out).toContain('pruned 1 fixed finding(s)');
    expect(files(cwd)).toEqual(['kept.ts']);
  });
});
