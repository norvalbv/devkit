/** An append `devkit ship --pr` names release-only dist drift against the PR's fork point, where CI
 *  judges it, so an artifact the PR itself added and then rebuilt is never called drift. */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { rootRegistry, testSpawnSync } from './_helpers.mts';

const { mkTmp, cleanup } = rootRegistry();
afterEach(cleanup);
const reship = fileURLToPath(new URL('../lib/ship/reship.sh', import.meta.url));
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
function openPr(prBase = 'main') {
  const bare = mkTmp('reship-drift-origin-');
  git(bare, 'init', '-q', '--bare');
  const root = mkTmp('reship-drift-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'a@b.c');
  git(root, 'config', 'user.name', 'a');
  git(root, 'config', 'commit.gpgsign', 'false');
  write(
    root,
    'package.json',
    `${JSON.stringify({ name: '@norvalbv/devkit', version: '0.0.1' })}\n`,
  );
  write(root, '.gitignore', 'dist/\n');
  write(root, 'dist/cli/a.mjs', 'export const a = 1;\n');
  write(root, '.husky/_/pre-commit', '#!/bin/sh\nexit 0\n');
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

/** A `gh` that reports PR #7 open against `prBase`, the identity reship reads before a live append. */
function ghOpenPrInto(prBase: string): string {
  const bin = mkTmp('reship-drift-gh-');
  const identity = `7\\tOPEN\\tfeat/pr\\t0\\tacme/app\\t${prBase}\\thttps://github.com/acme/app/pull/7`;
  write(
    bin,
    'gh',
    `#!/bin/sh\ncase " $* " in *" --json number,state,"*) printf '${identity}\\n' ;; *) echo https://github.com/acme/app/pull/7 ;; esac\n`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  return bin;
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
    const { forkPoint, root } = openPr('next');
    write(root, 'dist/cli/next.mjs', 'export const n = 2;\n');
    write(root, 'dist/cli/new.mjs', 'export const v = 2;\n');
    const gh = ghOpenPrInto('next');

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
    expect(r.stderr).toContain('    dist/cli/next.mjs');
    expect(r.stderr).not.toContain('    dist/cli/new.mjs');
  });

  it('falls back to origin/HEAD when the PR base was never fetched, never to the PR tip', () => {
    const { forkPoint, root } = openPr();
    write(root, 'dist/cli/new.mjs', 'export const v = 2;\n');
    write(root, 'dist/cli/a.mjs', 'export const a = 2;\n');
    const gh = ghOpenPrInto('unfetched');

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
