import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testSpawnSync as spawnSync } from './_helpers.mts';
import { buildAndRun, ghStub, seedShipRepo } from './_ship-branch-fixture.mts';

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

  // A body larger than any pipe buffer makes reship's pipefail `… | gh pr edit --body-file -` SIGPIPE
  // (141) deterministically unless the stub drains stdin, as real gh does.
  it('ghStub drains a piped `pr edit` body so a pipefail publish cannot SIGPIPE', () => {
    const stub = ghStub('echo https://github.com/acme/app/pull/42');
    const r = spawnSync(
      '/bin/bash',
      ['-c', 'set -o pipefail; head -c 1048576 /dev/zero | gh pr edit u --body-file - >/dev/null'],
      { encoding: 'utf8', env: { ...process.env, PATH: `${stub}:${process.env.PATH}` } },
    );
    expect(r.status, r.stderr).toBe(0);
  });
});
