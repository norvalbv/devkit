import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FANOUT_BASELINE,
  LEGACY_LINES_BASELINE,
  LINES_BASELINE,
  migrateRatchetBaselines,
  readRatchetBaseline,
  SIZE_BASELINE,
  writeRatchetBaseline,
} from '../baseline-paths.mts';

let roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ratchet-baselines-'));
  roots.push(root);
  return root;
}

function write(root: string, relativePath: string, contents: string): void {
  const file = join(root, relativePath);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, contents);
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe('ratchet baseline paths', () => {
  it('keeps engine-neutral ratchets under .devkit', () => {
    expect([FANOUT_BASELINE, LINES_BASELINE, SIZE_BASELINE]).toEqual([
      '.devkit/baselines/fanout.json',
      '.devkit/baselines/size-lines.json',
      '.devkit/baselines/size.json',
    ]);
  });

  it('writes canonical state unless a legacy baseline actually exists', () => {
    const root = makeRoot();
    expect(readRatchetBaseline(root, LINES_BASELINE, LEGACY_LINES_BASELINE)).toBeNull();
    write(root, LEGACY_LINES_BASELINE, '{"files":{}}\n');
    expect(readRatchetBaseline(root, LINES_BASELINE, LEGACY_LINES_BASELINE)?.relativePath).toBe(
      LEGACY_LINES_BASELINE,
    );
    write(root, LINES_BASELINE, '{"files":{}}\n');
    expect(readRatchetBaseline(root, LINES_BASELINE, LEGACY_LINES_BASELINE)?.relativePath).toBe(
      LINES_BASELINE,
    );
  });

  it('moves legacy ratchets byte-for-byte and is idempotent', () => {
    const root = makeRoot();
    const bytes = '{"files":{"src/legacy.ts":731}}\n';
    write(root, 'eslint/baselines/size-lines.json', bytes);

    expect(migrateRatchetBaselines(root)).toEqual([
      {
        from: 'eslint/baselines/size-lines.json',
        kind: 'moved',
        to: LINES_BASELINE,
      },
    ]);
    expect(readFileSync(join(root, LINES_BASELINE), 'utf8')).toBe(bytes);
    expect(existsSync(join(root, 'eslint/baselines/size-lines.json'))).toBe(false);
    expect(migrateRatchetBaselines(root)).toEqual([]);
  });

  it('stages both sides of a tracked baseline move', () => {
    const root = makeRoot();
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    write(root, LEGACY_LINES_BASELINE, '{"files":{"src/legacy.ts":731}}\n');
    execFileSync('git', ['add', LEGACY_LINES_BASELINE], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'legacy baseline'], { cwd: root });

    migrateRatchetBaselines(root);

    const staged = execFileSync('git', ['diff', '--cached', '--name-status'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(staged).toContain(LEGACY_LINES_BASELINE);
    expect(staged).toContain(LINES_BASELINE);
  });

  it('stops before deleting tracked debt when the canonical baseline is ignored', () => {
    const root = makeRoot();
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    write(root, '.gitignore', '.devkit/\n');
    write(root, LEGACY_LINES_BASELINE, '{"files":{"src/legacy.ts":731}}\n');
    execFileSync('git', ['add', '.gitignore', LEGACY_LINES_BASELINE], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'legacy baseline'], { cwd: root });

    expect(() => migrateRatchetBaselines(root)).toThrow(`${LINES_BASELINE} is ignored by Git`);
    expect(existsSync(join(root, LEGACY_LINES_BASELINE))).toBe(true);
    expect(existsSync(join(root, LINES_BASELINE))).toBe(false);
    expect(
      execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' }),
    ).toBe('');
  });

  it('stops a package gate write before deleting legacy debt when canonical is ignored', () => {
    const root = makeRoot();
    execFileSync('git', ['init', '-q'], { cwd: root });
    write(root, '.gitignore', '.devkit/\n');
    write(root, LEGACY_LINES_BASELINE, '{"files":{"src/legacy.ts":80}}\n');

    expect(() =>
      writeRatchetBaseline(
        root,
        LINES_BASELINE,
        LEGACY_LINES_BASELINE,
        '{"files":{"src/legacy.ts":70}}\n',
      ),
    ).toThrow(`${LINES_BASELINE} is ignored by Git`);
    expect(existsSync(join(root, LEGACY_LINES_BASELINE))).toBe(true);
    expect(existsSync(join(root, LINES_BASELINE))).toBe(false);
  });

  it('keeps ignored canonical writes available to deliberately untracked overlay mode', () => {
    const root = makeRoot();
    execFileSync('git', ['init', '-q'], { cwd: root });
    write(root, '.gitignore', '.devkit/\n');
    write(root, '.devkit/config.json', '{"overlay":true}\n');
    write(root, LEGACY_LINES_BASELINE, '{"files":{"src/legacy.ts":80}}\n');

    writeRatchetBaseline(
      root,
      LINES_BASELINE,
      LEGACY_LINES_BASELINE,
      '{"files":{"src/legacy.ts":70}}\n',
    );

    expect(readFileSync(join(root, LINES_BASELINE), 'utf8')).toContain('70');
    expect(existsSync(join(root, LEGACY_LINES_BASELINE))).toBe(false);
  });

  it('allows the ship worktree canonical baseline symlink', () => {
    const root = makeRoot();
    const linked = makeRoot();
    execFileSync('git', ['init', '-q'], { cwd: root });
    write(root, '.gitignore', '.devkit/\n');
    mkdirSync(join(root, '.devkit'), { recursive: true });
    symlinkSync(linked, join(root, '.devkit/baselines'));

    writeRatchetBaseline(
      root,
      LINES_BASELINE,
      LEGACY_LINES_BASELINE,
      '{"files":{"src/legacy.ts":70}}\n',
      { stage: true },
    );

    expect(readFileSync(join(linked, 'size-lines.json'), 'utf8')).toContain('70');
  });

  it('finishes index staging after an interrupted filesystem move', () => {
    const root = makeRoot();
    const bytes = '{"files":{"src/legacy.ts":731}}\n';
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    write(root, LEGACY_LINES_BASELINE, bytes);
    execFileSync('git', ['add', LEGACY_LINES_BASELINE], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'legacy baseline'], { cwd: root });
    write(root, LINES_BASELINE, bytes);
    rmSync(join(root, LEGACY_LINES_BASELINE));

    expect(migrateRatchetBaselines(root)).toEqual([
      { from: LEGACY_LINES_BASELINE, kind: 'moved', to: LINES_BASELINE },
    ]);
    const staged = execFileSync('git', ['diff', '--cached', '--name-status'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(staged).toContain(LEGACY_LINES_BASELINE);
    expect(staged).toContain(LINES_BASELINE);
  });

  it('is idempotent across concurrent migration processes', async () => {
    const root = makeRoot();
    const bytes = '{"files":{"src/legacy.ts":731}}\n';
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    write(root, LEGACY_LINES_BASELINE, bytes);
    execFileSync('git', ['add', LEGACY_LINES_BASELINE], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'legacy baseline'], { cwd: root });
    write(
      root,
      'migrate.mjs',
      `import { migrateRatchetBaselines } from ${JSON.stringify(new URL('../baseline-paths.mts', import.meta.url).href)};\nmigrateRatchetBaselines(process.argv[2]);\n`,
    );
    const run = () =>
      new Promise<{ code: number | null; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, [join(root, 'migrate.mjs'), root], { cwd: root });
        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk;
        });
        child.on('close', (code) => resolve({ code, stderr }));
      });

    const results = await Promise.all(Array.from({ length: 8 }, run));

    expect(results).toEqual(Array.from({ length: 8 }, () => ({ code: 0, stderr: '' })));
    expect(readFileSync(join(root, LINES_BASELINE), 'utf8')).toBe(bytes);
    expect(existsSync(join(root, LEGACY_LINES_BASELINE))).toBe(false);
  });

  it('converges when a gate write races migration', async () => {
    const root = makeRoot();
    const prior = '{"files":{"src/legacy.ts":80}}\n';
    const tightened = '{"files":{"src/legacy.ts":70}}\n';
    write(root, LEGACY_LINES_BASELINE, prior);
    write(
      root,
      'race.mjs',
      `import { migrateRatchetBaselines, writeRatchetBaseline, LINES_BASELINE, LEGACY_LINES_BASELINE } from ${JSON.stringify(new URL('../baseline-paths.mts', import.meta.url).href)};\nif (process.argv[3] === 'write') writeRatchetBaseline(process.argv[2], LINES_BASELINE, LEGACY_LINES_BASELINE, ${JSON.stringify(tightened)}); else migrateRatchetBaselines(process.argv[2]);\n`,
    );
    const run = (mode: 'migrate' | 'write') =>
      new Promise<{ code: number | null; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, [join(root, 'race.mjs'), root, mode], { cwd: root });
        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk;
        });
        child.on('close', (code) => resolve({ code, stderr }));
      });

    const results = await Promise.all([
      ...Array.from({ length: 4 }, () => run('migrate')),
      ...Array.from({ length: 4 }, () => run('write')),
    ]);

    expect(results).toEqual(Array.from({ length: 8 }, () => ({ code: 0, stderr: '' })));
    expect(readFileSync(join(root, LINES_BASELINE), 'utf8')).toBe(tightened);
    expect(existsSync(join(root, LEGACY_LINES_BASELINE))).toBe(false);
  });

  it('removes an equal legacy duplicate without rewriting the canonical copy', () => {
    const root = makeRoot();
    const bytes = '{"cap":12,"dirs":{}}\n';
    write(root, FANOUT_BASELINE, bytes);
    write(root, 'eslint/baselines/fanout.json', bytes);

    expect(migrateRatchetBaselines(root)).toEqual([
      {
        from: 'eslint/baselines/fanout.json',
        kind: 'removed-duplicate',
        to: FANOUT_BASELINE,
      },
    ]);
    expect(readFileSync(join(root, FANOUT_BASELINE), 'utf8')).toBe(bytes);
    expect(existsSync(join(root, 'eslint/baselines/fanout.json'))).toBe(false);
  });

  it('treats differently formatted JSON with the same debt as an equal duplicate', () => {
    const root = makeRoot();
    const canonical = '{\n  "files": {\n    "src/a.ts": 500\n  }\n}\n';
    write(root, LINES_BASELINE, canonical);
    write(root, LEGACY_LINES_BASELINE, '{"files":{"src/a.ts":500}}');

    expect(migrateRatchetBaselines(root)).toEqual([
      { from: LEGACY_LINES_BASELINE, kind: 'removed-duplicate', to: LINES_BASELINE },
    ]);
    expect(readFileSync(join(root, LINES_BASELINE), 'utf8')).toBe(canonical);
    expect(existsSync(join(root, LEGACY_LINES_BASELINE))).toBe(false);
  });

  it('fails before changing anything when legacy and canonical debt conflict', () => {
    const root = makeRoot();
    write(root, LINES_BASELINE, '{"files":{"src/a.ts":500}}\n');
    write(root, 'eslint/baselines/size-lines.json', '{"files":{"src/a.ts":700}}\n');
    write(root, 'eslint/baselines/size.json', '{"files":{}}\n');

    expect(() => migrateRatchetBaselines(root)).toThrow(
      'both eslint/baselines/size-lines.json and .devkit/baselines/size-lines.json exist with different contents',
    );
    expect(existsSync(join(root, 'eslint/baselines/size.json'))).toBe(true);
    expect(existsSync(join(root, SIZE_BASELINE))).toBe(false);
  });

  it('reports dry-run moves without changing the repository', () => {
    const root = makeRoot();
    write(root, 'eslint/baselines/size.json', '{"files":{}}\n');

    expect(migrateRatchetBaselines(root, { dryRun: true })).toEqual([
      { from: 'eslint/baselines/size.json', kind: 'moved', to: SIZE_BASELINE },
    ]);
    expect(existsSync(join(root, 'eslint/baselines/size.json'))).toBe(true);
    expect(existsSync(join(root, SIZE_BASELINE))).toBe(false);
  });
});
