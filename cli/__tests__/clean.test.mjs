import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.mjs');

let roots = [];
function tmpRepo() {
  const root = mkdtempSync(join(tmpdir(), 'clean-'));
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

describe('clean (package mode)', () => {
  it('removes the SYNCED skill files, not just the manifest', () => {
    const root = tmpRepo();
    expect(devkit(root, 'init', '--stack', 'generic', '--yes').status).toBe(0);
    // sanity: init synced skills into .claude + .cursor
    const sample = '.claude/skills/brainstorming';
    expect(existsSync(join(root, sample)), 'skills synced by init').toBe(true);
    expect(existsSync(join(root, '.cursor/skills/brainstorming'))).toBe(true);

    const c = devkit(root, 'clean', '--yes');
    expect(c.status).toBe(0);

    // the regression: clean used to drop only the manifest, leaving the synced files behind.
    expect(existsSync(join(root, sample)), '.claude skill removed').toBe(false);
    expect(existsSync(join(root, '.cursor/skills/brainstorming')), '.cursor skill removed').toBe(
      false,
    );
    expect(existsSync(join(root, '.devkit/skills-manifest.json'))).toBe(false);
    expect(existsSync(join(root, '.devkit'))).toBe(false);
    expect(existsSync(join(root, 'guard.config.json'))).toBe(false);
  });

  it('--dry-run removes nothing', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes');
    const c = devkit(root, 'clean', '--dry-run');
    expect(c.status).toBe(0);
    expect(existsSync(join(root, '.claude/skills/brainstorming'))).toBe(true);
    expect(existsSync(join(root, 'guard.config.json'))).toBe(true);
  });
});
