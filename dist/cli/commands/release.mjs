/**
 * devkit release — MAINTAINER-ONLY. Run INSIDE the @norvalbv/devkit repo to cut a release:
 * bump the version → run tests → build dist → open a release PR. After its squash merge, tag the
 * merge commit (never the release branch commit, which does not land on main).
 *
 *   devkit release [patch|minor|major|<x.y.z>] [--dry-run] [--yes]
 *
 * Refuses outside the devkit repo (it would bump a consumer's package.json) and refuses on a
 * dirty tree (feature work must be committed first — release only bumps the version + dist).
 *
 * Source is real TypeScript (.mts); this command compiles it to the shipped .mjs `dist/` and ships
 * that dist in the release PR (dist is gitignored on working branches). A node smoke gate verifies
 * the built bin runs before the PR opens, so the eventual tag carries prebuilt .mjs with no
 * consumer-side build.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cancel, confirm, isCancel } from '@clack/prompts';
import ship from './ship.mjs';
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
/** Compute the next version. `bump` is patch|minor|major, or an explicit x.y.z. */
export function nextVersion(current, bump) {
    if (SEMVER_RE.test(bump))
        return bump;
    if (!SEMVER_RE.test(current))
        throw new Error(`current version "${current}" is not x.y.z`);
    const [major, minor, patch] = current.split('.').map(Number);
    if (bump === 'major')
        return `${major + 1}.0.0`;
    if (bump === 'minor')
        return `${major}.${minor + 1}.0`;
    if (bump === 'patch')
        return `${major}.${minor}.${patch + 1}`;
    throw new Error(`bad bump "${bump}" — use patch | minor | major | x.y.z`);
}
/** Rewrite every `devkit.git#vX.Y.Z` install pin in the README to the new version. */
export function bumpReadmePins(readme, newVersion) {
    return readme.replace(/devkit\.git#v\d+\.\d+\.\d+/g, `devkit.git#v${newVersion}`);
}
function git(args, cwd) {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
/**
 * Whether `tag` is already published. `git tag --list` only knows what THIS clone fetched, so a
 * clone that never fetched tags would happily re-cut a version that already exists — and a version
 * tag is immutable: consumer lockfiles record the object it resolves to, so re-pointing one orphans
 * every recorded SHA. An unreachable remote returns false (proceed): an offline maintainer must not
 * be blocked by a check that can only ever add certainty.
 */
export function remoteTagExists(tag, cwd) {
    try {
        return git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`], cwd) !== '';
    }
    catch {
        return false;
    }
}
export const meta = {
    name: 'release',
    summary: 'MAINTAINER-ONLY: bump version, test, and open a release PR.',
    help: `devkit release — MAINTAINER-ONLY (run inside the devkit repo): bump version, test, build, and open a release PR.

Usage:
  devkit release [patch|minor|major|<x.y.z>] [--dry-run] [--yes]

  --dry-run   Print the plan; change nothing.
  --yes       Skip the release-PR confirm prompt.

Refuses outside the devkit repo, on a dirty tree, or if the target tag already exists. The tag is
created only after the PR is squash-merged; the command prints the exact post-merge steps. Release
files remain in the working tree until \`devkit reconcile --apply\` after the PR merges.`,
};
// Reason: flat release orchestration: independent guard early-returns followed by sequential
// test · bump · build · ship steps; high branch COUNT comes from stacked shallow guards.
// fallow-ignore-next-line complexity
export default async function release(args, cwd) {
    const dryRun = args.includes('--dry-run');
    const yes = args.includes('--yes');
    const bump = args.find((a) => !a.startsWith('-')) || 'patch';
    const pkgPath = join(cwd, 'package.json');
    if (!existsSync(pkgPath)) {
        console.error('devkit release: no package.json in the current directory.');
        return 1;
    }
    const pkgRaw = readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(pkgRaw);
    // Guard 1 — this is the devkit repo (not a consumer; release bumps + ships devkit itself).
    if (pkg.name !== '@norvalbv/devkit') {
        console.error(`devkit release runs only in the devkit repo (found "${pkg.name}").`);
        return 1;
    }
    // Guard 2 — clean tree: feature work already committed (release only bumps the version).
    if (git(['status', '--porcelain'], cwd)) {
        console.error('devkit release: working tree not clean — commit your changes first.');
        return 1;
    }
    const current = pkg.version;
    let target;
    try {
        target = nextVersion(current, bump);
    }
    catch (e) {
        console.error(`devkit release: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
    }
    const tag = `v${target}`;
    const baseBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    if (baseBranch === 'HEAD') {
        console.error('devkit release: detached HEAD — run from the branch the release PR should target.');
        return 1;
    }
    if (git(['tag', '--list', tag], cwd)) {
        console.error(`devkit release: tag ${tag} already exists.`);
        return 1;
    }
    if (remoteTagExists(tag, cwd)) {
        console.error(`devkit release: tag ${tag} is already published on origin.`);
        return 1;
    }
    const releaseBranch = `release/${tag}`;
    console.log(`devkit release: ${current} → ${target} (${bump})`);
    console.log(`  bump package.json + README pins · run tests · build dist · open PR ${releaseBranch} → ${baseBranch}`);
    console.log(`  tag ${tag} only after the PR is squash-merged`);
    if (dryRun) {
        console.log('  --dry-run: nothing written.');
        return 0;
    }
    if (!yes) {
        if (!process.stdout.isTTY) {
            console.error('devkit release: non-interactive — pass --yes to confirm the release PR.');
            return 1;
        }
        const ok = await confirm({ message: `Build ${tag} and open its release PR?` });
        if (isCancel(ok) || !ok) {
            cancel('Aborted.');
            return 0;
        }
    }
    console.log('Running tests…');
    try {
        execFileSync('bun', ['run', 'test:run'], { cwd, stdio: 'inherit' });
    }
    catch {
        console.error('devkit release: tests failed — not releasing.');
        return 1;
    }
    // Bump via targeted string replace (preserves exact formatting; no re-serialize).
    const bumped = pkgRaw.replace(`"version": "${current}"`, `"version": "${target}"`);
    if (bumped === pkgRaw) {
        console.error(`devkit release: could not find "version": "${current}" in package.json.`);
        return 1;
    }
    writeFileSync(pkgPath, bumped);
    const releaseFiles = ['package.json'];
    const readmePath = join(cwd, 'README.md');
    if (existsSync(readmePath)) {
        writeFileSync(readmePath, bumpReadmePins(readFileSync(readmePath, 'utf8'), target));
        releaseFiles.push('README.md');
    }
    // Build the shipped dist (real .mts → .mjs + asset copy) and smoke-test it before opening the PR.
    console.log('Building dist…');
    try {
        execFileSync('bun', ['run', 'build'], { cwd, stdio: 'inherit' });
    }
    catch {
        console.error('devkit release: build failed — not releasing.');
        return 1;
    }
    // Smoke gate (non-bypassable): the built bin must run under node and report the NEW version. This is
    // the ONLY check that exercises the real dist resolution path — tsc + vitest resolve source, not dist.
    try {
        const built = execFileSync('node', [join(cwd, 'dist', 'cli', 'index.mjs'), '--version'], {
            cwd,
            encoding: 'utf8',
        }).trim();
        if (built !== target)
            throw new Error(`built bin reports ${built}, expected ${target}`);
    }
    catch (e) {
        console.error(`devkit release: dist smoke check failed — ${e instanceof Error ? e.message : String(e)}`);
        return 1;
    }
    // Belt-and-suspenders on top of the version check above: a --version match proves the bin ran, not
    // that a given source fix actually reached dist (sc-1340's own PR claimed it did and was wrong —
    // sc-1419 was the consequence). Assert the stdin-hang fix's call site is actually in the built dist.
    // Everything here — including the read — stays inside one try/catch: existsSync alone would accept
    // a directory, and an unguarded readFileSync would throw uncaught on a permission error or a file
    // removed between the check and the read.
    const shipBranchPath = join(cwd, 'dist', 'cli', 'lib', 'ship', 'ship-branch.sh');
    const readStdinBodyPath = join(cwd, 'dist', 'cli', 'lib', 'ship', 'read-stdin-body.sh');
    const isFile = (p) => existsSync(p) && statSync(p).isFile();
    try {
        if (!isFile(shipBranchPath) || !isFile(readStdinBodyPath)) {
            throw new Error('dist/cli/lib/ship/ship-branch.sh or dist/cli/lib/ship/read-stdin-body.sh ' +
                'is missing from the build');
        }
        if (!readFileSync(shipBranchPath, 'utf8').includes('ship_read_stdin_body')) {
            throw new Error('dist/cli/lib/ship/ship-branch.sh does not wire ship_read_stdin_body ' +
                '(the sc-1419 stdin-hang fix is missing from this build)');
        }
    }
    catch (e) {
        console.error(`devkit release: dist smoke check failed — ${e instanceof Error ? e.message : String(e)}`);
        return 1;
    }
    const trackedDistFiles = git(['ls-files', '--', 'dist'], cwd).split('\n').filter(Boolean);
    const ignoredDistAfter = git(['ls-files', '-o', '-i', '--exclude-standard', '--', 'dist'], cwd)
        .split('\n')
        .filter(Boolean);
    releaseFiles.push(...trackedDistFiles, ...ignoredDistAfter);
    const prBody = [
        `Automated release PR for ${tag}.`,
        '',
        'The version bump, README pins, full test suite, rebuilt dist, and dist smoke check completed',
        'before this PR was opened.',
        '',
        `Do not tag the release branch commit. After squash-merging, tag the merge commit as ${tag}.`,
    ].join('\n');
    const publishCode = ship([
        releaseBranch,
        `release: ${tag}`,
        '--base',
        baseBranch,
        '--body',
        prBody,
        '--',
        ...releaseFiles,
    ], cwd);
    if (publishCode !== 0) {
        console.error(`devkit release: could not publish ${releaseBranch}; release files remain in the working tree for recovery.`);
        return publishCode;
    }
    console.log(`✓ Opened release PR ${releaseBranch} → ${baseBranch}; no tag created.`);
    console.log('Release files remain in this working tree; after the PR merges, run:');
    console.log('  devkit reconcile --apply');
    console.log('After the PR is squash-merged, tag its merge commit:');
    console.log(`  merge_sha=$(gh pr view ${releaseBranch} --json state,mergeCommit --jq 'select(.state == "MERGED") | .mergeCommit.oid')`);
    console.log(`  test -n "$merge_sha" || { echo "${releaseBranch} is not merged"; exit 1; }`);
    console.log(`  git tag -a ${tag} "$merge_sha" -m "devkit ${tag}"`);
    console.log(`  git push origin ${tag}`);
    return 0;
}
