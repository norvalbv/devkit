import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testSpawnSync as spawnSync } from './_helpers.mts';
import { bodyUpdateRepo, GIT_ENV, reshipScript } from './_ship-branch-fixture.mts';

// A `--pr` resume that replays a recorded body whose --body-file has since changed publishes the
// RECORDED bytes as the PR description; the drift must sit on the line right after the PR URL.

const URL = 'https://github.com/acme/app/pull/7';
const TAIL = 'the PR description is the RECORDED body';

/** stderr merged into stdout, so the assertion sees the order a reader of the terminal sees. */
function mergedLines(args, dir, env = {}) {
  const r = spawnSync('/bin/bash', ['-c', '/bin/bash "$@" 2>&1', '_', reshipScript, ...args], {
    cwd: dir,
    input: '',
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV, ...env },
  });
  expect(r.status, r.stdout).toBe(0);
  return r.stdout.split('\n');
}

function expectTailAfterUrl(lines) {
  const at = lines.indexOf(URL);
  expect(at, lines.join('\n')).toBeGreaterThan(-1);
  expect(lines[at + 1]).toContain(`${TAIL} (9 bytes)`);
  expect(lines[at + 1]).toContain(`devkit ship --pr feat/pr 'add v2' --body-file `);
  expect(lines.filter((l) => l.includes(TAIL))).toHaveLength(1);
}

describe('reship --resume: body drift repeated beside the PR URL', () => {
  it('after a blocked attempt resumes with a commit delta', () => {
    const { dir, env, ghBody } = bodyUpdateRepo({ hookBody: 'exit 1' });
    writeFileSync(join(dir, 'a.ts'), 'v2\n');
    writeFileSync(join(dir, 'body.md'), 'recorded\n');
    const blocked = spawnSync(
      '/bin/bash',
      [reshipScript, 'feat/pr', 'add v2', '--pr', '--body-file', 'body.md', '--', 'a.ts'],
      { cwd: dir, input: '', encoding: 'utf8', env: { ...process.env, ...GIT_ENV, ...env } },
    );
    expect(blocked.status).not.toBe(0);
    writeFileSync(join(dir, 'body.md'), 'edited after the block\n');
    writeFileSync(join(dir, '.husky/_/pre-commit'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(dir, '.husky/_/pre-commit'), 0o755);

    expectTailAfterUrl(mergedLines(['--resume', 'feat/pr'], dir, env));
    expect(readFileSync(ghBody, 'utf8')).toBe('recorded\n');
  });

  it('after a lost push response resumes with no commit delta (body-only publication)', () => {
    const { bare, dir, env, g, ghBody } = bodyUpdateRepo();
    const head = () => g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr']);
    writeFileSync(join(dir, 'a.ts'), 'v2\n');
    writeFileSync(join(dir, 'body.md'), 'recorded\n');
    const lost = spawnSync(
      '/bin/bash',
      [reshipScript, 'feat/pr', 'add v2', '--pr', '--body-file', 'body.md', '--', 'a.ts'],
      {
        cwd: dir,
        input: '',
        encoding: 'utf8',
        env: { ...process.env, ...GIT_ENV, ...env, FAIL_AFTER_PUSH: '1' },
      },
    );
    expect(lost.status).not.toBe(0);
    writeFileSync(join(dir, 'body.md'), 'edited after the push\n');
    const pushed = head();

    expectTailAfterUrl(mergedLines(['--resume', 'feat/pr'], dir, env));
    expect(head()).toBe(pushed); // the no-delta arm: nothing new was pushed
    expect(readFileSync(ghBody, 'utf8')).toBe('recorded\n');
  });
});
