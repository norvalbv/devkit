import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCommitMsgBlock } from '../lib/husky/commit-msg-block.mts';
import { buildFullHook, buildOverlayHook } from '../lib/husky/husky-block.mts';
import { DK_COMMIT_INDEX_CAPTURE } from '../lib/husky/review-fragments.mts';
import { rootRegistry } from './_helpers.mts';

const REPO = resolve(import.meta.dirname, '../..');
const SPAWN_TIMEOUT_MS = 60_000;
const { mkTmp, cleanup } = rootRegistry();
afterEach(cleanup);

// A stand-in `guard-deterministic`: reports what a scrubbed gate sees, optionally lowers a baseline.
const STUB_GATE = `import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { commitIndexEnv } from ${JSON.stringify(join(REPO, 'gate-engine/ratchets/commit-index.mts'))};
import { stageBaseline, stagedSet } from ${JSON.stringify(join(REPO, 'gate-engine/ratchets/git-index.mts'))};
const cwd = process.cwd();
const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd, env: commitIndexEnv(cwd), encoding: 'utf8' });
if (process.env.STUB_BASELINE) { writeFileSync('baseline.json', 'lowered\\n'); stageBaseline(cwd, 'baseline.json'); }
appendFileSync(process.env.STUB_OUT, JSON.stringify({
  gitIndexFile: process.env.GIT_INDEX_FILE ?? null,
  carrier: process.env.DEVKIT_COMMIT_INDEX_FILE ?? null,
  staged: staged.split('\\n').filter(Boolean).sort(),
  stagedSet: [...(stagedSet(cwd) ?? [])].sort(),
}) + '\\n');
`;

interface GateView {
  gitIndexFile: string | null;
  carrier: string | null;
  staged: string[];
  stagedSet: string[];
}

