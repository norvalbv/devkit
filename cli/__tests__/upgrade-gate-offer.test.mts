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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  it('REPORTS a newly-bundled gate without adding it — the recorded selection is authoritative', () => {
    // The recorded `guards` array is the consumer's answer, and a gate absent from it may be absent
    // ON PURPOSE: frink hand-places `decisions` after its free deterministic gates, so devkit
    // re-adding it to the managed block meant a second LLM judge on every commit. Silently healing
    // also left .devkit/config.json saying one thing while the hook did another.
    const root = preQavisFixture();
    const before = guards(root);
    expect(before).not.toContain('qavis-advisory');
    expect(hook(root)).not.toContain('guard-qavis-advisory');

    const up = run(root, 'upgrade');
    expect(up.status, up.stderr || up.stdout).toBe(0);

    // Surfaced loudly...
    expect(up.stdout).toMatch(/qavis-advisory.*recommended/i);
    expect(up.stdout).toMatch(/review.*opt-in/i);
    // ...but neither the config nor the hook was mutated behind the consumer's back.
    expect(guards(root)).toEqual(before);
    expect(hook(root)).not.toContain('guard-qavis-advisory');
  });

  it('a gate deliberately removed from guards STAYS removed across repeated upgrades', () => {
    // The regression this exists for: remove a recommended gate, upgrade twice, and it must not
    // reappear. The non-TTY path used to heal it back on the very next run.
    const root = preQavisFixture();
    const cfgPath = join(root, '.devkit', 'config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.components.guards = (cfg.components.guards as string[]).filter(
      (g: string) => g !== 'decisions',
    );
    writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);

    expect(run(root, 'upgrade').status).toBe(0);
    expect(run(root, 'upgrade').status).toBe(0);

    expect(guards(root)).not.toContain('decisions');
    expect(hook(root)).not.toContain('bunx guard-decisions detect');
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

describe('devkit upgrade — line-growth block back-fill', () => {
  const giant = (root: string) => {
    mkdirSync(join(root, 'src'), { recursive: true });
    // 600 lines (no trailing newline) → over the 500-line cap; must be grandfathered, not hard-error.
    writeFileSync(join(root, 'src', 'giant.ts'), Array(600).fill('const x = 1;').join('\n'));
  };
  const gc = (root: string) => JSON.parse(readFileSync(join(root, 'guard.config.json'), 'utf8'));

  it('non-TTY: enables the cap + grandfathers giants for a repo that predates the block', () => {
    const root = tmpRepo(CLIB_PKG);
    // Legacy shape: size guard on, line-growth block never enabled (no cap).
    expect(
      run(root, 'init', '--stack', 'component-lib', '--yes', '--no-cursor', '--no-line-growth')
        .status,
    ).toBe(0);
    // Simulate a PRE-feature install: drop the recorded lineGrowth key so upgrade treats it as
    // "never offered" (a real legacy config has no such key → normalizeSelection defaults it true).
    const cfgPath = join(root, '.devkit', 'config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    delete cfg.components.lineGrowth;
    writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
    expect(gc(root).maxLines).toBeUndefined();
    giant(root);

    const up = run(root, 'upgrade');
    expect(up.status, up.stderr || up.stdout).toBe(0);

    expect(gc(root).maxLines).toBe(500); // cap written
    const lines = JSON.parse(
      readFileSync(join(root, 'eslint', 'baselines', 'size-lines.json'), 'utf8'),
    );
    expect(lines.files['src/giant.ts']).toBe(600); // giant grandfathered, not hard-erroring
    expect(config(root).components.lineGrowth).toBe(true); // recorded on
    expect(up.stdout).toMatch(/line-growth block enabled/i);
  });

  it('does NOT re-offer once the cap is already set (no re-nag)', () => {
    const root = tmpRepo(CLIB_PKG);
    // A default init already enables the block → the cap is present.
    expect(run(root, 'init', '--stack', 'component-lib', '--yes', '--no-cursor').status).toBe(0);
    expect(gc(root).maxLines).toBe(500);

    const up = run(root, 'upgrade');
    expect(up.status, up.stderr || up.stdout).toBe(0);
    expect(up.stdout).not.toMatch(/3b\. line-growth|line-growth block enabled/i);
  });
});
