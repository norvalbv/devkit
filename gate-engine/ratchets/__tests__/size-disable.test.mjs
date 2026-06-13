import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { countDisables } from '../size-disable.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'size-disable.mjs');

let roots = [];
const makeRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'ratchet-'));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

const write = (root, rel, content) => {
  mkdirSync(join(root, dirname(rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
};
const writeConfig = (root, cfg) =>
  writeFileSync(join(root, 'guard.config.json'), JSON.stringify(cfg));

describe('countDisables', () => {
  it('returns zeros for an empty tree (boundary state)', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'src'));
    expect(countDisables(root)).toEqual({ fileDisables: 0, fnDisables: 0, scannedFiles: 0 });
  });

  it('counts a combined one-line directive in both buckets', () => {
    const root = makeRoot();
    write(root, 'src/a.ts', '/* eslint-disable max-lines, max-lines-per-function */\nexport {};\n');
    const r = countDisables(root);
    expect(r.fileDisables).toBe(1);
    expect(r.fnDisables).toBe(1);
  });

  it('attributes next-line per-function disables to fn only (substring disambiguation)', () => {
    const root = makeRoot();
    write(
      root,
      'src/b.ts',
      '// eslint-disable-next-line max-lines-per-function\nexport const f = () => {};\n',
    );
    expect(countDisables(root)).toMatchObject({ fileDisables: 0, fnDisables: 1 });
  });

  it('ignores mentions inside string literals and prose comments (false-block guard)', () => {
    const root = makeRoot();
    write(
      root,
      'src/c.ts',
      [
        "export const msg = 'adding eslint-disable max-lines is banned';",
        '// note: eslint-disable max-lines must never be added',
        'export {};',
      ].join('\n'),
    );
    expect(countDisables(root)).toMatchObject({ fileDisables: 0, fnDisables: 0 });
  });

  it('counts directives with trailing justification and CRLF line endings (Windows)', () => {
    const root = makeRoot();
    write(root, 'src/d.ts', '/* eslint-disable max-lines -- legacy */\r\nexport {};\r\n');
    expect(countDisables(root)).toMatchObject({ fileDisables: 1, fnDisables: 0 });
  });

  it('excludes test files and skip-dirs from the scan', () => {
    const root = makeRoot();
    writeConfig(root, { scanRoots: ['src', 'vercel-serverless'] });
    write(root, 'src/e.test.ts', '/* eslint-disable max-lines */\nexport {};\n');
    write(root, 'src/node_modules/dep.ts', '/* eslint-disable max-lines */\nexport {};\n');
    write(root, 'vercel-serverless/_shared/m.ts', '/* eslint-disable max-lines */\nexport {};\n');
    expect(countDisables(root)).toMatchObject({ fileDisables: 0, fnDisables: 0, scannedFiles: 0 });
  });

  it('honours config.scanRoots (multi-root, no longer hardcoded)', () => {
    const root = makeRoot();
    writeConfig(root, { scanRoots: ['src', 'socket-server/src'] });
    write(root, 'src/a.ts', '/* eslint-disable max-lines */\nexport {};\n');
    write(root, 'socket-server/src/b.ts', '/* eslint-disable max-lines */\nexport {};\n');
    write(root, 'ignored/c.ts', '/* eslint-disable max-lines */\nexport {};\n'); // not scanned
    const r = countDisables(root);
    expect(r.fileDisables).toBe(2);
    expect(r.scannedFiles).toBe(2);
  });

  it('default scanRoots is ["src"] when no config is present', () => {
    const root = makeRoot();
    write(root, 'src/a.ts', '/* eslint-disable max-lines */\nexport {};\n');
    write(root, 'socket-server/src/b.ts', '/* eslint-disable max-lines */\nexport {};\n');
    const r = countDisables(root);
    expect(r.fileDisables).toBe(1); // only src/ scanned by default
    expect(r.scannedFiles).toBe(1);
  });
});

describe('CLI freeze/gate contract (what a pre-commit hook relies on)', () => {
  const run = (root, cmd) =>
    spawnSync(process.execPath, [SCRIPT, cmd], { cwd: root, encoding: 'utf8' });

  it('freeze writes the generated counts; gate passes when nothing changed', () => {
    const root = makeRoot();
    write(root, 'src/a.ts', '/* eslint-disable max-lines */\nexport {};\n');
    expect(run(root, 'freeze').status).toBe(0);
    const frozen = JSON.parse(readFileSync(join(root, 'eslint/baselines/size.json'), 'utf8'));
    expect(frozen).toEqual({ fileDisables: 1, fnDisables: 0 });
    expect(run(root, 'gate').status).toBe(0);
  });

  it('writes the baseline under the CONSUMER cwd, not the package dir (W-3)', () => {
    const root = makeRoot();
    write(root, 'src/a.ts', '/* eslint-disable max-lines */\nexport {};\n');
    expect(run(root, 'freeze').status).toBe(0);
    expect(() => readFileSync(join(root, 'eslint/baselines/size.json'), 'utf8')).not.toThrow();
  });

  it('gate exits 1 when a NEW file-level disable appears', () => {
    const root = makeRoot();
    write(root, 'src/a.ts', 'export {};\n');
    run(root, 'freeze');
    write(root, 'src/b.ts', '/* eslint-disable max-lines */\nexport {};\n');
    const r = run(root, 'gate');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('may only SHRINK');
  });

  it('gate exits 1 when only the per-function count grows', () => {
    const root = makeRoot();
    write(root, 'src/a.ts', 'export {};\n');
    run(root, 'freeze');
    write(root, 'src/b.ts', '// eslint-disable-next-line max-lines-per-function\nexport {};\n');
    expect(run(root, 'gate').status).toBe(1);
  });

  it('gate exits 0 (with a re-freeze reminder) when counts shrink', () => {
    const root = makeRoot();
    write(root, 'src/a.ts', '/* eslint-disable max-lines */\nexport {};\n');
    run(root, 'freeze');
    write(root, 'src/a.ts', 'export {};\n');
    const r = run(root, 'gate');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('shrank');
  });

  it('gate fails OPEN (exit 2) when the baseline file is missing', () => {
    const root = makeRoot();
    write(root, 'src/a.ts', 'export {};\n');
    expect(run(root, 'gate').status).toBe(2);
  });

  it('unknown command exits 2', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'src'));
    expect(run(root, 'bogus').status).toBe(2);
  });

  it('gate honours config.scanRoots end-to-end (multi-root growth caught)', () => {
    const root = makeRoot();
    writeConfig(root, { scanRoots: ['src', 'socket-server/src'] });
    write(root, 'src/a.ts', 'export {};\n');
    run(root, 'freeze');
    write(root, 'socket-server/src/b.ts', '/* eslint-disable max-lines */\nexport {};\n');
    expect(run(root, 'gate').status).toBe(1);
  });
});
