import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testSpawnSync as spawnSync } from './_helpers.mts';
import {
  buildAndRun,
  FLAG_RE,
  ghStub,
  scriptPath,
  seedShipRepoLocalRemote,
} from './_ship-branch-fixture.mts';

describe('ship-branch.sh — --draft', () => {
  /** A gh stub that appends its full argv to `log` and prints a PR URL. */
  const ghArgvStub = (log: string) =>
    ghStub(`printf '%s\\n' "$*" >> '${log}'; echo "https://github.com/acme/app/pull/42"`);

  /** The `pr create` line from a gh argv log, or undefined. */
  const createLine = (log: string) =>
    readFileSync(log, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('pr create'));

  const argvLog = () => join(mkdtempSync(join(tmpdir(), 'gh-argv-')), 'argv.txt');

  it('forwards --draft to gh pr create', () => {
    const { dir, env } = seedShipRepoLocalRemote();
    writeFileSync(join(dir, 'note.txt'), 'hello\n');
    const log = argvLog();

    const r = spawnSync('/bin/bash', [scriptPath, 'feat/draft', 't', '--draft', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, PATH: `${ghArgvStub(log)}:${process.env.PATH}` },
    });

    expect(r.status, r.stderr).toBe(0);
    const create = createLine(log);
    expect(create, `no 'pr create' in gh argv log:\n${readFileSync(log, 'utf8')}`).toBeTruthy();
    expect(create).toContain('--draft');
  });

  // The default must not drift: every existing caller expects a ready-for-review PR.
  it('omits --draft when the flag is absent', () => {
    const { dir, env } = seedShipRepoLocalRemote();
    writeFileSync(join(dir, 'note.txt'), 'hello\n');
    const log = argvLog();

    const r = spawnSync('/bin/bash', [scriptPath, 'feat/ready', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, PATH: `${ghArgvStub(log)}:${process.env.PATH}` },
    });

    expect(r.status, r.stderr).toBe(0);
    expect(createLine(log)).toBeTruthy();
    expect(createLine(log)).not.toContain('--draft');
  });

  // The recovery hint is copy-pasted verbatim. Handing back a bare `gh pr create` after a --draft
  // ship would quietly publish a READY PR — the exact outcome the operator opted out of.
  it('keeps --draft in the manual recovery hint when gh pr create fails', () => {
    const { dir, env } = seedShipRepoLocalRemote();
    writeFileSync(join(dir, 'note.txt'), 'hello\n');
    const stubBin = ghStub('case "$2" in create) exit 1 ;; *) exit 0 ;; esac');

    const r = spawnSync('/bin/bash', [scriptPath, 'feat/draft-fail', 't', '--draft', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, PATH: `${stubBin}:${process.env.PATH}` },
    });

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('push OK but PR create failed');
    expect(r.stderr).toMatch(/gh pr create .*--draft/);
  });

  // --ready belongs to the --pr flow. Reaching ship-branch.sh directly must name that, not fall
  // through to the generic unknown-flag arm.
  it('rejects --ready with guidance toward --draft/--pr', () => {
    const r = buildAndRun('main', 'git@github.com:acme/app.git', {
      argv: ['feat/x', 'title', '--ready', '--', 'dummy-path'],
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('--ready applies to --pr');
    expect(r.stderr).not.toMatch(FLAG_RE);
  });
});

describe('ship — --draft/--ready must not sit in a positional slot', () => {
  for (const flag of ['--draft', '--ready']) {
    it(`rejects ${flag} in a positional slot, naming the ordering rule`, () => {
      const r = buildAndRun('main', 'git@github.com:acme/app.git', {
        argv: [flag, 'somevalue', 'feat/x', 'title', '--', 'dummy-path'],
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/must come FIRST, before any flag/);
      expect(r.stderr).toMatch(new RegExp(`'\\${flag}'`));
      // The whole point: it must NOT reach the internal git call it used to die in.
      expect(r.stderr).not.toMatch(/unknown option/);
    });
  }
});
