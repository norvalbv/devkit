/**
 * `devkit upgrade` — end-to-end reconcile of a consumer repo (the frink-primitives repro shape).
 *
 * Subprocess-style (like init-doctor.test): a real component-lib repo built by `init`, then drifted
 * (stale pin, behind devkitRef, hand-tuned tsconfig, a drifted skill), then `upgrade` must return
 * doctor-clean in ONE invocation. DEVKIT_REPO is pointed at a bogus URL so `git ls-remote` fails
 * fast (no network) → upgrade takes the installed==latest reconcile path deterministically.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CLI, readConfig as config, tmpRepos } from './_helpers.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const V = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
const DEP = '@norvalbv/devkit';
const CLIB_PKG = {
  name: 'fx',
  version: '0.0.0',
  type: 'module',
  peerDependencies: { react: '^18' },
  exports: {},
};

const { tmpRepo, cleanup } = tmpRepos('upgrade-');
afterEach(cleanup);

// Runner with a bogus remote so the version step never hits the network — upgrade tolerates the
// unreachable remote and reconciles against the installed version.
const run = (root, ...args) =>
  spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, DEVKIT_REPO: 'file:///devkit-nonexistent-xyz' },
  });

const read = (p) => readFileSync(p, 'utf8');
const readPkg = (root) => JSON.parse(read(join(root, 'package.json')));
const devkitRef = (root) => readPkg(root).devDependencies[DEP];

// A doctor-clean component-lib repo on the given agent surface(s). Defaults to claude-only.
function initFixture(extraFlags = ['--no-cursor']) {
  const root = tmpRepo(CLIB_PKG);
  const r = run(root, 'init', '--stack', 'component-lib', '--yes', '--agent-hooks', ...extraFlags);
  expect(r.status, r.stderr || r.stdout).toBe(0);
  return root;
}

// Stale the recorded refs (failure mode a) + record the tsconfig override, then hand-tune tsconfig.
function driftRepo(root) {
  const pkg = readPkg(root);
  pkg.devDependencies[DEP] = 'git+ssh://git@github.com/norvalbv/devkit.git#v0.16.0';
  writeFileSync(join(root, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

  const cfg = config(root);
  cfg.devkitRef = 'v0.15.0';
  cfg.configOverrides = ['tsconfig.json'];
  writeFileSync(join(root, '.devkit', 'config.json'), `${JSON.stringify(cfg, null, 2)}\n`);

  // A hand-tuned, no-devkit-extends tsconfig — an intentional override (recorded above).
  writeFileSync(
    join(root, 'tsconfig.json'),
    `${JSON.stringify({ compilerOptions: { strict: true }, include: ['src'] }, null, 2)}\n`,
  );
}

// Mutate a synced skill's consumer copy so checkSkills sees drift (upgrade must re-sync it).
function driftFirstSkill(root) {
  const manifest = JSON.parse(read(join(root, '.devkit', 'skills-manifest.json')));
  const rel = Object.keys(manifest.files)[0];
  const p = join(root, '.claude', 'skills', rel);
  writeFileSync(p, `${read(p)}\n// local drift\n`);
  return rel;
}

describe('devkit upgrade — full reconcile (component-lib repro)', () => {
  it('one invocation → doctor-clean: re-pins, bumps devkitRef, re-syncs, no .cursor re-added', () => {
    const root = initFixture(['--no-cursor']); // claude-only
    driftRepo(root);
    driftFirstSkill(root);

    const up = run(root, 'upgrade');
    expect(up.status, up.stderr || up.stdout).toBe(0); // doctor exit — the whole repo is clean

    // pin + devkitRef reconciled to the installed version.
    expect(devkitRef(root)).toMatch(new RegExp(`#v${V.replace(/\./g, '\\.')}$`));
    expect(config(root).devkitRef).toBe(`v${V}`);
    // consumer opt-out survived the config rewrite (2c).
    expect(config(root).configOverrides).toEqual(['tsconfig.json']);
    // claude-only honoured — no .cursor surface created.
    expect(existsSync(join(root, '.cursor'))).toBe(false);
  });

  it('is idempotent: a second upgrade writes nothing and stays clean', () => {
    const root = initFixture(['--no-cursor']);
    driftRepo(root);
    run(root, 'upgrade');

    const pkgBefore = read(join(root, 'package.json'));
    const cfgBefore = read(join(root, '.devkit', 'config.json'));
    const up2 = run(root, 'upgrade');
    expect(up2.status).toBe(0);
    expect(read(join(root, 'package.json'))).toBe(pkgBefore);
    expect(read(join(root, '.devkit', 'config.json'))).toBe(cfgBefore);
  });

  it('--dry-run writes nothing (stale pin unchanged) and skips the verify', () => {
    const root = initFixture(['--no-cursor']);
    driftRepo(root);
    const before = read(join(root, 'package.json'));

    const up = run(root, 'upgrade', '--dry-run');
    expect(up.status).toBe(0);
    expect(up.stdout).toMatch(/dry-run/i);
    expect(read(join(root, 'package.json'))).toBe(before); // still #v0.16.0
    expect(config(root).devkitRef).toBe('v0.15.0'); // unchanged
  });

  it('infers a claude-only surface from disk when agentTargets is absent (legacy config)', () => {
    const root = initFixture(['--no-cursor']);
    const cfg = config(root);
    delete cfg.components.agentTargets; // simulate a pre-agentTargets config
    writeFileSync(join(root, '.devkit', 'config.json'), `${JSON.stringify(cfg, null, 2)}\n`);

    const up = run(root, 'upgrade');
    expect(up.status, up.stderr || up.stdout).toBe(0);
    expect(existsSync(join(root, '.cursor'))).toBe(false); // not re-added
  });
});

describe('devkit upgrade — preflight', () => {
  it('exits 2 on an uninitialized repo', () => {
    const root = tmpRepo(CLIB_PKG);
    expect(run(root, 'upgrade').status).toBe(2);
  });
});
