/**
 * devkit release — MAINTAINER-ONLY. Run INSIDE the @norvalbv/devkit repo to cut a release:
 * bump the version → run tests → build dist → open a release PR. After its squash merge, tag the
 * merge commit (never the release branch commit, which does not land on main).
 *
 *   devkit release [patch|minor|major|<x.y.z>] [--base <branch>] [--dry-run] [--yes] [--ci-override "<reason>"]
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
import { parseArgs } from 'node:util';
import { cancel, confirm, isCancel } from '@clack/prompts';
import { branchHead, type CommitCi, commitCi, GhUnavailable } from '../lib/baseline-status/gh.mts';
import { configuredSource } from '../lib/baseline-status/source.mts';
import { shellQuote } from '../lib/ship/dist-integrity.mts';
import ship from './ship.mts';

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/** Compute the next version. `bump` is patch|minor|major, or an explicit x.y.z. */
export function nextVersion(current: string, bump: string): string {
  if (SEMVER_RE.test(bump)) return bump;
  if (!SEMVER_RE.test(current)) throw new Error(`current version "${current}" is not x.y.z`);
  const [major, minor, patch] = current.split('.').map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`bad bump "${bump}" — use patch | minor | major | x.y.z`);
}

/** Rewrite every `devkit.git#vX.Y.Z` install pin in the README to the new version. */
export function bumpReadmePins(readme: string, newVersion: string): string {
  return readme.replace(/devkit\.git#v\d+\.\d+\.\d+/g, `devkit.git#v${newVersion}`);
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * Whether `tag` is already published. `git tag --list` only knows what THIS clone fetched, so a
 * clone that never fetched tags would happily re-cut a version that already exists — and a version
 * tag is immutable: consumer lockfiles record the object it resolves to, so re-pointing one orphans
 * every recorded SHA. An unreachable remote returns false (proceed): an offline maintainer must not
 * be blocked by a check that can only ever add certainty.
 */
export function remoteTagExists(tag: string, cwd: string): boolean {
  try {
    return git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`], cwd) !== '';
  } catch {
    return false;
  }
}

/** Whether GitHub's tip of `base` is `sha`, printing why not: CI is read for that tip. */
function onOriginTip(cwd: string, base: string, sha: string, detached: boolean): boolean {
  let tip: string;
  try {
    tip = branchHead({ cwd, ref: base });
  } catch (e) {
    if (!(e instanceof GhUnavailable)) throw e;
    console.error(`devkit release: cannot read origin's ${base} — ${e.reason}: ${e.message}`);
    return false;
  }
  if (tip === sha) return true;
  // A detached worktree cannot check out `base` while another worktree holds it.
  const remedy = detached
    ? `Run \`git fetch origin && git checkout --detach origin/${base}\` and re-run.`
    : `Check out ${base} at ${tip} and re-run.`;
  console.error(
    `devkit release: HEAD is ${sha} but origin's ${base} is ${tip}; CI and the build must ` +
      `describe the commit the release PR lands on. ${remedy}`,
  );
  return false;
}

const VERDICT_SAID = {
  green: 'passed',
  red: 'failed',
  pending: 'has not finished',
  missing: 'has no verdict',
  unreadable: 'could not be read',
} satisfies Record<CommitCi['verdict'], string>;

const OVERRIDABLE =
  'Fix or re-run CI on the base, or pass --ci-override "<reason>"; the release PR records it.';
const REMEDY = {
  red: OVERRIDABLE,
  missing: OVERRIDABLE,
  pending: 'Wait for that run to finish, then re-run devkit release.',
  unreadable: 'Re-run once gh can read the runs; --ci-override does not waive an unread verdict.',
} satisfies Record<Exclude<CommitCi['verdict'], 'green'>, string>;

/** The base commit's CI as the release PR records it; `green` means CI already ran the suite on it. */
interface BaseCi {
  green: boolean;
  lines: string[];
}

/**
 * The release PR's record of the base commit's CI, or null after refusing. Only green proceeds
 * unaided; `override` (the --ci-override reason) waives red, missing or pending and is recorded.
 */
function baseCiLines(cwd: string, base: string, sha: string, override?: string): BaseCi | null {
  const { workflow } = configuredSource(cwd);
  const ci = commitCi({ cwd, workflow, ref: base, sha });
  const finding =
    `${workflow} ${VERDICT_SAID[ci.verdict]} on ${sha}` +
    (ci.detail ? ` (${ci.detail})` : '') +
    (ci.url ? ` — ${ci.url}` : '');
  if (ci.verdict === 'green') {
    if (override) console.log('devkit release: base CI is green; --ci-override is not recorded.');
    return { green: true, lines: [`Base CI: ${finding}`] };
  }
  if (override && ci.verdict !== 'unreadable') {
    console.log(`devkit release: ${finding} — releasing under --ci-override.`);
    const lines = [
      '## Base CI override',
      '',
      finding,
      '',
      `Reason given with --ci-override: ${override}`,
    ];
    return { green: false, lines };
  }
  console.error(`devkit release: base CI is not green — ${finding}`);
  console.error(REMEDY[ci.verdict]);
  return null;
}

export const meta = {
  name: 'release',
  agentFacing: false,
  notRoutedBecause:
    'MAINTAINER-ONLY, run by a human inside the devkit repo itself. Not a consumer-repo verb ' +
    'at all, so no consumer-facing skill should route to it.',
  summary: 'MAINTAINER-ONLY: bump version, test, and open a release PR.',
  valueFlags: ['--base', '--ci-override'],
  help: `devkit release — MAINTAINER-ONLY (run inside the devkit repo): bump version, test, build, and open a release PR.

Usage:
  devkit release [patch|minor|major|<x.y.z>] [--base <branch>] [--dry-run] [--yes] [--ci-override "<reason>"]

  --base         The branch the release PR targets; defaults to the current branch. Required on a
                 detached HEAD.
  --dry-run      Print the plan; change nothing.
  --yes          Skip the release-PR confirm prompt.
  --ci-override  Release although the base commit's CI is not green. The reason is required and is
                 recorded in the release PR body.

The local test suite runs only under --ci-override: a green base commit already passed it in CI.

Refuses outside the devkit repo, on a dirty tree, or if the target tag already exists. It also
refuses unless HEAD is origin's tip of the base branch and that commit's newest completed run of the
CI workflow (guard.config.json baselineStatus.workflow, default gate.yml) passed; that needs an
authenticated gh, and a base branch the workflow never runs on needs --ci-override. The tag is
created only after the PR is squash-merged; the command prints the exact post-merge steps. Release
files remain in the working tree until \`devkit reconcile --apply\` after the PR merges.

To release from a clean worktree at origin's tip (the shared main checkout may be dirty), run from
source, since a published devkit may predate --base:
  git fetch origin && git worktree add --detach <dir> origin/main && cd <dir>
  bun install --frozen-lockfile && node cli/index.mts release minor --base main
Then remove that worktree after the PR merges instead of reconciling.`,
};

// Reason: flat release orchestration: independent guard early-returns followed by sequential
// test · bump · build · ship steps; high branch COUNT comes from stacked shallow guards.
// fallow-ignore-next-line complexity
export default async function release(args: string[], cwd: string): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean' },
      yes: { type: 'boolean' },
      base: { type: 'string' },
      'ci-override': { type: 'string' },
    },
  });
  const bump = positionals[0] || 'patch';
  const override = values['ci-override'];
  if (override?.trim() === '') {
    console.error(
      'devkit release: --ci-override needs a reason; it is recorded in the release PR.',
    );
    return 1;
  }

  const pkgPath = join(cwd, 'package.json');
  if (!existsSync(pkgPath)) {
    console.error('devkit release: no package.json in the current directory.');
    return 1;
  }
  const pkgRaw = readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(pkgRaw) as { name: string; version: string };

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
  let target: string;
  try {
    target = nextVersion(current, bump);
  } catch (e: unknown) {
    console.error(`devkit release: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const tag = `v${target}`;
  const head = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const detached = head === 'HEAD';
  const flag = values.base?.replace(/^origin\//, '');
  const baseBranch = flag ?? (detached ? '' : head);
  if (!baseBranch) {
    const why = flag === undefined ? 'detached HEAD' : '--base is empty';
    console.error(`devkit release: ${why} — pass --base <branch>, the branch the PR targets.`);
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
  const sha = git(['rev-parse', 'HEAD'], cwd);
  const baseCi =
    onOriginTip(cwd, baseBranch, sha, detached) && baseCiLines(cwd, baseBranch, sha, override);
  if (!baseCi) return 1;
  const suite = baseCi.green ? 'tests already passed in CI' : 'run tests';
  const releaseBranch = `release/${tag}`;

  console.log(`devkit release: ${current} → ${target} (${bump})`);
  console.log(
    `  bump package.json + README pins · ${suite} · build dist · open PR ${releaseBranch} → ${baseBranch}`,
  );
  console.log(`  tag ${tag} only after the PR is squash-merged`);
  if (values['dry-run']) {
    console.log('  --dry-run: nothing written.');
    return 0;
  }
  if (!values.yes) {
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

  // CI ran this suite on this exact commit; an overridden base has no such proof, so it runs here.
  if (baseCi.green) {
    console.log('Skipping the local test suite: CI passed it on this commit.');
  } else {
    console.log('Running tests…');
    try {
      execFileSync('bun', ['run', 'test:run'], { cwd, stdio: 'inherit' });
    } catch {
      console.error('devkit release: tests failed — not releasing.');
      return 1;
    }
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
  } catch {
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
    if (built !== target) throw new Error(`built bin reports ${built}, expected ${target}`);
  } catch (e: unknown) {
    console.error(
      `devkit release: dist smoke check failed — ${e instanceof Error ? e.message : String(e)}`,
    );
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
  const isFile = (p: string) => existsSync(p) && statSync(p).isFile();
  try {
    if (!isFile(shipBranchPath) || !isFile(readStdinBodyPath)) {
      throw new Error(
        'dist/cli/lib/ship/ship-branch.sh or dist/cli/lib/ship/read-stdin-body.sh ' +
          'is missing from the build',
      );
    }
    if (!readFileSync(shipBranchPath, 'utf8').includes('ship_read_stdin_body')) {
      throw new Error(
        'dist/cli/lib/ship/ship-branch.sh does not wire ship_read_stdin_body ' +
          '(the sc-1419 stdin-hang fix is missing from this build)',
      );
    }
  } catch (e: unknown) {
    console.error(
      `devkit release: dist smoke check failed — ${e instanceof Error ? e.message : String(e)}`,
    );
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
    baseCi.green
      ? 'The test suite passed in CI on the base commit; it was not re-run locally.'
      : 'The full test suite ran locally, because the base commit had no green CI run.',
    'The version bump, README pins, rebuilt dist, and dist smoke check completed before this PR',
    'was opened.',
    '',
    `Do not tag the release branch commit. After squash-merging, tag the merge commit as ${tag}.`,
    '',
    ...baseCi.lines,
  ].join('\n');
  // ship cuts the PR from origin's tip, so a base that moved since the CI read is refused.
  if (!onOriginTip(cwd, baseBranch, sha, detached)) {
    console.error(
      'devkit release: nothing was published; release files remain in the working tree.',
    );
    return 1;
  }
  // `await`: ship runs its script through the managed spawn and returns a Promise. Without this the
  // comparison below reads a Promise object, is always truthy, and release reports a failed publish
  // for every successful one.
  const publishCode = await ship(
    [
      releaseBranch,
      `release: ${tag}`,
      '--base',
      baseBranch,
      '--body',
      prBody,
      '--',
      ...releaseFiles,
    ],
    cwd,
  );
  if (publishCode !== 0) {
    console.error(
      `devkit release: could not publish ${releaseBranch}; release files remain in the working tree for recovery.`,
    );
    return publishCode;
  }

  console.log(`✓ Opened release PR ${releaseBranch} → ${baseBranch}; no tag created.`);
  // reconcile ends in `git pull --ff-only`, which a detached HEAD cannot do.
  if (!detached) {
    console.log('Release files remain in this working tree; after the PR merges, run:');
    console.log('  devkit reconcile --apply');
  }
  console.log('After the PR is squash-merged, tag its merge commit:');
  console.log(
    `  merge_sha=$(gh pr view ${releaseBranch} --json state,mergeCommit --jq 'select(.state == "MERGED") | .mergeCommit.oid')`,
  );
  console.log(`  test -n "$merge_sha" || { echo "${releaseBranch} is not merged"; exit 1; }`);
  console.log(`  git tag -a ${tag} "$merge_sha" -m "devkit ${tag}"`);
  console.log(`  git push origin ${tag}`);
  // Last: the tag commands above run in this directory.
  if (detached) {
    console.log('Then remove this throwaway worktree:');
    console.log(`  git worktree remove --force ${shellQuote(cwd)}`);
  }
  return 0;
}
