/**
 * `devkit upgrade` gate reconcile — the fix for a newly-bundled gate being silently dropped.
 *
 * Subprocess-style (no TTY → the non-interactive branch): a repo whose recorded selection predates a
 * now-recommended gate (qavis-advisory) gets it HEALED into the config + husky block on upgrade, and a
 * bundled opt-in gate (review) it never selected is surfaced as a one-line NOTICE but never auto-added.
 * A repo already current on recommended gates is NOT re-nagged about the opt-in one. DEVKIT_REPO points
 * at a bogus URL so the version step's `git ls-remote` fails fast (no network).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLI, readConfig as config, tmpRepos } from './_helpers.mts';

const CLIB_PKG = {
  name: 'fx',
  version: '0.0.0',
  type: 'module',
  peerDependencies: { react: '^18' },
  exports: {},
};

const { tmpRepo, cleanup } = tmpRepos('upgrade-gate-');
afterEach(cleanup);

const run = (root: string, ...args: string[]) =>
  spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, DEVKIT_REPO: 'file:///devkit-nonexistent-xyz' },
  });

const hook = (root: string) => readFileSync(join(root, '.husky', 'pre-commit'), 'utf8');
const guards = (root: string) => config(root).components.guards as string[];

// A component-lib repo whose recorded guard selection excludes qavis-advisory (a pre-promotion
// install) and review — so upgrade sees a recommended gate to heal.
function preQavisFixture() {
  const root = tmpRepo(CLIB_PKG);
  const r = run(
    root,
    'init',
    '--stack',
    'component-lib',
    '--yes',
    '--no-cursor',
    '--guards',
    'size,fanout,dup,clone,decisions',
  );
  expect(r.status, r.stderr || r.stdout).toBe(0);
  return root;
}

describe('devkit upgrade — gate reconcile', () => {
  it('heals a now-recommended gate (qavis) into config + hook and notices opt-in review', () => {
    const root = preQavisFixture();
    expect(guards(root)).not.toContain('qavis-advisory');
    expect(hook(root)).not.toContain('guard-qavis-advisory');

    const up = run(root, 'upgrade');
    expect(up.status, up.stderr || up.stdout).toBe(0);

    // qavis healed into the recorded selection AND re-emitted in the husky block.
    expect(guards(root)).toContain('qavis-advisory');
    expect(hook(root)).toContain('guard-qavis-advisory');
    // review surfaced as an opt-in notice, but NOT added.
    expect(up.stdout).toMatch(/review.*opt-in|opt-in.*review/i);
    expect(guards(root)).not.toContain('review');
  });

  it('does NOT re-nag about opt-in review when the repo is already current on recommended gates', () => {
    // default init now includes qavis (recommended) and excludes review.
    const root = tmpRepo(CLIB_PKG);
    expect(run(root, 'init', '--stack', 'component-lib', '--yes', '--no-cursor').status).toBe(0);
    expect(guards(root)).toContain('qavis-advisory');

    const before = guards(root);
    const up = run(root, 'upgrade');
    expect(up.status, up.stderr || up.stdout).toBe(0);
    expect(up.stdout).toMatch(/no new recommended gates/i);
    expect(up.stdout).not.toMatch(/\breview\b/i); // opt-in gate not re-surfaced
    expect(guards(root)).toEqual(before); // selection unchanged
  });
});
