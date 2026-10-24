/** An append `devkit ship --pr` names release-only dist drift against the PR's fork point, where CI
 *  judges it, so an artifact the PR itself added and then rebuilt is never called drift. */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { rootRegistry, testSpawnSync } from './_helpers.mts';

const { mkTmp, cleanup } = rootRegistry();
afterEach(cleanup);
const reship = fileURLToPath(new URL('../lib/ship/reship.sh', import.meta.url));
const distIntegrity = fileURLToPath(new URL('../lib/ship/dist-integrity.mts', import.meta.url));
/** The self-host hook extra that refuses a staged rewrite of tracked dist. */
const RELEASE_ONLY_HOOK = `exec node ${distIntegrity} --ship-staged`;
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: ENV }).trim();
}

function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

/** devkit's repo with an open PR into `prBase` whose first commit added `dist/cli/new.mjs`. A
 *  `prBase` other than main forks from main and tracks its own `dist/cli/next.mjs`. */
function openPr({ prBase = 'main', name = '@norvalbv/devkit', hook = 'exit 0' } = {}) {
  const bare = mkTmp('reship-drift-origin-');
  git(bare, 'init', '-q', '--bare');
  const root = mkTmp('reship-drift-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'a@b.c');
  git(root, 'config', 'user.name', 'a');
  git(root, 'config', 'commit.gpgsign', 'false');
  write(root, 'package.json', `${JSON.stringify({ name, version: '0.0.1' })}\n`);
  write(root, '.gitignore', 'dist/\n');
  write(root, 'dist/cli/a.mjs', 'export const a = 1;\n');
  write(root, '.husky/_/pre-commit', `#!/bin/sh\n${hook}\n`);
  chmodSync(join(root, '.husky/_/pre-commit'), 0o755);
  git(root, 'add', 'package.json', '.gitignore');
  git(root, 'add', '-f', 'dist/cli/a.mjs');
  git(root, 'commit', '-q', '-m', 'base');
  git(root, 'config', 'core.hooksPath', '.husky/_');
  git(root, 'remote', 'add', 'origin', bare);
  git(root, 'push', '-q', 'origin', 'main');
  git(root, 'fetch', '-q', 'origin');
  git(root, 'remote', 'set-head', 'origin', 'main');
  if (prBase !== 'main') {
    git(root, 'switch', '-q', '-c', prBase);
    write(root, 'dist/cli/next.mjs', 'export const n = 1;\n');
    git(root, 'add', '-f', 'dist/cli/next.mjs');
    git(root, 'commit', '-q', '-m', `${prBase} adds an artifact`);
    git(root, 'push', '-q', 'origin', prBase);
  }
  const forkPoint = git(root, 'rev-parse', 'HEAD');
  write(root, 'dist/cli/new.mjs', 'export const v = 1;\n');
  git(root, 'add', '-f', 'dist/cli/new.mjs');
  git(root, 'commit', '-q', '-m', 'PR commit 1 adds an artifact');
  git(root, 'push', '-q', 'origin', 'HEAD:feat/pr');
  return { forkPoint, root };
}

/** A `gh` that reports PR #7 open against `prBase`, the identity reship reads before a live append.
 *  `mergeBase` answers the compare API; without it that call gets the stub's non-SHA default. */
function ghOpenPrInto(prBase: string, mergeBase?: string) {
  const bin = mkTmp('reship-drift-gh-');
  const log = join(bin, 'calls.log');
  const identity = `7\\tOPEN\\tfeat/pr\\t0\\tacme/app\\t${prBase}\\thttps://github.com/acme/app/pull/7`;
  const compare = mergeBase ? `*" api "*) echo ${mergeBase} ;; ` : '';
  write(
    bin,
    'gh',
    `#!/bin/sh\necho "$*" >> '${log}'\ncase " $* " in *" --json number,state,"*) printf '${identity}\\n' ;; ${compare}*) echo https://github.com/acme/app/pull/7 ;; esac\n`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  return { bin, calls: () => (existsSync(log) ? readFileSync(log, 'utf8') : '') };
}

/** A live append of `paths` onto feat/pr, with `gh` first on PATH. */
function append(root: string, gh: string, ...paths: string[]) {
  return testSpawnSync('/bin/bash', [reship, 'feat/pr', 'v2', '--pr', '--', ...paths], {
    cwd: root,
    input: 'body\n',
    encoding: 'utf8',
    env: { ...ENV, PATH: `${gh}:${ENV.PATH}` },
  });
}

describe('reship — release-only drift on an append', () => {
  it("names main's tracked dist, not the PR's own rebuilt artifact, against the fork point", () => {
    const { forkPoint, root } = openPr();
    write(root, 'dist/cli/new.mjs', 'export const v = 2;\n');
    write(root, 'dist/cli/a.mjs', 'export const a = 2;\n');

    const r = testSpawnSync(
      '/bin/bash',
      [reship, 'feat/pr', 'v2', '--pr', '--', 'dist/cli/new.mjs'],
      {
        cwd: root,
        input: 'body\n',
        encoding: 'utf8',
        env: { ...ENV, SHIP_DRY_RUN: '1' },
      },
    );

    expect(r.stderr).toContain(
      `1 regenerated dist file(s) are release-only drift from ${forkPoint.slice(0, 12)}`,
    );
    expect(r.stderr).toContain('    dist/cli/a.mjs');
    expect(r.stderr).not.toContain('    dist/cli/new.mjs');
  });

  it("judges a PR into a non-default base from that base's fork point, which origin/HEAD is not", () => {
    const { forkPoint, root } = openPr({ prBase: 'next' });
    write(root, 'dist/cli/next.mjs', 'export const n = 2;\n');
    write(root, 'dist/cli/new.mjs', 'export const v = 2;\n');
    const gh = ghOpenPrInto('next', forkPoint);

    const r = testSpawnSync(
      '/bin/bash',
      [reship, 'feat/pr', 'v2', '--pr', '--', 'dist/cli/new.mjs'],
      {
        cwd: root,
        input: 'body\n',
        encoding: 'utf8',
        env: { ...ENV, PATH: `${gh.bin}:${ENV.PATH}` },
      },
    );

    expect(gh.calls()).toContain(`/compare/next...${git(root, 'rev-parse', 'HEAD')}?`);
    expect(r.stderr).toContain(
      `1 regenerated dist file(s) are release-only drift from ${forkPoint.slice(0, 12)}`,
    );
    expect(r.stderr).toContain('    dist/cli/next.mjs');
    expect(r.stderr).not.toContain('    dist/cli/new.mjs');
  });

  it('falls back to origin/HEAD when the PR base was never fetched, never to the PR tip', () => {
    const { forkPoint, root } = openPr();
    write(root, 'dist/cli/new.mjs', 'export const v = 2;\n');
    write(root, 'dist/cli/a.mjs', 'export const a = 2;\n');
    const gh = ghOpenPrInto('unfetched').bin;

    const r = testSpawnSync(
      '/bin/bash',
      [reship, 'feat/pr', 'v2', '--pr', '--', 'dist/cli/new.mjs'],
      {
        cwd: root,
        input: 'body\n',
        encoding: 'utf8',
        env: { ...ENV, PATH: `${gh}:${ENV.PATH}` },
      },
    );

    expect(r.stderr).toContain(
      `1 regenerated dist file(s) are release-only drift from ${forkPoint.slice(0, 12)}`,
    );
    expect(r.stderr).not.toContain('    dist/cli/new.mjs');
  });
});

describe('reship — the release-only dist refusal on an append', () => {
  const SKIPPED = 'local release-only dist check skipped';

  it("refuses a rewrite of dist tracked at the PR's merge-base, which GitHub names", () => {
    const { forkPoint, root } = openPr({ hook: RELEASE_ONLY_HOOK });
    const tip = git(root, 'rev-parse', 'HEAD');
    write(root, 'dist/cli/a.mjs', 'export const a = 2;\n');

    const r = append(root, ghOpenPrInto('main', forkPoint).bin, 'dist/cli/a.mjs');

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('this ship rewrites tracked dist, which is release-only');
    expect(git(root, 'ls-remote', 'origin', 'refs/heads/feat/pr').split('\t')[0]).toBe(tip);
  });

  it('passes an edit of a dist file the PR added, even when local origin/main is stale', () => {
    const { forkPoint, root } = openPr({ hook: RELEASE_ONLY_HOOK });
    // A release on main rewrote a.mjs and added rel.mjs, and the PR merged it in; this checkout never
    // fetched main again. Its local edit of rel.mjs is drift the hook would refuse, so it is named.
    git(root, 'switch', '-q', '-c', 'release', forkPoint);
    write(root, 'dist/cli/a.mjs', 'export const a = 2;\n');
    write(root, 'dist/cli/rel.mjs', 'export const r = 1;\n');
    git(root, 'add', '-f', 'dist/cli/a.mjs', 'dist/cli/rel.mjs');
    git(root, 'commit', '-q', '-m', 'release rewrites dist');
    const release = git(root, 'rev-parse', 'HEAD');
    git(root, 'push', '-q', 'origin', 'HEAD:main');
    git(root, 'update-ref', 'refs/remotes/origin/main', forkPoint);
    git(root, 'switch', '-q', '-');
    git(root, 'merge', '-q', '--no-edit', release);
    git(root, 'push', '-q', 'origin', 'HEAD:feat/pr');
    write(root, 'dist/cli/new.mjs', 'export const v = 2;\n');
    write(root, 'dist/cli/rel.mjs', 'export const r = 2;\n');

    const r = append(root, ghOpenPrInto('main', release).bin, 'dist/cli/new.mjs');

    expect(r.stderr).not.toContain('this ship rewrites tracked dist');
    expect(r.stderr).toContain(
      `1 regenerated dist file(s) are release-only drift from ${release.slice(0, 12)}`,
    );
    expect(r.stderr).toContain('    dist/cli/rel.mjs');
    expect(r.status).toBe(0);
    expect(git(root, 'show', 'origin/feat/pr:dist/cli/new.mjs')).toBe('export const v = 2;');
  });

  it('proceeds with one skip line when GitHub does not answer with a merge-base', () => {
    const { root } = openPr({ hook: RELEASE_ONLY_HOOK });
    write(root, 'dist/cli/a.mjs', 'export const a = 2;\n');

    const r = append(root, ghOpenPrInto('main').bin, 'dist/cli/a.mjs');

    expect(r.status).toBe(0);
    expect(r.stderr.split(SKIPPED)).toHaveLength(2);
    expect(git(root, 'show', 'origin/feat/pr:dist/cli/a.mjs')).toBe('export const a = 2;');
  });

  it('never exports a well-formed SHA this checkout does not have as an ancestor of the PR tip', () => {
    const { root } = openPr({ hook: RELEASE_ONLY_HOOK });
    write(root, 'dist/cli/new.mjs', 'export const v = 2;\n');

    const r = append(root, ghOpenPrInto('main', 'f'.repeat(40)).bin, 'dist/cli/new.mjs');

    expect(r.stderr.split(SKIPPED)).toHaveLength(2);
    expect(r.stderr).not.toContain('dist integrity preflight could not run');
    expect(r.status).toBe(0);
  });

  it('asks nothing and prints nothing in a repo that is not devkit', () => {
    const { forkPoint, root } = openPr({ name: 'consumer-app' });
    write(root, 'dist/cli/new.mjs', 'export const v = 2;\n');
    const gh = ghOpenPrInto('main', forkPoint);

    const r = append(root, gh.bin, 'dist/cli/new.mjs');

    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain(SKIPPED);
    expect(gh.calls()).not.toMatch(/^api /m);
  });
});
