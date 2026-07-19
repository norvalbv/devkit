import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { rootRegistry } from './_helpers.mts';

const SUBMODULE_SCRIPT = fileURLToPath(
  new URL('../lib/ship/review/submodules.sh', import.meta.url),
);
const { mkTmp, cleanup } = rootRegistry();

const BASE_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Review Submodule Test',
  GIT_AUTHOR_EMAIL: 'review-submodule@test.invalid',
  GIT_COMMITTER_NAME: 'Review Submodule Test',
  GIT_COMMITTER_EMAIL: 'review-submodule@test.invalid',
};

afterEach(cleanup);

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, {
    cwd,
    env: BASE_ENV,
    encoding: 'utf8',
  });
}

function initRepo(root: string, filename: string, content: string) {
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Review Submodule Test');
  git(root, 'config', 'user.email', 'review-submodule@test.invalid');
  writeFileSync(join(root, filename), content);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'initial');
}

type Fixture = {
  root: string;
  source: string;
  review: string;
  manifest: string;
  modulePath: string;
  nestedPath: string | null;
  moduleOid: string;
  nestedOid: string | null;
  hookMarker: string;
};

function fixture(options: { nested?: boolean } = {}): Fixture {
  const root = mkTmp('devkit review submodules-');
  const source = join(root, 'source checkout');
  const review = join(root, 'review checkout');
  const moduleRepo = join(root, 'module origin');
  const nestedRepo = join(root, 'nested origin');
  const modulePath = 'modules/module\nline';
  const nestedPath = options.nested === false ? null : 'nested/dependency\nline';
  initRepo(moduleRepo, 'module.txt', 'module committed\n');

  let nestedOid: string | null = null;
  if (nestedPath) {
    initRepo(nestedRepo, 'nested.txt', 'nested committed\n');
    git(
      moduleRepo,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      '--name',
      'nested-fixture',
      nestedRepo,
      nestedPath,
    );
    git(moduleRepo, 'commit', '-q', '-am', 'add nested module');
    nestedOid = git(nestedRepo, 'rev-parse', 'HEAD').trim();
  }

  mkdirSync(source);
  git(source, 'init', '-q', '-b', 'main');
  git(source, 'config', 'user.name', 'Review Submodule Test');
  git(source, 'config', 'user.email', 'review-submodule@test.invalid');
  writeFileSync(join(source, 'root.txt'), 'root\n');
  git(source, 'add', 'root.txt');
  git(source, 'commit', '-q', '-m', 'root');
  git(
    source,
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    '-q',
    '--name',
    'module-fixture',
    moduleRepo,
    modulePath,
  );
  git(source, 'commit', '-q', '-am', 'add module');
  git(source, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive');
  git(source, 'worktree', 'add', '-q', '--detach', review, 'HEAD');

  const manifest = join(root, 'private runtime', 'submodules.manifest');
  mkdirSync(dirname(manifest));
  const moduleOid = git(source, 'rev-parse', `HEAD:${modulePath}`).trim();
  const moduleCommon = git(
    join(source, modulePath),
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ).trim();
  const hooks = join(moduleCommon, 'review-test-hooks');
  const hookMarker = join(root, 'hook-ran');
  mkdirSync(hooks);
  writeFileSync(
    join(hooks, 'post-checkout'),
    `#!/bin/sh\nprintf ran > ${JSON.stringify(hookMarker)}\n`,
  );
  chmodSync(join(hooks, 'post-checkout'), 0o755);
  git(join(source, modulePath), 'config', 'core.hooksPath', hooks);

  return {
    root,
    source,
    review,
    manifest,
    modulePath,
    nestedPath,
    moduleOid,
    nestedOid,
    hookMarker,
  };
}

function run(
  operation: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
) {
  return spawnSync(
    '/bin/bash',
    [
      '-c',
      'source "$1"; shift; "$@"',
      'review-submodule-test',
      SUBMODULE_SCRIPT,
      operation,
      ...args,
    ],
    {
      cwd: options.cwd,
      env: { ...BASE_ENV, ...options.env },
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
}

function manifestFields(path: string) {
  const bytes = readFileSync(path);
  expect(bytes.at(-1)).toBe(0);
  return bytes.subarray(0, -1).toString('utf8').split('\0');
}

describe('review submodule materialization', () => {
  it('allocates scratch files under the runner private temp root', () => {
    const root = mkTmp('devkit review submodule temp-');
    const runtime = join(root, 'private runtime');
    mkdirSync(runtime);

    const result = run('_review_submodule_temp', ['scan'], {
      env: { DEVKIT_REVIEW_TEMP_ROOT: runtime },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.endsWith('\0')).toBe(true);
    const scratch = result.stdout.slice(0, -1);
    expect(dirname(scratch)).toBe(realpathSync(runtime));
    rmSync(scratch);
  });

  it('accepts a repository with no staged gitlinks', () => {
    const root = mkTmp('devkit review without submodules-');
    const source = join(root, 'source');
    const review = join(root, 'review');
    const manifest = join(root, 'private', 'submodules.manifest');
    initRepo(source, 'root.txt', 'root\n');
    git(source, 'worktree', 'add', '-q', '--detach', review, 'HEAD');
    mkdirSync(dirname(manifest));

    const materialized = run('review_materialize_submodules', [review, source, manifest]);
    expect(materialized.status, materialized.stderr).toBe(0);
    expect(manifestFields(manifest)).toEqual(['devkit-review-submodules-v1']);
    const verified = run('review_verify_submodules', [manifest]);
    expect(verified.status, verified.stderr).toBe(0);
    const cleaned = run('review_cleanup_submodules', [manifest]);
    expect(cleaned.status, cleaned.stderr).toBe(0);
  });

  it('uses only local common object stores, excludes dirty bytes, verifies, and cleans recursively', () => {
    const fx = fixture();
    const sourceModule = join(fx.source, fx.modulePath);
    const sourceNested = join(sourceModule, fx.nestedPath as string);
    writeFileSync(join(sourceModule, 'module.txt'), 'dirty source module\n');
    writeFileSync(join(sourceModule, 'untracked.txt'), 'dirty untracked\n');
    writeFileSync(join(sourceNested, 'nested.txt'), 'dirty source nested\n');

    const warning = run('review_warn_dirty_source_submodules', [fx.source]);
    expect(warning.status, warning.stderr).toBe(0);
    expect(warning.stderr).toContain('dirty contents are excluded');
    expect(warning.stderr).toContain('modules/module');

    const bin = join(fx.root, 'git wrapper');
    const realGit = execFileSync('/bin/bash', ['-c', 'command -v git'], {
      encoding: 'utf8',
    }).trim();
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'git'),
      '#!/bin/sh\nfor arg in "$@"; do\n  case "$arg" in fetch|clone|submodule) echo "forbidden git $arg" >&2; exit 97;; esac\ndone\nexec "$REAL_GIT" "$@"\n',
    );
    chmodSync(join(bin, 'git'), 0o755);
    const materialized = run('review_materialize_submodules', [fx.review, fx.source, fx.manifest], {
      env: { PATH: `${bin}:${process.env.PATH}`, REAL_GIT: realGit, GIT_DIR: '/invalid' },
    });

    expect(materialized.status, materialized.stderr).toBe(0);
    expect(existsSync(fx.hookMarker)).toBe(false);
    expect(readFileSync(join(fx.review, fx.modulePath, 'module.txt'), 'utf8')).toBe(
      'module committed\n',
    );
    expect(
      readFileSync(join(fx.review, fx.modulePath, fx.nestedPath as string, 'nested.txt'), 'utf8'),
    ).toBe('nested committed\n');
    expect(git(join(fx.review, fx.modulePath), 'rev-parse', 'HEAD').trim()).toBe(fx.moduleOid);
    expect(
      git(join(fx.review, fx.modulePath, fx.nestedPath as string), 'rev-parse', 'HEAD').trim(),
    ).toBe(fx.nestedOid);
    expect(statSync(fx.manifest).mode & 0o777).toBe(0o600);
    const fields = manifestFields(fx.manifest);
    expect(fields[0]).toBe('devkit-review-submodules-v1');
    expect(fields).toHaveLength(9);
    expect(fields[1]).toContain(fx.modulePath);
    expect(fields[3]).toContain(fx.modulePath);
    expect(fields[5]).toContain(fx.nestedPath as string);
    expect(fields[7]).toContain(fx.nestedPath as string);

    const verified = run('review_verify_submodules', [fx.manifest]);
    expect(verified.status, verified.stderr).toBe(0);
    const cleaned = run('review_cleanup_submodules', [fx.manifest]);
    expect(cleaned.status, cleaned.stderr).toBe(0);
    expect(existsSync(join(fx.review, fx.modulePath))).toBe(false);
    expect(existsSync(fx.manifest)).toBe(false);
    const cleanedAgain = run('review_cleanup_submodules', [fx.manifest]);
    expect(cleanedAgain.status, cleanedAgain.stderr).toBe(0);
  });

  it('warns when a clean source submodule HEAD differs from the staged gitlink', () => {
    const fx = fixture({ nested: false });
    const sourceModule = join(fx.source, fx.modulePath);
    writeFileSync(join(sourceModule, 'module.txt'), 'new local submodule commit\n');
    git(sourceModule, 'add', 'module.txt');
    git(sourceModule, 'commit', '-q', '-m', 'advance source submodule only');

    expect(git(sourceModule, 'status', '--porcelain=v1').trim()).toBe('');
    expect(git(sourceModule, 'rev-parse', 'HEAD').trim()).not.toBe(fx.moduleOid);

    const warning = run('review_warn_dirty_source_submodules', [fx.source]);

    expect(warning.status, warning.stderr).toBe(0);
    expect(warning.stderr).toContain('different commit than its staged gitlink');
    expect(warning.stderr).toContain('unstaged submodule commit is excluded');
  });

  it('fails explicitly when an expected source submodule is not initialized', () => {
    const fx = fixture({ nested: false });
    git(fx.source, 'submodule', 'deinit', '-q', '-f', '--', fx.modulePath);

    const result = run('review_materialize_submodules', [fx.review, fx.source, fx.manifest]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('source submodule is not initialized');
    expect(existsSync(fx.manifest)).toBe(false);
  });

  it('fails locally when the staged gitlink OID is absent', () => {
    const fx = fixture({ nested: false });
    const missingOid = '1234567890123456789012345678901234567890';
    git(fx.review, 'update-index', '--cacheinfo', '160000', missingOid, fx.modulePath);

    const result = run('review_materialize_submodules', [fx.review, fx.source, fx.manifest]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('target OID is not available locally');
    expect(result.stderr).toContain(missingOid);
    expect(existsSync(fx.manifest)).toBe(false);
  });

  it('detects changes in a materialized submodule before cleanup', () => {
    const fx = fixture({ nested: false });
    const materialized = run('review_materialize_submodules', [fx.review, fx.source, fx.manifest]);
    expect(materialized.status, materialized.stderr).toBe(0);
    writeFileSync(join(fx.review, fx.modulePath, 'module.txt'), 'mutated during review\n');

    const verified = run('review_verify_submodules', [fx.manifest]);

    expect(verified.status).not.toBe(0);
    expect(verified.stderr).toContain('materialized submodule changed during review');
    const cleaned = run('review_cleanup_submodules', [fx.manifest]);
    expect(cleaned.status, cleaned.stderr).toBe(0);
  });
});
