import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256 } from '../claim-inventory.mts';
import type { MaterializeOpts } from '../materialize.mts';

// Hang detector for child startup and Git operations under parallel suite load.
const CLI_TIMEOUT_MS = 30_000;
const modulePath = fileURLToPath(new URL('../materialize.mts', import.meta.url));
const lensModulePath = fileURLToPath(new URL('../lens-run.mts', import.meta.url));
const child = `import os from 'node:os';
os.homedir = () => process.argv[2];
const { materialize } = await import(${JSON.stringify(modulePath)});
const opts = JSON.parse(process.argv[1]);
const materialized = materialize(opts);
let identity;
if (process.argv[3] === 'project') {
  const { syncReviewAssets, runIdentity } = await import(${JSON.stringify(lensModulePath)});
  syncReviewAssets(opts.reviewAssetsRoot, materialized.wt);
  identity = runIdentity({ ...materialized, issueCap: '3' });
}
console.log(JSON.stringify({ ...materialized, identity }));`;
const git = (cwd: string, args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function writeAsset(file: string, contents: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

function initRepo(repo: string) {
  mkdirSync(repo);
  git(repo, ['init', '--quiet', '--initial-branch=main']);
  git(repo, ['config', 'user.email', 'fixture@example.invalid']);
  git(repo, ['config', 'user.name', 'Fixture']);
  writeFileSync(join(repo, 'file.txt'), 'before\n');
  writeAsset(join(repo, '.claude/agents/correctness-reviewer.md'), 'archived reviewer\n');
  writeAsset(join(repo, '.claude/skills/correctness/SKILL.md'), 'archived skill\n');
  writeAsset(join(repo, '.claude/skills/correctness/retired.md'), 'retired guidance\n');
  writeAsset(join(repo, '.claude/skills/correctness/scripts/checklist.mjs'), 'archived script\n');
  writeAsset(join(repo, '.claude/skills/_devkit/checklist-store.mjs'), 'archived storage\n');
  writeAsset(join(repo, '.claude/settings.json'), '{}\n');
  git(repo, ['add', 'file.txt', '.claude']);
  git(repo, ['-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'base']);
}

function run(opts: MaterializeOpts, project = false) {
  return spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', child, JSON.stringify(opts), root, project ? 'project' : ''],
    {
      encoding: 'utf8',
      timeout: CLI_TIMEOUT_MS,
    },
  );
}

let root: string;
let repo: string;
let researchRoot: string;
let wt: string;
let base: string;
let opts: MaterializeOpts;

function projectedOptions(): MaterializeOpts {
  const reviewAssetsRoot = join(root, 'review-assets');
  writeAsset(join(reviewAssetsRoot, 'agents/correctness-reviewer.md'), 'current reviewer\n');
  writeAsset(join(reviewAssetsRoot, 'skills/correctness/SKILL.md'), 'current skill\n');
  writeAsset(
    join(reviewAssetsRoot, 'skills/correctness/scripts/checklist.mjs'),
    'current script\n',
  );
  writeAsset(join(reviewAssetsRoot, 'skills/_devkit/checklist-store.mjs'), 'current storage\n');
  return { ...opts, reviewAssetsRoot };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'materialize-identity-')));
  repo = join(root, 'source');
  researchRoot = join(root, '.devkit', 'research', 'contexts');
  initRepo(repo);
  base = git(repo, ['rev-parse', 'HEAD']);
  writeFileSync(join(repo, 'file.txt'), 'after\n');
  const diffText = git(repo, ['diff', '--full-index']) + '\n';
  writeFileSync(join(repo, 'file.txt'), 'before\n');
  opts = {
    repo,
    researchRoot,
    branch: 'main',
    diffText,
    diffSha: sha256(diffText),
    attemptTs: new Date().toISOString(),
  };
  wt = join(researchRoot, `scale-probe-${opts.diffSha.slice(0, 12)}`);
  const first = run(opts);
  expect(first.error).toBeUndefined();
  expect(first.status, first.stderr).toBe(0);
}, CLI_TIMEOUT_MS);

afterEach(() => rmSync(root, { recursive: true, force: true }));

function snapshot() {
  return {
    callerIndex: readFileSync(join(repo, '.git', 'index')),
    callerHead: git(repo, ['rev-parse', 'HEAD']),
    contextIndex: readFileSync(
      git(wt, ['rev-parse', '--path-format=absolute', '--git-path', 'index']),
    ),
    contextHead: git(wt, ['rev-parse', 'HEAD']),
    contextFile: readFileSync(join(wt, 'file.txt')),
  };
}

