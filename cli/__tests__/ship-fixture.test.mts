import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAndRun, seedShipRepo } from './_ship-branch-fixture.mts';

describe('ship repository fixtures', () => {
  it('preserves literal origin arguments, a clean base, and the installed commit hook', () => {
    const origin = 'git@github.com:acme/app\'";$(false).git';
    const { dir, git } = seedShipRepo({ origin, hookBody: 'exit 37' });
    expect(git(['remote', 'get-url', 'origin']).trim()).toBe(origin);
    expect(git(['branch', '--show-current']).trim()).toBe('work');
    expect(git(['status', '--porcelain', '--untracked-files=no']).trim()).toBe('');
    expect(git(['show', 'HEAD:.gitignore'])).toBe('.devkit/ship-intent-*\n');
    expect(git(['config', 'core.hooksPath']).trim()).toBe('.husky/_');
    writeFileSync(join(dir, 'note.txt'), 'hook must still run\n');
    git(['add', 'note.txt']);
    expect(() => git(['commit', '-qm', 'must be blocked'])).toThrow();
    expect(git(['log', '-1', '--format=%s']).trim()).toBe('base');
  });

  it('passes the branch as a literal argument through the real ship resolver', () => {
    const branch = 'topic/quote\'";$value';
    const result = buildAndRun(branch, 'git@github.com:acme/app.git');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`BASE_REF=${branch}\n`);
  });
});
