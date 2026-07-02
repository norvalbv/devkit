/**
 * devkit update — self-update to the latest published tag.
 *
 *   devkit update [--dry-run]        (also: devkit --update / -u)
 *
 * Resolves the highest semver tag from the devkit remote, compares it to the running
 * version, and re-installs if newer. Two modes, auto-detected from the cwd:
 *   - package: `@norvalbv/devkit` is a dep here → re-pin package.json + `bun install`.
 *   - global:  otherwise → `bun remove -g` the old pin, then `bun add -g` the new tag
 *              (a bare `bun add -g` over an existing git pin throws DependencyLoop).
 * bun caches git deps, so we `bun pm cache rm` first.
 *
 * Repo URL defaults to the README form; override with DEVKIT_REPO if your ssh uses a host
 * alias (e.g. DEVKIT_REPO=git+ssh://git@github-personal/norvalbv/devkit.git).
 * Plain .mjs, no build.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEP = '@norvalbv/devkit';
const BUN_REF = process.env.DEVKIT_REPO || 'git+ssh://git@github.com/norvalbv/devkit.git';
const TAG_RE = /refs\/tags\/v(\d+\.\d+\.\d+)\^?\{?\}?\s*$/;
const GIT_PREFIX_RE = /^git\+/; // git ls-remote wants ssh://, not git+ssh://

/** -1 / 0 / 1 comparing two x.y.z strings numerically. */
export function cmpSemver(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
}

/** Highest vX.Y.Z tag from `git ls-remote --tags` output, or null. */
export function latestTag(lsRemoteOutput) {
  const versions = [];
  for (const line of lsRemoteOutput.split('\n')) {
    const m = line.match(TAG_RE);
    if (m) versions.push(m[1]);
  }
  if (!versions.length) return null;
  return versions.sort(cmpSemver).at(-1);
}

/** Rewrite the devkit dep's `#vX.Y.Z` ref in a package.json string to the new version. */
export function repinPackageJson(pkgRaw, version) {
  const re = new RegExp(`("${DEP.replace('/', '\\/')}"\\s*:\\s*"[^"]*#v)\\d+\\.\\d+\\.\\d+(")`);
  return pkgRaw.replace(re, `$1${version}$2`);
}

/**
 * Ordered `bun` invocations for a global-mode update, as `[cmd, ...args]` arg-arrays.
 * The remove MUST precede the add: `bun add -g` throws `DependencyLoop` when the same git
 * package is already pinned in the global manifest, so we drop the old ref first (the caller
 * tolerates the remove failing when devkit is not yet installed globally).
 */
export function globalUpdateCommands(version) {
  return [
    ['bun', ['remove', '-g', DEP]],
    ['bun', ['add', '-g', `${BUN_REF}#v${version}`]],
  ];
}

/**
 * Query the remote for the highest published tag. Returns `{ latest }` (a x.y.z string, or null
 * when the remote has no version tags) or `{ error }` when the remote is unreachable. Shared by
 * `update` and `upgrade` so both resolve the latest tag the same way (single source for the repo URL).
 */
export function fetchLatestTag() {
  const lsUrl = BUN_REF.replace(GIT_PREFIX_RE, '');
  let ls;
  try {
    ls = execFileSync('git', ['ls-remote', '--tags', lsUrl], { encoding: 'utf8' });
  } catch {
    return {
      error: `could not reach the devkit remote (${lsUrl}). If your ssh uses a host alias, set DEVKIT_REPO.`,
    };
  }
  return { latest: latestTag(ls) };
}

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

function currentVersion() {
  return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
}

export const meta = {
  name: 'update',
  summary: 'Self-update devkit to the latest published tag.',
  help: `devkit update — self-update to the latest published tag (also --update / -u).

Usage:
  devkit update [--dry-run]

Re-pins package.json + \`bun install\` if devkit is a dep here, else \`bun add -g\` the new tag
(updates the global CLI). Set DEVKIT_REPO if your ssh uses a host alias.`,
};

// Reason: flat update pipeline: sequential guard-and-return steps (remote unreachable, no tags, up-to-date, --dry-run) plus the package-vs-global mode fork; near-zero nesting, high branch COUNT where each branch is a trivial early-out
// fallow-ignore-next-line complexity
export default async function update(args, cwd) {
  const dryRun = args.includes('--dry-run');
  const current = currentVersion();

  const { latest, error } = fetchLatestTag();
  if (error) {
    console.error(`devkit update: ${error}`);
    return 1;
  }
  if (!latest) {
    console.error('devkit update: no version tags found on the remote.');
    return 1;
  }
  if (cmpSemver(latest, current) <= 0) {
    console.log(`devkit is up to date (v${current}).`);
    return 0;
  }

  const pkgPath = join(cwd, 'package.json');
  let mode = 'global';
  let pkgRaw = null;
  if (existsSync(pkgPath)) {
    pkgRaw = readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(pkgRaw);
    if (pkg.dependencies?.[DEP] || pkg.devDependencies?.[DEP]) mode = 'package';
  }

  console.log(`devkit update: v${current} → v${latest} (${mode} mode)`);
  if (dryRun) {
    console.log('  --dry-run: nothing installed.');
    return 0;
  }

  run('bun', ['pm', 'cache', 'rm'], cwd);
  if (mode === 'package') {
    const repinned = repinPackageJson(pkgRaw, latest);
    if (repinned === pkgRaw) {
      console.error(`devkit update: could not find a "${DEP}" git ref to re-pin in package.json.`);
      return 1;
    }
    writeFileSync(pkgPath, repinned);
    run('bun', ['install'], cwd); // README: use install for a re-pin (bun add can DependencyLoop)
  } else {
    const [removeOld, addNew] = globalUpdateCommands(latest);
    try {
      run(removeOld[0], removeOld[1], cwd); // drop the old pin so `bun add -g` can't DependencyLoop
    } catch {
      // devkit not currently installed globally — nothing to remove, proceed to add
    }
    run(addNew[0], addNew[1], cwd);
  }

  console.log(`✓ devkit updated to v${latest}.`);
  if (mode === 'package') {
    console.log(
      '  Next: `devkit migrate` — reconcile your emitted config files (eslint.config.mjs, guard.config.json) with the new version. Dry-run by default; shows every change before --apply.',
    );
  }
  return 0;
}
