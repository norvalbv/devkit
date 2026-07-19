/**
 * devkit update — self-update to the latest published tag.
 *
 *   devkit update [--dry-run]        (also: devkit --update / -u)
 *
 * Resolves the highest semver tag from the devkit remote and re-installs if newer. "Newer" is judged
 * against what the REPO resolves in package mode (its node_modules dep, else the pinned #v tag) and
 * against the running CLI in global mode. Two modes, auto-detected from the cwd:
 *   - package: `@norvalbv/devkit` is a dep here → re-pin package.json + `bun install`.
 *   - global:  otherwise → `bun add -g` the new tag (updates the global CLI on PATH).
 * bun caches git deps, so we `bun pm cache rm` first.
 *
 * Repo URL defaults to git+https — the repo is public, so https needs no auth and (unlike git+ssh,
 * which bun can't reliably clone) always resolves. Override with DEVKIT_REPO for a private fork or an
 * ssh host alias (e.g. DEVKIT_REPO=git+ssh://git@github-personal/norvalbv/devkit.git).
 * TypeScript source, shipped as prebuilt .mjs.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from '../lib/fs-helpers.mjs';
export const DEP = '@norvalbv/devkit';
/**
 * The devkit git remote for `git ls-remote` + `bun add`. Defaults to git+https: the repo is public,
 * so https needs no auth AND bun can clone it (bun's git+ssh clone fails on machines whose ssh auth
 * doesn't reach bun's spawned git). DEVKIT_REPO overrides it — set a git+ssh URL for a private fork
 * or an ssh host alias.
 */
export function repoUrl(env = process.env) {
    return env.DEVKIT_REPO || 'git+https://github.com/norvalbv/devkit.git';
}
const BUN_REF = repoUrl();
const TAG_RE = /refs\/tags\/v(\d+\.\d+\.\d+)\^?\{?\}?\s*$/;
const GIT_PREFIX_RE = /^git\+/; // git ls-remote wants a bare URL (https:// / ssh://), not the git+ prefix
const PIN_RE = /#v(\d+\.\d+\.\d+)/; // the #vX.Y.Z tag pinned on the devkit dep in package.json
/** -1 / 0 / 1 comparing two x.y.z strings numerically. */
export function cmpSemver(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
}
/**
 * The version `update` compares against the latest published tag. Package mode measures what the REPO
 * resolves (its node_modules dep, else the #v tag pinned in package.json) — NOT the running CLI, so a
 * global CLI ahead of the repo's pin still reconciles the repo. Global mode measures the running CLI
 * (self-update of the binary on PATH).
 */
export function installedVersion(o) {
    return o.mode === 'package' ? (o.repoDep ?? o.pinned ?? o.running) : o.running;
}
/**
 * After installing a newer published tag, a re-run is needed only when the RUNNING CLI is itself
 * behind that tag — it can't hot-swap to code it just installed. A running CLI already ≥ latest (e.g.
 * the global CLI on PATH) has latest templates, so the caller can reconcile in the same pass. An
 * unknown running version is treated conservatively as needing a re-run.
 */
export function needsRerun(latest, running) {
    return !running || cmpSemver(latest, running) > 0;
}
/** Highest vX.Y.Z tag from `git ls-remote --tags` output, or null. */
export function latestTag(lsRemoteOutput) {
    const versions = [];
    for (const line of lsRemoteOutput.split('\n')) {
        const m = line.match(TAG_RE);
        if (m)
            versions.push(m[1]);
    }
    if (!versions.length)
        return null;
    return versions.sort(cmpSemver).at(-1) ?? null;
}
/** Rewrite the devkit dep's `#vX.Y.Z` ref in a package.json string to the new version. */
export function repinPackageJson(pkgRaw, version) {
    const re = new RegExp(`("${DEP.replace('/', '\\/')}"\\s*:\\s*"[^"]*#v)\\d+\\.\\d+\\.\\d+(")`);
    return pkgRaw.replace(re, `$1${version}$2`);
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
    }
    catch {
        return {
            error: `could not reach the devkit remote (${lsUrl}). Set DEVKIT_REPO to override it (private fork / ssh host alias).`,
        };
    }
    return { latest: latestTag(ls) };
}
function run(cmd, args, cwd) {
    execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}
