/**
 * Shared test fixtures for the CLI suites. `_`-prefixed so vitest's *.test.mjs glob never picks
 * it up as a suite. Collapses the tmp-repo + subprocess-runner + cleanup boilerplate that every
 * subprocess-style CLI test repeated verbatim.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path to the devkit CLI entry (cli/index.mjs). */
export const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.mts');

const FIXTURE_PKG = { name: 'fx', version: '0.0.0', type: 'module' };

/**
 * Self-cleaning tmp-repo fixtures for one suite:
 *   const { tmpRepo, devkit, cleanup } = tmpRepos('clean-');
 *   afterEach(cleanup);
 *
 * `tmpRepo(pkg?)` makes a fresh tmp dir seeded with a fixture package.json (pass `pkg` for a
 * custom manifest); `devkit(root, ...args)` runs the CLI in it; `cleanup()` rm's every dir made.
 *
 * @param {string} prefix mkdtemp prefix (a per-suite tag, e.g. 'clean-')
 */
export function tmpRepos(prefix) {
  let roots = [];
  const tmpRepo = (pkg = FIXTURE_PKG) => {
    const root = mkdtempSync(join(tmpdir(), prefix));
    roots.push(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2));
    return root;
  };
  const devkit = (root, ...args) =>
    spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8' });
  const cleanup = () => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
    roots = [];
  };
  return { tmpRepo, devkit, cleanup };
}

/** Parse a consumer repo's written `.devkit/config.json`. */
export const readConfig = (root) =>
  JSON.parse(readFileSync(join(root, '.devkit/config.json'), 'utf8'));

/**
 * A tmp-dir registry for suites that build their OWN repo shapes (overlay/standalone/monorepo) and
 * so can't use `tmpRepos`, but still share cleanup. `mkTmp(prefix)` makes + tracks a tmp dir; the
 * suite fills it however it likes; `cleanup()` rm's them all. Pair with `afterEach(cleanup)`.
 */
export function rootRegistry() {
  const roots = [];
  const mkTmp = (prefix) => {
    const root = mkdtempSync(join(tmpdir(), prefix));
    roots.push(root);
    return root;
  };
  const cleanup = () => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
    roots.length = 0;
  };
  return { mkTmp, cleanup };
}

/**
 * Seed a per-session edits ledger for the agents-hooks suites (session-edits-lib.sh). Creates a
 * fixture-LOCAL tmpdir (pass it as TMPDIR to the hook so real machine state never leaks in) and
 * writes `devkit-session-edits/<REPO_KEY>-<sid>` with the given repo-relative paths. REPO_KEY is
 * computed exactly the way the lib does (`pwd -P | cksum`) so the hook resolves the same file.
 * Pass `paths: null` to create the isolated tmpdir WITHOUT a ledger (the no-edits session shape).
 *
 * @param {string} root fixture repo root
 * @param {string} sid session_id the hook payload will carry
 * @param {string[]|null} paths repo-relative edited paths (null → no ledger)
 * @returns {string} the tmpdir to pass as the hook's TMPDIR env
 */
export function seedSessionLedger(root, sid, paths) {
  const tmp = join(root, '.test-tmpdir');
  mkdirSync(join(tmp, 'devkit-session-edits'), { recursive: true });
  if (paths !== null) {
    writeFileSync(
      join(tmp, 'devkit-session-edits', `${repoKey(root)}-${sid}`),
      `${paths.join('\n')}\n`,
    );
  }
  return tmp;
}

/** REPO_KEY exactly as session-edits-lib.sh computes it (`pwd -P | cksum`, first field). */
export const repoKey = (root) =>
  spawnSync('bash', ['-c', 'pwd -P | cksum | cut -d" " -f1'], {
    cwd: root,
    encoding: 'utf8',
  }).stdout.trim();

/**
 * Fixtures for the structure-baseline suites: a self-cleaning tmp repo + a `write(root, rel, content)`
 * helper that mkdir-ps the parent. `const { tmpRepo, write, cleanup } = structFixtures('struct-')`.
 *
 * @param {string} prefix mkdtemp prefix
 */
export function structFixtures(prefix) {
  const { mkTmp, cleanup } = rootRegistry();
  const write = (root, rel, content = 'export {};\n') => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), content);
  };
  return { tmpRepo: () => mkTmp(prefix), write, cleanup };
}