function expectRejected(request = opts) {
  const before = snapshot();
  const result = run(request);
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('cached context identity validation failed');
  expect(result.stderr).toContain('use a fresh research root');
  expect(snapshot()).toEqual(before);
  expect(existsSync(`${wt}.lock`)).toBe(false);
  expect(readdirSync(wt).filter((name) => name.startsWith('.scale-identity-'))).toEqual([]);
}

describe('cached materialization identity', { timeout: CLI_TIMEOUT_MS }, () => {
  it('rejects path-bearing diff identifiers at the direct materializer boundary', () => {
    const before = snapshot();
    const result = run({ ...opts, diffSha: '../../../../escape' });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('diff must be a 64-character lowercase SHA-256');
    expect(snapshot()).toEqual(before);
    expect(existsSync(`${wt}.lock`)).toBe(false);
  });
  it('keeps a failed marker publication recoverable until the complete base marker is published', () => {
    const marker = join(wt, '.scale-probe-base');
    const repoMarker = join(wt, '.scale-probe-repo');
    rmSync(marker);
    rmSync(repoMarker);
    mkdirSync(repoMarker);
    writeFileSync(join(repo, '.git', 'info', 'exclude'), '.scale-probe-*\n');
    const failed = run(opts);
    expect(failed.error).toBeUndefined();
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain('EISDIR');
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(`${wt}.lock`)).toBe(false);
    rmSync(repoMarker, { recursive: true });
    writeFileSync(`${marker}.pending-interrupted`, base.slice(0, 8));
    const recovered = run(opts);
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(readFileSync(repoMarker, 'utf8').trim()).toBe(repo);
    expect(readFileSync(marker, 'utf8').trim()).toBe(base);
    const before = snapshot();
    expect(run(opts).status).toBe(0);
    expect(snapshot()).toEqual(before);
  });
  it('rejects direct materializer output escapes before writing patches or creating worktrees', () => {
    const outside = join(root, 'outside');
    const before = snapshot();
    const escaped = run({ ...opts, researchRoot: outside });
    expect(escaped.error).toBeUndefined();
    expect(escaped.status).not.toBe(0);
    expect(escaped.stderr).toContain('under ~/.devkit/research');
    expect(existsSync(outside)).toBe(false);
    mkdirSync(outside);
    const alias = join(researchRoot, 'escape');
    symlinkSync(outside, alias, 'dir');
    const linked = run({ ...opts, researchRoot: alias });
    expect(linked.error).toBeUndefined();
    expect(linked.status).not.toBe(0);
    expect(linked.stderr).toContain('symlink');
    expect(readdirSync(outside)).toEqual([]);
    expect(snapshot()).toEqual(before);
  });
  it('reuses matching trees despite diff index abbreviations without modifying either index or HEAD', () => {
    expect(git(wt, ['diff', '--cached'])).not.toBe(opts.diffText.trim());
    const before = snapshot();
    const result = run(opts);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('reusing worktree');
    expect(snapshot()).toEqual(before);
    expect(existsSync(`${wt}.lock`)).toBe(false);
    expect(readdirSync(wt).filter((name) => name.startsWith('.scale-identity-'))).toEqual([]);
  });
  it('accepts a canonical alias of the requested repository and keeps the cached base pinned as the branch moves', () => {
    const alias = join(root, 'source-alias');
    symlinkSync(repo, alias, 'dir');
    writeFileSync(join(repo, 'later.txt'), 'later branch state\n');
    git(repo, ['add', 'later.txt']);
    git(repo, ['-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'move main']);
    expect(git(repo, ['rev-parse', 'HEAD'])).not.toBe(base);
    const result = run({ ...opts, repo: alias });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(wt, '.scale-probe-base'), 'utf8').trim()).toBe(base);
    expect(git(wt, ['rev-parse', 'HEAD'])).toBe(base);
  });
  it('rejects a requested repository that disagrees with the cache marker', () => {
    const other = join(root, 'other');
    initRepo(other);
    expectRejected({ ...opts, repo: other });
  });
  it('rejects a forged repo marker when the worktree has a different Git common directory', () => {
    const other = join(root, 'other');
    initRepo(other);
    writeFileSync(join(wt, '.scale-probe-repo'), `${other}\n`);
    expectRejected({ ...opts, repo: other });
  });
  it('rejects an abbreviated base marker and releases the lock for a valid subsequent reuse', () => {
    writeFileSync(join(wt, '.scale-probe-base'), `${base.slice(0, 12)}\n`);
    expectRejected();
    writeFileSync(join(wt, '.scale-probe-base'), `${base}\n`);
    const result = run(opts);
    expect(result.status, result.stderr).toBe(0);
  });
  it('rejects a full base marker that does not equal context HEAD', () => {
    writeFileSync(join(repo, 'later.txt'), 'later\n');
    git(repo, ['add', 'later.txt']);
    git(repo, ['-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'later']);
    writeFileSync(join(wt, '.scale-probe-base'), `${git(repo, ['rev-parse', 'HEAD'])}\n`);
    expectRejected();
  });
  it('rejects changed staged bytes and preserves the mismatched index for inspection', () => {
    writeFileSync(join(wt, 'file.txt'), 'wrong staged data\n');
    git(wt, ['add', 'file.txt']);
    expectRejected();
  });
  it('rejects changed tracked working-tree bytes even when the cached index still matches', () => {
    writeFileSync(join(wt, 'file.txt'), 'wrong unstaged data\n');
    expectRejected();
  });
  it.each(['--assume-unchanged', '--skip-worktree'])(
    'rejects a real tracked edit hidden behind %s without changing the original index flags',
    (flag) => {
      git(wt, ['update-index', flag, 'file.txt']);
      writeFileSync(join(wt, 'file.txt'), 'hidden source change\n');
      expect(git(wt, ['diff-files', '--name-only'])).toBe('');
      expectRejected();
    },
  );
  it('reuses the exact tracked review assets projected by a preceding dry run', () => {
    const request = projectedOptions();
    const before = snapshot();
    const dry = run(request, true);
    expect(dry.status, dry.stderr).toBe(0);
    expect(git(wt, ['diff', '--name-only']).split('\n')).toEqual([
      '.claude/agents/correctness-reviewer.md',
      '.claude/skills/_devkit/checklist-store.mjs',
      '.claude/skills/correctness/SKILL.md',
      '.claude/skills/correctness/retired.md',
      '.claude/skills/correctness/scripts/checklist.mjs',
    ]);
    expect(snapshot()).toEqual(before);
    const live = run(request, true);
    expect(live.status, live.stderr).toBe(0);
    const resumed = run(request, true);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(snapshot()).toEqual(before);
    expect(readFileSync(join(repo, '.claude/agents/correctness-reviewer.md'), 'utf8')).toBe(
      'archived reviewer\n',
    );
    expect(readFileSync(join(wt, '.claude/agents/correctness-reviewer.md'), 'utf8')).toBe(
      'current reviewer\n',
    );
  });
  it('rejects a tampered projected asset instead of overwriting it on resume', () => {
    const request = projectedOptions();
    expect(run(request, true).status).toBe(0);
    const asset = join(wt, '.claude/skills/correctness/scripts/checklist.mjs');
    writeFileSync(asset, 'unexpected script\n');
    expectRejected(request);
    expect(readFileSync(asset, 'utf8')).toBe('unexpected script\n');
  });
  it('replaces only owned asset trees so retained extras cannot change resumed execution identity', () => {
    const request = projectedOptions();
    const before = snapshot();
    const first = run(request, true);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toMatch(/"identity":"[0-9a-f]{12}"/);
    expect(existsSync(join(wt, '.claude/skills/correctness/retired.md'))).toBe(false);
    const unrelated = join(wt, '.claude/notes.txt');
    const otherSkill = join(wt, '.claude/skills/other/SKILL.md');
    writeAsset(unrelated, 'retain unrelated notes\n');
    writeAsset(otherSkill, 'retain unrelated skill\n');
    for (const directory of ['correctness', '_devkit'])
      writeAsset(join(wt, '.claude/skills', directory, 'stray.md'), 'unexpected retained asset\n');
    const resumed = run(request, true);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(resumed.stdout).toBe(first.stdout);
    for (const directory of ['correctness', '_devkit'])
      expect(existsSync(join(wt, '.claude/skills', directory, 'stray.md'))).toBe(false);
    expect(readFileSync(unrelated, 'utf8')).toBe('retain unrelated notes\n');
    expect(readFileSync(otherSkill, 'utf8')).toBe('retain unrelated skill\n');
    expect(snapshot()).toEqual(before);
  });
  it('requires a fresh context when the intended asset source changes between invocations', () => {
    const request = projectedOptions();
    expect(run(request, true).status).toBe(0);
    writeFileSync(join(root, 'review-assets/agents/correctness-reviewer.md'), 'later reviewer\n');
    expectRejected(request);
    expect(readFileSync(join(wt, '.claude/agents/correctness-reviewer.md'), 'utf8')).toBe(
      'current reviewer\n',
    );
  });
  it.each(['file.txt', '.claude/settings.json'])(
    'rejects an unrelated tracked edit at %s even when exact review projection is enabled',
    (file) => {
      const request = projectedOptions();
      expect(run(request, true).status).toBe(0);
      writeFileSync(join(wt, file), 'unexpected source change\n');
      expectRejected(request);
    },
  );
});
