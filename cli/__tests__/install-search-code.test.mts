import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tmpRepos } from './_helpers.mts';

const { tmpRepo, devkit, cleanup } = tmpRepos('sc-');
afterEach(cleanup);

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
