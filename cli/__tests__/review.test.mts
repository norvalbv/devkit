import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildFullHook, buildOverlayHook } from '../lib/husky/husky-block.mts';
import { CLI } from './_helpers.mts';

vi.setConfig({ testTimeout: 30_000 });

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const roots: string[] = [];
const hasTimeoutBin = (() => {
  try {
    execFileSync('bash', ['-c', 'command -v timeout || command -v gtimeout'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

afterEach(() => {
  while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function seedReviewRepo(hookBody = 'git diff --cached --name-status\nexit 0') {
  const root = mkdtempSync(join(tmpdir(), 'devkit-review-'));
  roots.push(root);
  const env = { ...process.env, ...GIT_ENV, DEVKIT_NO_TELEMETRY: '1' };
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim();

  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'review@test.invalid']);
  git(['config', 'user.name', 'Review Test']);
  git(['config', 'commit.gpgsign', 'false']);
  mkdirSync(join(root, '.devkit'), { recursive: true });
  mkdirSync(join(root, '.husky/_'), { recursive: true });
  const components = { biome: false, guards: [], husky: true, structure: false };
  writeFileSync(
    join(root, '.devkit/config.json'),
    `${JSON.stringify({ overlay: false, components }, null, 2)}\n`,
  );
  const committedHook = buildFullHook(components).replace(
    '\n\nexit 0\n',
    `\n${hookBody}\n\nexit 0\n`,
  );
  writeFileSync(join(root, '.husky/pre-commit'), committedHook);
  chmodSync(join(root, '.husky/pre-commit'), 0o755);
  writeFileSync(join(root, '.husky/_/pre-commit'), '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n');
  chmodSync(join(root, '.husky/_/pre-commit'), 0o755);
  writeFileSync(
    join(root, '.husky/_/h'),
    '#!/usr/bin/env sh\nn=$(basename "$0")\ns=$(dirname "$(dirname "$0")")/$n\n[ ! -f "$s" ] && exit 0\nsh -e "$s" "$@"\n',
  );
  chmodSync(join(root, '.husky/_/h'), 0o755);
  writeFileSync(join(root, '.gitignore'), '.husky/_/\n.devkit/review-runs/\nsecret.txt\n');
  writeFileSync(join(root, 'app.ts'), 'export const value = "base";\n');
  git(['add', '.devkit/config.json', '.husky/pre-commit', '.gitignore', 'app.ts']);
  git(['commit', '-q', '-m', 'base']);
  git(['config', 'core.hooksPath', '.husky/_']);
  return { root, env, git };
}

function review(root: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(process.execPath, [CLI, 'review', ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
}

function logPath(output: string): string {
  const match = /full output: (.+)$/m.exec(output);
  expect(match, output).toBeTruthy();
  return match?.[1] ?? '';
}

describe('devkit review', () => {
  it.each([
    '--target',
    '--base',
  ])('rejects duplicate %s options before target resolution', (flag) => {
    const { root, env } = seedReviewRepo('echo MUST_NOT_RUN\nexit 1');
    const value = flag === '--target' ? root : 'main';

    const r = review(root, env, flag, value, flag, value);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${flag} may only be specified once`);
    expect(r.stderr).not.toContain('MUST_NOT_RUN');
  });

  it('refuses to run when the local review profile is disabled', () => {
    const { root, env } = seedReviewRepo('echo MUST_NOT_RUN\nexit 1');
    const cfgPath = join(root, '.devkit/config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.review = { enabled: false, guards: [], decisionsDir: 'docs/decisions' };
    writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);

    const r = review(root, env, '--base', 'main');

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/disabled by \.devkit\/config\.json/);
    expect(r.stderr).toMatch(/devkit init --review/);
    expect(r.stderr).not.toMatch(/MUST_NOT_RUN/);
  });

  it('passes the review allowlist, decision directory, and mode into the hook', () => {
    const { root, env } = seedReviewRepo(
      'printf "PROFILE=%s|%s|%s\\n" "$DEVKIT_REVIEW_GUARDS" "$GUARD_DECISIONS_DIR" "$DEVKIT_RUN_MODE"\nexit 0',
    );
    const cfgPath = join(root, '.devkit/config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.review = { enabled: true, guards: [], decisionsDir: 'architecture/decisions' };
    writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
    writeFileSync(join(root, 'app.ts'), 'review profile change\n');

    const r = review(root, env, '--base', 'main');

    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(logPath(r.stderr), 'utf8')).toMatch(
      /PROFILE=\|architecture\/decisions\|review/,
    );
  });

  it('projects the current packaged reviewer briefs and skills into an isolated runtime', () => {
    const { root, env } = seedReviewRepo(
      [
        'test -n "$DEVKIT_REVIEW_ASSET_ROOT"',
        'test -f "$DEVKIT_REVIEW_ASSET_ROOT/agents/api-security-reviewer.md"',
        'test -f "$DEVKIT_REVIEW_ASSET_ROOT/skills/api-security/SKILL.md"',
        'test -f "$DEVKIT_REVIEW_ASSET_ROOT/skills/_devkit/review-roots.mjs"',
        'case "$DEVKIT_REVIEW_ASSET_ROOT" in *" "*) exit 9;; esac',
        'echo REVIEW_ASSETS_OK',
        'exit 0',
      ].join('\n'),
    );
    writeFileSync(join(root, 'app.ts'), 'review assets change\n');

    const r = review(root, env, '--base', 'main');

    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(logPath(r.stderr), 'utf8')).toContain('REVIEW_ASSETS_OK');
  });

  it('never stages a materializer-projected Husky runner symlink when an old target does not ignore it', () => {
    const { root, env } = seedReviewRepo(
      'git diff --cached --name-only | grep -q "^\\.husky/_" && exit 8\necho RUNNER_EXCLUDED\nexit 0',
    );
    const projection = mkdtempSync(join(tmpdir(), 'devkit-review-husky-runner-'));
    roots.push(projection);
    renameSync(join(root, '.husky/_'), join(projection, '_'));
    execFileSync('ln', ['-s', join(projection, '_'), join(root, '.husky/_')]);
    writeFileSync(join(root, '.gitignore'), '.devkit/review-runs/\nsecret.txt\n');
    writeFileSync(join(root, 'app.ts'), 'old ignore change\n');

    const r = review(root, env, '--base', 'main');

    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(logPath(r.stderr), 'utf8')).toContain('RUNNER_EXCLUDED');
  });

  it('uses but never stages a materializer-projected gate config symlink', () => {
    const { root, env } = seedReviewRepo(
      [
        'test -f guard.config.json',
        'git diff --cached --name-only | grep -q "^guard.config.json$" && exit 8',
        'echo PROJECTED_CONFIG_OK',
        'exit 0',
      ].join('\n'),
    );
    const projection = mkdtempSync(join(tmpdir(), 'devkit-review-guard-config-'));
    roots.push(projection);
    const config = join(projection, 'guard.config.json');
    writeFileSync(config, '{"scanRoots":["src"]}\n');
    execFileSync('ln', ['-s', config, join(root, 'guard.config.json')]);
    writeFileSync(join(root, 'app.ts'), 'projected config change\n');

    const r = review(root, env, '--base', 'main');

    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(logPath(r.stderr), 'utf8')).toContain('PROJECTED_CONFIG_OK');
  });

  it('preserves configured global excludes while adding review-only capture exclusions', () => {
    const { root, env } = seedReviewRepo(
      [
        'test ! -e global-secret.txt',
        'git diff --cached --name-only | grep -q "^global-secret.txt$" && exit 8',
        'echo GLOBAL_EXCLUDES_OK',
        'exit 0',
      ].join('\n'),
    );
    const gitHome = mkdtempSync(join(tmpdir(), 'devkit-review-global-excludes-'));
    roots.push(gitHome);
    const globalExcludes = join(gitHome, 'ignore');
    const globalConfig = join(gitHome, 'gitconfig');
    writeFileSync(globalExcludes, 'global-secret.txt\n');
    execFileSync('git', ['config', '--file', globalConfig, 'core.excludesFile', globalExcludes]);
    writeFileSync(join(root, 'global-secret.txt'), 'do not review\n');
    writeFileSync(join(root, 'app.ts'), 'reviewable change\n');

    const r = review(root, { ...env, GIT_CONFIG_GLOBAL: globalConfig }, '--base', 'main');

    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(logPath(r.stderr), 'utf8')).toContain('GLOBAL_EXCLUDES_OK');
  });

  it('rejects review guards that are not installed commit guards', () => {
    const { root, env } = seedReviewRepo();
    const cfgPath = join(root, '.devkit/config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.review = { enabled: true, guards: ['decisions'], decisionsDir: 'docs/decisions' };
    writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);

    const r = review(root, env, '--base', 'main');

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/unknown or uninstalled guards: decisions/);
  });

  it('uses normalized legacy component defaults instead of claiming opt-in review is installed', () => {
    const { root, env } = seedReviewRepo();
    const cfgPath = join(root, '.devkit/config.json');
    writeFileSync(
      cfgPath,
      `${JSON.stringify(
        {
          overlay: false,
          review: { enabled: true, guards: ['review'], decisionsDir: 'docs/decisions' },
        },
        null,
        2,
      )}\n`,
    );

    const r = review(root, env, '--base', 'main');

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/unknown or uninstalled guards: review/);
  });

  it('reviews committed branch changes plus the final local snapshot without mutating the target', () => {
    const hook = [
      'echo REVIEW_HOOK',
      'git diff --cached --name-status',
      'printf "APP="; cat app.ts',
      'test ! -e secret.txt',
      'exit 0',
    ].join('\n');
    const { root, env, git } = seedReviewRepo(hook);
    git(['switch', '-q', '-c', 'feature']);
    writeFileSync(join(root, 'committed.ts'), 'export const committed = true;\n');
    git(['add', 'committed.ts']);
    git(['commit', '-q', '-m', 'feature']);
    writeFileSync(join(root, 'app.ts'), 'export const value = "local";\n');
    writeFileSync(join(root, 'untracked.ts'), 'export const untracked = true;\n');
    writeFileSync(join(root, 'secret.txt'), 'ignored\n');
    const beforeHead = git(['rev-parse', 'HEAD']);
    const beforeStatus = git(['status', '--porcelain=v1']);
    const beforeCommits = git(['rev-list', '--count', 'HEAD']);

    const r = review(root, env, '--base', 'main');

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/trusted target/i);
    const log = readFileSync(logPath(r.stderr), 'utf8');
    expect(log).toMatch(/REVIEW_HOOK/);
    expect(log).toMatch(/A\s+committed\.ts/);
    expect(log).toMatch(/M\s+app\.ts/);
    expect(log).toMatch(/A\s+untracked\.ts/);
    expect(log).toMatch(/APP=export const value = "local"/);
    expect(git(['rev-parse', 'HEAD'])).toBe(beforeHead);
    expect(git(['status', '--porcelain=v1'])).toBe(beforeStatus);
    expect(git(['rev-list', '--count', 'HEAD'])).toBe(beforeCommits);
    expect(git(['worktree', 'list', '--porcelain'])).not.toMatch(/devkit-review-run-/);
  });

  it('supports --target and infers origin/HEAD before local main', () => {
    const { root, env, git } = seedReviewRepo('echo TARGET_OK\nexit 0');
    git(['update-ref', 'refs/remotes/origin/main', 'main']);
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
    git(['switch', '-q', '-c', 'feature']);
    writeFileSync(join(root, 'feature.ts'), 'export {};\n');
    git(['add', 'feature.ts']);
    git(['commit', '-q', '-m', 'feature']);
    const caller = mkdtempSync(join(tmpdir(), 'devkit-review-caller-'));
    roots.push(caller);

    const r = spawnSync(process.execPath, [CLI, 'review', '--target', root], {
      cwd: caller,
      env,
      encoding: 'utf8',
    });

    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(logPath(r.stderr), 'utf8')).toMatch(/TARGET_OK/);
  });

  it('reviews a materialized worktree whose ignored .devkit directory is projected as a symlink', () => {
    const { root, env, git } = seedReviewRepo(
      'echo PROJECTED_OK\ngit diff --cached --name-status\nexit 0',
    );
    git(['rm', '-q', '--cached', '.devkit/config.json']);
    git(['commit', '-q', '-m', 'local devkit projection']);
    const projection = mkdtempSync(join(tmpdir(), 'devkit-review-projection-'));
    roots.push(projection);
    rmSync(projection, { recursive: true, force: true });
    execFileSync('mv', [join(root, '.devkit'), projection]);
    execFileSync('ln', ['-s', projection, join(root, '.devkit')]);
    writeFileSync(join(root, '.git/info/exclude'), '.devkit\n');
    writeFileSync(join(root, 'app.ts'), 'projected change\n');

    const r = review(root, env, '--base', 'main');

    expect(r.status, r.stderr).toBe(0);
    const log = readFileSync(logPath(r.stderr), 'utf8');
    expect(log).toMatch(/PROJECTED_OK/);
    expect(log).toMatch(/M\s+app\.ts/);
  });

  it('defaults to the containing repository when invoked from a nested directory', () => {
    const { root, env } = seedReviewRepo('echo NESTED_OK\nexit 0');
    const nested = join(root, 'packages/app');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, 'app.ts'), 'nested change\n');

    const r = spawnSync(process.execPath, [CLI, 'review', '--base', 'main'], {
      cwd: nested,
      env,
      encoding: 'utf8',
    });

    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(logPath(r.stderr), 'utf8')).toMatch(/NESTED_OK/);
  });

  it('preserves deletes, binary blobs, symlinks, and executable modes in the synthetic diff', () => {
    const { root, env, git } = seedReviewRepo(
      'git diff --cached --name-status\ngit diff --cached --summary\nexit 0',
    );
    writeFileSync(join(root, 'delete-me.txt'), 'remove\n');
    git(['add', 'delete-me.txt']);
    git(['commit', '-q', '-m', 'seed shapes']);
    rmSync(join(root, 'delete-me.txt'));
    writeFileSync(join(root, 'binary.bin'), Buffer.from([0, 255, 1, 254]));
    writeFileSync(join(root, 'run.sh'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(root, 'run.sh'), 0o755);
    execFileSync('ln', ['-s', 'app.ts', join(root, 'app-link')]);

    const r = review(root, env, '--base', 'main');

    expect(r.status, r.stderr).toBe(0);
    const log = readFileSync(logPath(r.stderr), 'utf8');
    expect(log).toMatch(/D\s+delete-me\.txt/);
    expect(log).toMatch(/A\s+binary\.bin/);
    expect(log).toMatch(/create mode 120000 app-link/);
    expect(log).toMatch(/create mode 100755 run\.sh/);
  });

  it('runs the ignored overlay hook through the forced overlay hook path', () => {
    const { root, env, git } = seedReviewRepo();
    git(['rm', '-q', '--cached', '.devkit/config.json']);
    git(['commit', '-q', '-m', 'overlay owns local config']);
    const components = { biome: false, guards: [], husky: true, structure: false };
    writeFileSync(
      join(root, '.devkit/config.json'),
      `${JSON.stringify({ overlay: true, origHooksPath: '.husky/_', components }, null, 2)}\n`,
    );
    mkdirSync(join(root, '.devkit/hooks'), { recursive: true });
    const overlay = join(root, '.devkit/hooks/pre-commit');
    writeFileSync(overlay, buildOverlayHook(components, '.husky/pre-commit'));
    chmodSync(overlay, 0o755);
    writeFileSync(join(root, '.git/info/exclude'), '.devkit/\n');
    writeFileSync(join(root, 'app.ts'), 'overlay change\n');

    const r = review(root, env, '--base', 'main');

    expect(r.status, r.stderr).toBe(0);
    const log = readFileSync(logPath(r.stderr), 'utf8');
    expect(log).toMatch(/devkit-gates: chain start/);
    expect(log).toMatch(/M\s+app\.ts/);
  });

  it('runs the overlay ESLint comparison against merge-base and blocks only its new error', () => {
    const { root, env, git } = seedReviewRepo();
    git(['rm', '-q', '--cached', '.devkit/config.json']);
    writeFileSync(join(root, 'app.ts'), 'const BAD = 1;\n');
    git(['add', 'app.ts']);
    git(['commit', '-q', '-m', 'overlay baseline']);
    const components = { biome: false, guards: [], husky: true, structure: false };
    writeFileSync(
      join(root, '.devkit/config.json'),
      `${JSON.stringify({ overlay: true, origHooksPath: '.husky/_', components }, null, 2)}\n`,
    );
    mkdirSync(join(root, '.devkit/hooks'), { recursive: true });
    const overlay = join(root, '.devkit/hooks/pre-commit');
    writeFileSync(overlay, buildOverlayHook(components, '.husky/pre-commit'));
    chmodSync(overlay, 0o755);
    writeFileSync(join(root, '.git/info/exclude'), '.devkit/\neslint.config.devkit.mjs\n');
    writeFileSync(join(root, 'eslint.config.devkit.mjs'), 'export default [];\n');
    const eslint = join(root, '.fake-eslint');
    writeFileSync(
      eslint,
      `#!${process.execPath}\nconst fs = require('node:fs'); const path = require('node:path'); const split = process.argv.indexOf('--'); const out = process.argv.slice(split + 1).map((file) => { const filePath = path.resolve(process.cwd(), file); const source = fs.readFileSync(filePath, 'utf8'); const messages = source.split(/\\r?\\n/).flatMap((line, i) => line.includes('BAD') ? [{severity:2,line:i+1,column:7,ruleId:'no-bad',message:'bad',nodeType:'Identifier'}] : []); return {filePath,source,messages}; }); process.stdout.write(JSON.stringify(out)); process.exit(out.some((item) => item.messages.length) ? 1 : 0);\n`,
    );
    chmodSync(eslint, 0o755);
    writeFileSync(
      join(root, '.git/info/exclude'),
      '.devkit/\neslint.config.devkit.mjs\n.fake-eslint\n',
    );
    writeFileSync(join(root, 'app.ts'), '// shifted\nconst BAD = 1;\nconst BAD = 2;\n');

    const r = review(root, { ...env, DEVKIT_REVIEW_ESLINT_BIN: eslint }, '--base', 'main');

    expect(r.status).toBe(1);
    const log = readFileSync(logPath(r.stderr), 'utf8');
    expect(log).toContain('1 new error(s)');
    expect(log).toContain('app.ts:3:7');
    expect(log).not.toContain('app.ts:2:7');
    expect(readFileSync(join(root, 'app.ts'), 'utf8')).toContain('const BAD = 2;');
    expect(git(['worktree', 'list', '--porcelain'])).not.toMatch(/devkit-review-(?:run|base)-/);
  });

  it('rejects marker-bearing standalone hook drift that removes a configured gate', () => {
    const { root, env } = seedReviewRepo();
    const components = { biome: false, guards: ['review'], husky: true, structure: false };
    writeFileSync(
      join(root, '.devkit/config.json'),
      `${JSON.stringify({ overlay: false, components }, null, 2)}\n`,
    );
    writeFileSync(
      join(root, '.husky/pre-commit'),
      '#!/bin/sh\n# >>> devkit-guards >>>\n# <<< devkit-guards <<<\nexit 0\n',
    );

    const r = review(root, env, '--base', 'main');

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/differs from the current generator/);
    expect(r.stderr).toMatch(/devkit doctor --fix/);
  });

  it('rejects sentinel-bearing overlay drift that removes a configured gate', () => {
    const { root, env } = seedReviewRepo();
    const components = { biome: false, guards: ['review'], husky: true, structure: false };
    writeFileSync(
      join(root, '.devkit/config.json'),
      `${JSON.stringify({ overlay: true, origHooksPath: '.husky/_', components }, null, 2)}\n`,
    );
    mkdirSync(join(root, '.devkit/hooks'), { recursive: true });
    writeFileSync(
      join(root, '.devkit/hooks/pre-commit'),
      '#!/bin/sh\necho "devkit-gates: chain start"\nexit 0\n',
    );
    chmodSync(join(root, '.devkit/hooks/pre-commit'), 0o755);

    const r = review(root, env, '--base', 'main');

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/overlay pre-commit differs from the current generator/);
    expect(r.stderr).toMatch(/devkit doctor --fix/);
  });

  it('validates devkit hook setup even when there are no changes', () => {
    const { root, env } = seedReviewRepo();
    rmSync(join(root, '.husky/_/pre-commit'));

    const r = review(root, env, '--base', 'main');

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/devkit doctor --fix/);
  });

  it('rejects a drifted effective hook path instead of reporting a clean review', () => {
    const { root, env, git } = seedReviewRepo();
    git(['config', 'core.hooksPath', '.wrong-hooks']);

    const r = review(root, env, '--base', 'main');

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/core\.hooksPath/);
    expect(r.stderr).toMatch(/devkit doctor --fix/);
  });

  it('returns clean without running the hook when the snapshot equals the base', () => {
    const { root, env } = seedReviewRepo('echo MUST_NOT_RUN\nexit 1');

    const r = review(root, env, '--base', 'main');

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/nothing to review/);
    expect(r.stderr).not.toMatch(/MUST_NOT_RUN/);
    expect(readFileSync(logPath(r.stderr), 'utf8')).toMatch(/nothing to review/);
  });

  it('preserves a blocking hook result, writes its log, and removes the worktree', () => {
    const { root, env, git } = seedReviewRepo('echo BLOCK_REASON\nexit 1');
    writeFileSync(join(root, 'app.ts'), 'export const value = "blocked";\n');

    const r = review(root, env, '--base', 'main');

    expect(r.status).toBe(1);
    expect(readFileSync(logPath(r.stderr), 'utf8')).toMatch(/BLOCK_REASON/);
    expect(git(['worktree', 'list', '--porcelain'])).not.toMatch(/devkit-review-run-/);
  });

  it('blocks when the hook reformats the ephemeral staged snapshot', () => {
    const hook = 'printf "formatted\\n" > app.ts\ngit add app.ts\nexit 0';
    const { root, env } = seedReviewRepo(hook);
    writeFileSync(join(root, 'app.ts'), 'needs-formatting\n');

    const r = review(root, env, '--base', 'main');

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/changed the ephemeral staged snapshot/);
    expect(readFileSync(join(root, 'app.ts'), 'utf8')).toBe('needs-formatting\n');
  });

  it('blocks when the hook makes an unstaged formatter edit', () => {
    const hook = 'printf "formatted\\n" > app.ts\nexit 0';
    const { root, env } = seedReviewRepo(hook);
    writeFileSync(join(root, 'app.ts'), 'needs-formatting\n');

    const r = review(root, env, '--base', 'main');

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/changed the ephemeral staged snapshot/);
    expect(readFileSync(join(root, 'app.ts'), 'utf8')).toBe('needs-formatting\n');
  });

  it('uses unique log paths for repeated runs of the same target', () => {
    const { root, env } = seedReviewRepo('echo OK\nexit 0');
    writeFileSync(join(root, 'app.ts'), 'changed\n');

    const a = review(root, env, '--base', 'main');
    const b = review(root, env, '--base', 'main');

    expect(a.status, a.stderr).toBe(0);
    expect(b.status, b.stderr).toBe(0);
    const aLog = logPath(a.stderr);
    const bLog = logPath(b.stderr);
    expect(aLog).not.toBe(bLog);
    expect(existsSync(aLog)).toBe(true);
    expect(existsSync(bLog)).toBe(true);
  });

  it.runIf(hasTimeoutBin)(
    'preserves timeout status, names unfinished reviewers, and cleans up',
    () => {
      const hook = [
        'printf \'{"running":["correctness"],"completed":[]}\\n\' > "$DEVKIT_REVIEW_PROGRESS"',
        'sleep 30 &',
        'sleep 30',
      ].join('\n');
      const { root, env, git } = seedReviewRepo(hook);
      writeFileSync(join(root, 'app.ts'), 'timeout change\n');

      const r = review(root, { ...env, SHIP_COMMIT_TIMEOUT: '1' }, '--base', 'main');

      expect(r.status).toBe(124);
      expect(r.stderr).toMatch(/gate chain hit the 1s ceiling/);
      expect(r.stderr).toMatch(/unfinished.*correctness/i);
      expect(git(['worktree', 'list', '--porcelain'])).not.toMatch(/devkit-review-run-/);
    },
  );

  it('fails clearly for an unknown base without fetching', () => {
    const { root, env } = seedReviewRepo();

    const r = review(root, env, '--base', 'origin/not-here');

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/could not resolve base/);
  });
});
