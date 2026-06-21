/**
 * devkit release — MAINTAINER-ONLY. Run INSIDE the @norvalbv/devkit repo to cut a release:
 * bump the version → run tests → commit → tag vX.Y.Z → push the current branch + tag.
 *
 *   devkit release [patch|minor|major|<x.y.z>] [--dry-run] [--yes]
 *
 * Refuses outside the devkit repo (it would bump a consumer's package.json) and refuses on a
 * dirty tree (feature work must be committed first — release only bumps the version + tags).
 * Plain .mjs, no build.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cancel, confirm, isCancel } from '@clack/prompts';

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/** Compute the next version. `bump` is patch|minor|major, or an explicit x.y.z. */
export function nextVersion(current, bump) {
  if (SEMVER_RE.test(bump)) return bump;
  if (!SEMVER_RE.test(current)) throw new Error(`current version "${current}" is not x.y.z`);
  const [major, minor, patch] = current.split('.').map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`bad bump "${bump}" — use patch | minor | major | x.y.z`);
}

/** Rewrite every `devkit.git#vX.Y.Z` install pin in the README to the new version. */
export function bumpReadmePins(readme, newVersion) {
  return readme.replace(/devkit\.git#v\d+\.\d+\.\d+/g, `devkit.git#v${newVersion}`);
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// Reason: flat release orchestration: a sequence of independent guard early-returns (no package.json / not devkit repo / dirty tree / bad bump / tag exists / non-TTY / tests fail) then trivial sequential steps (bump · commit · tag · push); high branch COUNT from stacked guards, each trivial with near-zero nesting
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

  // Guard 1 — this is the devkit repo (not a consumer; release bumps + tags + pushes devkit itself).
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
  } catch (e) {
    console.error(`devkit release: ${e.message}`);
    return 1;
  }
  const tag = `v${target}`;
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (git(['tag', '--list', tag], cwd)) {
    console.error(`devkit release: tag ${tag} already exists.`);
    return 1;
  }

  console.log(`devkit release: ${current} → ${target} (${bump})`);
  console.log(
    `  bump package.json + README pins · run tests · commit · tag ${tag} · push origin ${branch} + ${tag}`,
  );
  if (dryRun) {
    console.log('  --dry-run: nothing written.');
    return 0;
  }
  if (!yes) {
    if (!process.stdout.isTTY) {
      console.error('devkit release: non-interactive — pass --yes to confirm the push.');
      return 1;
    }
    const ok = await confirm({ message: `Release ${tag} and push to origin?` });
    if (isCancel(ok) || !ok) {
      cancel('Aborted.');
      return 0;
    }
  }

  console.log('Running tests…');
  try {
    execFileSync('bun', ['run', 'test:run'], { cwd, stdio: 'inherit' });
  } catch {
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

  const filesToCommit = ['package.json'];
  const readmePath = join(cwd, 'README.md');
  if (existsSync(readmePath)) {
    writeFileSync(readmePath, bumpReadmePins(readFileSync(readmePath, 'utf8'), target));
    filesToCommit.push('README.md');
  }

  git(['add', ...filesToCommit], cwd);
  git(['commit', '-m', `release: ${tag}`], cwd);
  git(['tag', '-a', tag, '-m', `devkit ${tag}`], cwd);
  git(['push', 'origin', branch], cwd);
  git(['push', 'origin', tag], cwd);

  console.log(`✓ Released ${tag} → origin/${branch} + ${tag}`);
  return 0;
}
