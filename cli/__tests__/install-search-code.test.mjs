import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.mjs');

let roots = [];
function tmpRepo() {
  const root = mkdtempSync(join(tmpdir(), 'sc-'));
  roots.push(root);
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fx', version: '0.0.0', type: 'module' }, null, 2),
  );
  return root;
}
function devkit(root, ...args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8' });
}
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

describe('search-code opt-in component', () => {
  it('--search-code writes the opt-in config + gitignores the index + wires indexPath', () => {
    const root = tmpRepo();
    const r = devkit(root, 'init', '--stack', 'generic', '--yes', '--search-code');
    expect(r.status).toBe(0);
    expect(existsSync(join(root, 'search-code.config.json')), 'opt-in config written').toBe(true);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('.search-code/');
    // generic template ships no indexPath → installSearchCode must INSERT it.
    expect(readFileSync(join(root, 'guard.config.json'), 'utf8')).toContain(
      '"indexPath": ".search-code/index.db"',
    );
    // recorded so clean knows to reverse it.
    const cfg = JSON.parse(readFileSync(join(root, '.devkit/config.json'), 'utf8'));
    expect(cfg.components.searchCode).toBe(true);
  });

  it('is off by default (no --search-code → no config)', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes');
    expect(existsSync(join(root, 'search-code.config.json'))).toBe(false);
  });

  it('clean removes the opt-in config + prunes the gitignore line', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes', '--search-code');
    expect(devkit(root, 'clean', '--yes').status).toBe(0);
    expect(existsSync(join(root, 'search-code.config.json'))).toBe(false);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).not.toContain('.search-code/');
  });
});
