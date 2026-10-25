import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderEvidenceBlock, upsertEvidenceBlock } from '../lib/ship/evidence/block.mts';
import { notRun } from '../lib/ship/evidence/outcome.mts';
import { publishBody, replaceCallerText } from '../lib/ship/evidence/pr-body.mts';
import { withPrEvidenceLock } from '../lib/ship/evidence/publish-media.mts';
import { CLI, testSpawnSync } from './_helpers.mts';

// The command module is spawned, not imported, so this keeps it in vitest's import graph.
void (() => import('../commands/pr/pr-body.mts'));

const HEAD = 'a'.repeat(40);
const BLOCK = renderEvidenceBlock(notRun('docs-only', 'only Markdown', HEAD, 'b'.repeat(40)), null);
const TRAILER = '<!-- This is an auto-generated comment: release notes by coderabbit.ai -->';

/** A recording gh: view serves GH_STATE; edit stores stdin, or once stores GH_RACE as another writer. */
const GH_STUB = `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } = require('node:fs');
const env = process.env;
const args = process.argv.slice(2);
appendFileSync(env.GH_LOG, args.join(' ') + '\\n');
if (args[1] === 'view') {
  if (env.GH_VIEW_STATUS) process.exit(Number(env.GH_VIEW_STATUS));
  process.stdout.write(JSON.stringify({ title: 't', body: readFileSync(env.GH_STATE, 'utf8'),
    headRefOid: env.GH_HEAD_OID, baseRefOid: 'b' }));
} else if (args[1] === 'edit') {
  const body = readFileSync(0, 'utf8');
  if (env.GH_RACE && existsSync(env.GH_RACE)) {
    writeFileSync(env.GH_STATE, readFileSync(env.GH_RACE, 'utf8'));
    unlinkSync(env.GH_RACE);
  } else if (!env.GH_EDIT_DROP) writeFileSync(env.GH_STATE, body);
  process.exit(Number(env.GH_EDIT_STATUS || 0));
}
`;

let bin: string;
let state: string;
let log: string;
let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  saved = { ...process.env };
  bin = mkdtempSync(join(tmpdir(), 'pr-body-'));
  writeFileSync(join(bin, 'gh'), GH_STUB);
  chmodSync(join(bin, 'gh'), 0o755);
  state = join(bin, 'gh.body');
  log = join(bin, 'gh.log');
  Object.assign(process.env, {
    PATH: `${bin}:${process.env.PATH}`,
    GH_LOG: log,
    GH_STATE: state,
    GH_HEAD_OID: HEAD,
  });
});

afterEach(() => {
  process.env = saved;
  rmSync(bin, { recursive: true, force: true });
});

const body = () => readFileSync(state, 'utf8');
const setBody = (text: string) => writeFileSync(state, text);
const edits = () =>
  existsSync(log)
    ? readFileSync(log, 'utf8')
        .split('\n')
        .filter((l) => l.startsWith('pr edit'))
    : [];

describe('PR body rewrite loop', () => {
  it('reports head-moved without writing, even when the block is already current', () => {
    setBody(`text\n\n${BLOCK}\n`);
    expect(publishBody('acme/app', '7', 'c'.repeat(40), (b) => upsertEvidenceBlock(b, BLOCK))).toBe(
      'head-moved',
    );
    expect(edits()).toEqual([]);
  });

  it('writes nothing when the body already matches', () => {
    setBody(`text\n\n${BLOCK}\n`);
    expect(publishBody('acme/app', '7', HEAD, (b) => upsertEvidenceBlock(b, BLOCK))).toBe(
      'unchanged',
    );
    expect(replaceCallerText('acme/app', '7', 'text\n')).toBe('unchanged');
    expect(edits()).toEqual([]);
  });

  it('gives up as contended after three writes that never stick', () => {
    setBody('old\n');
    process.env.GH_EDIT_DROP = '1';
    expect(replaceCallerText('acme/app', '7', 'new\n')).toBe('contended');
    expect(publishBody('acme/app', '7', HEAD, (b) => upsertEvidenceBlock(b, BLOCK))).toBe(
      'contended',
    );
    expect(edits()).toHaveLength(6);
  });

  it('carries the newer block when an evidence publish lands between its write and verify', () => {
    const newer = renderEvidenceBlock(notRun('no-test-change', 'no test', HEAD, null), null);
    setBody(`old\n\n${BLOCK}\n`);
    process.env.GH_RACE = join(bin, 'race.body');
    writeFileSync(process.env.GH_RACE, `old\n\n${newer}\n`);

    expect(replaceCallerText('acme/app', '7', 'new\n')).toBe('written');
    expect(body()).toBe(`new\n\n${newer}\n`);
  });

  it('carries a block from a browser-edited CRLF body once, and is then idempotent', () => {
    const crlf = BLOCK.replaceAll('\n', '\r\n');
    setBody(`old\r\n\r\n${crlf}\r\n`);

    expect(replaceCallerText('acme/app', '7', 'new\n')).toBe('written');
    expect(body()).toBe(`new\n\n${crlf}\n`);
    expect(replaceCallerText('acme/app', '7', 'new\n')).toBe('unchanged');
  });

  it('keeps the block byte for byte under new caller text and drops the bot trailer', () => {
    setBody(`old text\n\n${BLOCK}\n\n${TRAILER}\nsummary\n`);
    expect(replaceCallerText('acme/app', '7', 'new text\n')).toBe('written');
    expect(body()).toBe(`new text\n\n${BLOCK}\n`);
  });
});

