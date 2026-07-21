import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';

// review-target.sh picks the base the judges diff against. The in-chain hook runs
// `guard-review --gate` with NO --base, so inference decides what every reviewer sees. Inferring
// origin/HEAD is only right when the integration branch IS the default branch; where it is not, the
// judges get handed the whole release. Observed before this fix: a 3-file, modification-only commit
// was failed for "deleting" two files — one of 211 deletions in the 161 commits between the two
// branches. Hermetic: DEVKIT_REVIEW_RESOLVE_ONLY exits before any snapshot/judge side effect.

vi.setConfig({ testTimeout: 30_000 });

const scriptPath = fileURLToPath(new URL('../lib/ship/review-target.sh', import.meta.url));
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const BASE_REF_RE = /BASE_REF=(.*)/;
const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/**
 * A repo whose integration branch (`release`) has diverged from the default branch, with
 * `origin/HEAD` pointing at the default — the shape that misroutes inference.
 */
function seedDivergedRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'revbase-'));
  dirs.push(dir);
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });

  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'a@b.c']);
  git(['config', 'user.name', 'a']);
  git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'keep.txt'), 'base');
  git(['add', 'keep.txt']);
  git(['commit', '-q', '-m', 'root']);
  const root = git(['rev-parse', 'HEAD']).trim();

  // origin/HEAD -> origin/main, mirroring a normal clone.
  git(['update-ref', 'refs/remotes/origin/main', root]);
  git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);

  // The integration branch moves ahead and DELETES a file — the deletions a wrongly-based review
  // would attribute to the commit under review.
  git(['checkout', '-q', '-b', 'release']);
  writeFileSync(join(dir, 'feature.txt'), 'shipped');
  git(['add', 'feature.txt']);
  git(['rm', '-q', 'keep.txt']);
  git(['commit', '-q', '-m', 'release work']);
  const releaseTip = git(['rev-parse', 'HEAD']).trim();

  // The commit under review sits on top of the integration branch.
  writeFileSync(join(dir, 'feature.txt'), 'shipped + my change');
  git(['add', 'feature.txt']);
  git(['commit', '-q', '-m', 'my change']);

  return { dir, root, releaseTip };
}

// The script validates its packaged reviewer assets before resolving anything; point it at this
// checkout so the resolve-only seam is reachable (review.mts supplies this in normal use).
const packageRoot = fileURLToPath(new URL('../..', import.meta.url));

function resolveBase(dir: string, env: Record<string, string> = {}) {
  const r = spawnSync('/bin/bash', [scriptPath], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...GIT_ENV,
      DEVKIT_REVIEW_RESOLVE_ONLY: '1',
      DEVKIT_REVIEW_PACKAGE_ROOT: packageRoot,
      ...env,
    },
  });
  expect(r.status, `resolve must exit 0 (stderr: ${r.stderr})`).toBe(0);
  return BASE_REF_RE.exec(r.stdout)?.[1];
}

describe('review-target.sh — base inference', () => {
  it("prefers the invoking ship's resolved base over origin/HEAD", () => {
    const { dir, releaseTip } = seedDivergedRepo();

    expect(resolveBase(dir, { DEVKIT_SHIP_BASE_SHA: releaseTip })).toBe(releaseTip);
  });

  it('still falls back to origin/HEAD when no ship base is exported', () => {
    const { dir } = seedDivergedRepo();

    expect(resolveBase(dir)).toBe('origin/HEAD');
  });

  it('ignores a ship base that does not resolve in this repo', () => {
    // A stale or foreign sha must not hard-fail the review; fall through to the old inference.
    const { dir } = seedDivergedRepo();

    expect(
      resolveBase(dir, { DEVKIT_SHIP_BASE_SHA: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }),
    ).toBe('origin/HEAD');
  });
});