function seedHookedRepo(pkgRel = '') {
  const root = realpathSync(mkTmp('commit-index-hook-'));
  const home = mkTmp('commit-index-home-');
  const bin = mkTmp('commit-index-bin-');
  const out = join(mkTmp('commit-index-out-'), 'views.jsonl');
  writeFileSync(join(bin, 'stub-gate.mjs'), STUB_GATE);
  writeFileSync(join(bin, 'guard-deterministic'), `#!/bin/sh\nexec node "${bin}/stub-gate.mjs"\n`);
  chmodSync(join(bin, 'guard-deterministic'), 0o755);
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    DEVKIT_NO_TELEMETRY: '1',
    STUB_OUT: out,
  };
  const git = (args: string[], extra: NodeJS.ProcessEnv = {}, cwd = root) => {
    const result = spawnSync('git', args, {
      cwd,
      env: { ...env, ...extra },
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
    });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout;
  };
  git(['init', '-q']);
  git(['config', 'user.email', 't@t.t']);
  git(['config', 'user.name', 't']);
  const pkg = join(root, pkgRel);
  mkdirSync(pkg, { recursive: true });
  for (const name of ['f.txt', 'g.txt', 'baseline.json']) writeFileSync(join(pkg, name), 'base\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'base']);
  const hook = join(root, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, buildFullHook({ guards: ['size'] }, pkgRel, 'global-optional'));
  chmodSync(hook, 0o755);
  const views = (): GateView[] =>
    readFileSync(out, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  return { root, pkg, git, views };
}

describe('commit hook carries the commit index to devkit gates', () => {
  it('`commit -am` judges the tracked edit it commits, with GIT_INDEX_FILE still scrubbed', () => {
    const { pkg, git, views } = seedHookedRepo();
    writeFileSync(join(pkg, 'f.txt'), 'edited\n');
    git(['commit', '-qam', 'all']);
    const [view] = views();
    expect(view.staged).toEqual(['f.txt']);
    expect(view.stagedSet).toEqual(['f.txt']);
    expect(view.gitIndexFile).toBeNull();
    expect(view.carrier).toMatch(/index\.lock$/);
  });

  it('`commit -- <path>` judges the pathspec it commits', () => {
    const { pkg, git, views } = seedHookedRepo();
    writeFileSync(join(pkg, 'f.txt'), 'edited\n');
    writeFileSync(join(pkg, 'g.txt'), 'not committed\n');
    git(['commit', '-qm', 'partial', '--', 'f.txt']);
    expect(views()[0].staged).toEqual(['f.txt']);
  });

  it('a relative alternate GIT_INDEX_FILE resolves from the top level', () => {
    const { pkg, git, views } = seedHookedRepo();
    const alt = { GIT_INDEX_FILE: '.git/alt-index' };
    git(['read-tree', 'HEAD'], alt);
    writeFileSync(join(pkg, 'g.txt'), 'alt\n');
    git(['add', 'g.txt'], alt);
    git(['commit', '-qm', 'alt'], alt);
    expect(views()[0].staged).toEqual(['g.txt']);
  });

  it('a plain commit exports no carrier, even when git names the index through a symlink', () => {
    const { root, pkg, git, views } = seedHookedRepo();
    const link = join(mkTmp('commit-index-link-'), 'repo');
    symlinkSync(root, link);
    writeFileSync(join(pkg, 'f.txt'), 'edited\n');
    git(['add', 'f.txt']);
    git(['commit', '-qm', 'plain']);
    writeFileSync(join(pkg, 'g.txt'), 'edited\n');
    git(['add', 'g.txt']);
    git(['commit', '-qm', 'via link'], { GIT_INDEX_FILE: join(link, '.git', 'index') }, link);
    expect(views().map((view) => [view.carrier, view.staged])).toEqual([
      [null, ['f.txt']],
      [null, ['g.txt']],
    ]);
  });

  it('a monorepo package block judges the commit index from inside the package', () => {
    const { pkg, git, views } = seedHookedRepo('packages/app');
    writeFileSync(join(pkg, 'f.txt'), 'edited\n');
    git(['commit', '-qam', 'pkg']);
    expect(views()[0].staged).toEqual(['packages/app/f.txt']);
  });

  it('a baseline lowered during `commit -a` lands in the commit and leaves a clean tree', () => {
    const { pkg, git } = seedHookedRepo();
    writeFileSync(join(pkg, 'f.txt'), 'edited\n');
    git(['commit', '-qam', 'lower'], { STUB_BASELINE: '1' });
    expect(git(['show', '--name-only', '--format=', 'HEAD']).trim().split('\n').sort()).toEqual([
      'baseline.json',
      'f.txt',
    ]);
    expect(git(['status', '--porcelain'])).toBe('');
  });

  it('a baseline lowered during a partial commit stays unstaged instead of corrupting the index', () => {
    const { pkg, git } = seedHookedRepo();
    writeFileSync(join(pkg, 'f.txt'), 'edited\n');
    git(['commit', '-qm', 'partial', '--', 'f.txt'], { STUB_BASELINE: '1' });
    expect(git(['show', '--name-only', '--format=', 'HEAD']).trim()).toBe('f.txt');
    expect(git(['status', '--porcelain'])).toBe(' M baseline.json\n');
  });
});

describe('DK_COMMIT_INDEX_CAPTURE', () => {
  const capture = (cwd: string, env: NodeJS.ProcessEnv) =>
    spawnSync(
      'sh',
      [
        '-e',
        '-c',
        `${DK_COMMIT_INDEX_CAPTURE}\necho "carrier:\${DEVKIT_COMMIT_INDEX_FILE:-unset}"`,
      ],
      { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS },
    );

  it('fails open outside a repository and clears an inherited carrier', () => {
    const result = capture(mkTmp('commit-index-norepo-'), {
      GIT_INDEX_FILE: '/nowhere/index.lock',
      DEVKIT_COMMIT_INDEX_FILE: '/stale/index.lock',
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('carrier:unset');
  });

  it('keeps a trailing newline in the repository path exact', () => {
    const repo = join(realpathSync(mkTmp('commit-index-nl-')), 'repo\n');
    mkdirSync(repo);
    spawnSync('git', ['init', '-q'], { cwd: repo, timeout: SPAWN_TIMEOUT_MS });
    const result = spawnSync(
      'sh',
      ['-e', '-c', `${DK_COMMIT_INDEX_CAPTURE}\nprintf '%s|' "$DEVKIT_COMMIT_INDEX_FILE"`],
      {
        cwd: repo,
        env: { ...process.env, GIT_INDEX_FILE: join(repo, '.git', 'alt') },
        encoding: 'utf8',
        timeout: SPAWN_TIMEOUT_MS,
      },
    );
    expect(result.stdout).toBe(`${join(repo, '.git', 'alt')}|`);
  });

  it('runs before the package `cd` and ahead of the commit-msg judges', () => {
    const overlay = buildOverlayHook({ guards: ['size'] }, '.husky/pre-commit', 'pkg');
    expect(overlay.indexOf('# devkit:commit-index')).toBeLessThan(overlay.indexOf('( cd "pkg"'));
    for (const pkgRel of ['', 'pkg']) {
      const block = buildCommitMsgBlock({ guards: ['review'] }, pkgRel) ?? '';
      expect(block.indexOf('# /devkit:commit-index')).toBeGreaterThan(-1);
      expect(block.indexOf('# /devkit:commit-index')).toBeLessThan(block.indexOf('( cd') >>> 0);
    }
  });
});

// Allowed index readers that do not call commitIndexEnv themselves, with the reason.
const ROUTED_ELSEWHERE = {
  'gate-engine/decisions/check-alignment.mts': 'argv routed through decisions/git-io.mts git()',
  'gate-engine/decisions/depth/depth-pass.mts': 'argv routed through decisions/git-io.mts git()',
  'gate-engine/decisions/detect.mts': 'argv routed through decisions/git-io.mts git()',
  'gate-engine/review/baseline-gate.mts': 'review-mode only, in devkit review scratch worktrees',
} satisfies Record<string, string>;
const INDEX_READ_RE =
  /'--cached'|'ls-files'|'write-tree'|'diff-index'|['"]git (diff --cached|write-tree|ls-files|diff-index)|'show', `:/;

function sources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (['eval', '__tests__', 'node_modules'].includes(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sources(path, found);
    else if (path.endsWith('.mts') && !path.endsWith('.test.mts')) found.push(path);
  }
  return found;
}

describe('index readers opt into the commit index', () => {
  const files = [
    ...sources(join(REPO, 'gate-engine')),
    ...sources(join(REPO, 'cli/lib/install/anti-slop')),
  ];

  it('finds sources (guards against an empty-loop pass)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('every gate module that reads the index goes through commitIndexEnv', () => {
    const offenders = files
      .map((file) => relative(REPO, file))
      .filter((rel) => !(rel in ROUTED_ELSEWHERE))
      .filter((rel) => {
        const text = readFileSync(join(REPO, rel), 'utf8');
        return INDEX_READ_RE.test(text) && !text.includes('commitIndexEnv');
      });
    expect(
      offenders,
      'route these git calls through gate-engine/ratchets/commit-index.mts',
    ).toEqual([]);
  });
});
