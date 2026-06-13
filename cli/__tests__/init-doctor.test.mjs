import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.mjs');

let roots = [];
function tmpRepo(pkg = { name: 'fx', version: '0.0.0', type: 'module' }) {
  const root = mkdtempSync(join(tmpdir(), 'init-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2));
  return root;
}
function devkit(root, ...args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8' });
}
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

describe('init (generic)', () => {
  it('emits the generic config set + husky hook + .devkit/config.json', () => {
    const root = tmpRepo();
    const r = devkit(root, 'init', '--stack', 'generic', '--yes');
    expect(r.status).toBe(0);
    for (const f of [
      'guard.config.json',
      'biome.jsonc',
      'tsconfig.json',
      '.husky/pre-commit',
      '.devkit/config.json',
    ]) {
      expect(existsSync(join(root, f)), `${f} should exist`).toBe(true);
    }
    // Generic stack does NOT emit the structure-lint preset.
    expect(existsSync(join(root, 'eslint.config.mjs'))).toBe(false);
    const cfg = JSON.parse(readFileSync(join(root, '.devkit/config.json'), 'utf8'));
    expect(cfg.stack).toBe('generic');
    expect(cfg.steps).not.toContain('structure-baselines');
  });

  it('is idempotent: a second run reports "already wired", writes no new files', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes');
    const before = readFileSync(join(root, 'guard.config.json'), 'utf8');
    const r2 = devkit(root, 'init', '--stack', 'generic', '--yes');
    expect(r2.status).toBe(0);
    expect(r2.stdout).toMatch(/already wired/);
    expect(readFileSync(join(root, 'guard.config.json'), 'utf8')).toBe(before);
  });

  it('--dry-run writes nothing', () => {
    const root = tmpRepo();
    const r = devkit(root, 'init', '--stack', 'generic', '--dry-run', '--yes');
    expect(r.status).toBe(0);
    expect(existsSync(join(root, 'guard.config.json'))).toBe(false);
    expect(existsSync(join(root, '.devkit/config.json'))).toBe(false);
  });

  it('leaves the generic husky structure-lint line commented (no eslint preset)', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes');
    const hook = readFileSync(join(root, '.husky/pre-commit'), 'utf8');
    expect(hook).toMatch(/# bunx eslint src/);
    expect(hook).not.toMatch(/\nbunx eslint src/);
  });
});

describe('doctor', () => {
  it('exits 2 on an uninitialized repo', () => {
    const root = tmpRepo();
    const r = devkit(root, 'doctor');
    expect(r.status).toBe(2);
  });

  it('exits 0 after a successful init', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes');
    const r = devkit(root, 'doctor');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/All checks OK/);
  });
});