function currentVersion() {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    return pkg.version;
}
export const meta = {
    name: 'update',
    summary: 'Self-update devkit to the latest published tag.',
    help: `devkit update — self-update to the latest published tag (also --update / -u).

Usage:
  devkit update [--dry-run]

Re-pins package.json + \`bun install\` if devkit is a dep here, else \`bun add -g\` the new tag
(updates the global CLI). Defaults to git+https; set DEVKIT_REPO to override (private fork / ssh alias).`,
};
// Reason: flat update pipeline: sequential guard-and-return steps (remote unreachable, no tags, up-to-date, --dry-run) plus the package-vs-global mode fork; near-zero nesting, high branch COUNT where each branch is a trivial early-out
// fallow-ignore-next-line complexity
export default async function update(args, cwd) {
    const dryRun = args.includes('--dry-run');
    const { latest, error } = fetchLatestTag();
    if (error) {
        console.error(`devkit update: ${error}`);
        return 1;
    }
    if (!latest) {
        console.error('devkit update: no version tags found on the remote.');
        return 1;
    }
    // Detect mode + read the pinned #vX.Y.Z BEFORE the up-to-date check: in package mode "installed"
    // means what the REPO resolves (its node_modules dep, else the pinned tag), NOT the running CLI —
    // a global CLI ahead of the repo's pin must still reconcile the repo.
    const pkgPath = join(cwd, 'package.json');
    let mode = 'global';
    let pkgRaw = null;
    let pinned = null;
    if (existsSync(pkgPath)) {
        pkgRaw = readFileSync(pkgPath, 'utf8');
        const pkg = JSON.parse(pkgRaw);
        const ref = pkg.dependencies?.[DEP] ?? pkg.devDependencies?.[DEP];
        if (ref) {
            mode = 'package';
            pinned = ref.match(PIN_RE)?.[1] ?? null;
        }
    }
    const repoDep = mode === 'package'
        ? (readJson(join(cwd, 'node_modules', DEP, 'package.json'))
            ?.version ?? null)
        : null;
    const current = installedVersion({ mode, repoDep, pinned, running: currentVersion() });
    if (cmpSemver(latest, current) <= 0) {
        console.log(`devkit is up to date (v${current}).`);
        return 0;
    }
    console.log(`devkit update: v${current} → v${latest} (${mode} mode)`);
    if (dryRun) {
        console.log('  --dry-run: nothing installed.');
        return 0;
    }
    run('bun', ['pm', 'cache', 'rm'], cwd);
    if (mode === 'package') {
        // `mode === 'package'` is only ever set after pkgRaw was read from disk, so `?? ''` is a
        // never-taken fallback that lets TS see a string without changing any reachable behavior.
        const repinned = repinPackageJson(pkgRaw ?? '', latest);
        if (repinned === pkgRaw) {
            console.error(`devkit update: could not find a "${DEP}" git ref to re-pin in package.json.`);
            return 1;
        }
        writeFileSync(pkgPath, repinned);
        run('bun', ['install'], cwd); // README: use install for a re-pin (bun add can DependencyLoop)
    }
    else {
        run('bun', ['add', '-g', `${BUN_REF}#v${latest}`], cwd);
    }
    console.log(`✓ devkit updated to v${latest}.`);
    if (mode === 'package') {
        console.log('  Next: run `devkit upgrade` — one command reconciles your emitted configs (eslint.config.mjs, guard.config.json), refreshes the husky gates, and syncs skills/agents. `--dry-run` to preview first.');
    }
    // Overlay repos keep their gate chain in a git-ignored .devkit/hooks/pre-commit that this update does
    // NOT regenerate — so a new hook shape (e.g. an added ship gate) won't apply until it's refreshed.
    try {
        if (JSON.parse(readFileSync(join(cwd, '.devkit', 'config.json'), 'utf8'))?.overlay)
            console.log('  Overlay repo: run `devkit upgrade` to reconcile the local gate hook + configs to this version (or `devkit doctor --fix` for just the hook).');
    }
    catch {
        /* no readable overlay config — nothing to hint */
    }
    return 0;
}