describe('devkit pr-body', () => {
  function repo() {
    const dir = mkdtempSync(join(bin, 'repo-'));
    const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    git('init', '-q');
    git('remote', 'add', 'origin', 'git@github.com:acme/app.git');
    git('-c', 'user.name=a', '-c', 'user.email=a@b.c', 'commit', '-q', '--allow-empty', '-m', 'x');
    return {
      dir,
      head: () => git('rev-parse', 'HEAD'),
      status: () => git('status', '--porcelain'),
    };
  }

  const run = (dir: string, args: string[], input = '') =>
    testSpawnSync(process.execPath, [CLI, 'pr-body', ...args], {
      cwd: dir,
      input,
      encoding: 'utf8',
      env: process.env,
    });

  it('replaces the caller text, keeps the PR block, drops a pasted one, and makes no commit', () => {
    const { dir, head, status } = repo();
    const before = head();
    setBody(`old\n\n${BLOCK}\n`);
    const pasted = BLOCK.replace('docs-only', 'forged');

    const r = run(dir, ['7', '--body-file', '-'], `## Edge cases\n\n${pasted}\n`);

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('PR #7 description written');
    expect(body()).toBe(`## Edge cases\n\n${BLOCK}\n`);
    expect(readFileSync(log, 'utf8')).toContain('--repo acme/app');
    expect([head(), status()]).toEqual([before, '']);
  });

  it('writes the caller text as-is from a file when the PR has no block', () => {
    const { dir } = repo();
    setBody('old\n');
    writeFileSync(join(bin, 'new.md'), 'fresh\n');

    expect(run(dir, ['7', '--body-file', join(bin, 'new.md')]).status).toBe(0);
    expect(body()).toBe('fresh\n');
    // A second identical run writes nothing, and says so rather than claiming a block was carried.
    const again = run(dir, ['7', '--body-file', join(bin, 'new.md')]);
    expect([again.status, again.stdout.trim()]).toEqual([
      0,
      'PR #7 description already matched; nothing was written',
    ]);
    expect(edits()).toHaveLength(1);
  });

  it('refuses without writing when the PR cannot be read', () => {
    const { dir } = repo();
    setBody(`old\n\n${BLOCK}\n`);
    process.env.GH_VIEW_STATUS = '1';

    const r = run(dir, ['7', '--body-file', '-'], 'new\n');

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('the PR description was not changed');
    expect(body()).toBe(`old\n\n${BLOCK}\n`);
    expect(edits()).toEqual([]);
  });

  it('says the description may have changed once a write went out', () => {
    const { dir } = repo();
    setBody('old\n');
    process.env.GH_EDIT_DROP = '1';

    const r = run(dir, ['7', '--body-file', '-'], 'new\n');

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('may have changed');
  });

  it('names a failed edit as one that may have changed the description', () => {
    const { dir } = repo();
    setBody('old\n');
    process.env.GH_EDIT_STATUS = '1';

    const r = run(dir, ['7', '--body-file', '-'], 'new\n');

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('may have changed');
  });

  it('refuses a repository whose origin is not on GitHub', () => {
    const { dir } = repo();
    execFileSync('git', ['-C', dir, 'remote', 'set-url', 'origin', 'https://gitlab.com/a/b.git']);

    const r = run(dir, ['7', '--body-file', '-'], 'new\n');

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('origin is not a GitHub remote');
    expect(edits()).toEqual([]);
  });

  it('refuses without writing while a devkit ship holds the PR evidence lock', () => {
    const { dir } = repo();
    setBody(`old\n\n${BLOCK}\n`);

    const r = withPrEvidenceLock(
      dir,
      { repo: 'acme/app', pr: '7' },
      () => run(dir, ['7', '--body-file', '-'], 'new\n'),
      0,
    );

    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      "a devkit ship is publishing #7's evidence; the PR description was not changed",
    );
    expect(body()).toBe(`old\n\n${BLOCK}\n`);
    expect(edits()).toEqual([]);
  });

  it('refuses a branch name, so the lock always keys on the PR number ship uses', () => {
    const r = run(repo().dir, ['feat/x', '--body-file', '-'], 'new\n');

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('is neither a PR number nor a github.com PR URL');
    expect(edits()).toEqual([]);
  });

  it('prints usage without --body-file', () => {
    const r = run(repo().dir, ['7']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('usage: devkit pr-body');
  });
});
