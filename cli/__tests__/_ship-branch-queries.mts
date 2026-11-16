import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { testExecFileSync as execFileSync } from './_helpers.mts';
import { GIT_ENV } from './_ship-branch-fixture.mts';

export function localBranchExists(git, br) {
  try {
    return Boolean(git(['rev-parse', '--verify', '--quiet', br], { stdio: 'pipe' }).trim());
  } catch {
    return false;
  }
}

export function manifestOf(dir) {
  return JSON.parse(readFileSync(join(dir, '.devkit/reconcile-manifest.json'), 'utf8'));
}

/** The sha a ref names in a bare remote. */
export function bareSha(bare, ref) {
  return execFileSync('git', ['-C', bare, 'rev-parse', ref], {
    env: { ...process.env, ...GIT_ENV },
    encoding: 'utf8',
  }).trim();
}

export function remoteBranchExists(bare, br) {
  try {
    return Boolean(
      execFileSync('git', ['-C', bare, 'rev-parse', '--verify', '--quiet', br], {
        env: { ...process.env, ...GIT_ENV },
        encoding: 'utf8',
      }).trim(),
    );
  } catch {
    return false;
  }
}
