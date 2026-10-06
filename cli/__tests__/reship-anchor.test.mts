import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { decide, hereEntry } from '../lib/ship/reship/anchor.mts';
import { recordShip } from '../lib/ship/reconcile-manifest-write.mts';
import { testExecFileSync as execFileSync, testSpawnSync as spawnSync } from './_helpers.mts';
import { manifestOf } from './_ship-branch-fixture.mts';

// `devkit ship --pr` must never commit a revert of what reached the PR branch after the caller's
// copy was taken: it merges that change in, or refuses naming the commit.

const scriptPath = fileURLToPath(new URL('../lib/ship/reship.sh', import.meta.url));
const GENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const WT_RE = /worktree kept at (.+?)\. Remove/;
const LINES = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
const text = (edits: Record<number, string> = {}) =>
  `${LINES.map((l, i) => edits[i] ?? l).join('\n')}\n`;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** A checkout on `work` whose a.ts (and bin.dat) were shipped to origin/feat/pr, plus a peer clone. */
function prRepo({ record = true } = {}) {
  const bare = tmp('reship-anchor-bare-');
  const dir = tmp('reship-anchor-wt-');
  const peer = tmp('reship-anchor-peer-');
  const bin = tmp('reship-anchor-bin-');
  const env = { ...process.env, ...GENV, PATH: `${bin}:${process.env.PATH}` };
  const git = (cwd: string, a: string[]) =>
    execFileSync('git', ['-C', cwd, ...a], { env, encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'gh'), 0o755);
  git(bare, ['init', '-q', '--bare']);
  for (const a of [
    ['init', '-q', '-b', 'work'],
    ['config', 'user.email', 'a@b.c'],
    ['config', 'user.name', 'a'],
    ['config', 'commit.gpgsign', 'false'],
    ['remote', 'add', 'origin', 'git@github.com:acme/app.git'],
    ['config', `url.${bare}.insteadOf`, 'git@github.com:acme/app.git'],
  ])
    git(dir, a);
  mkdirSync(join(dir, '.husky/_'), { recursive: true });
  writeFileSync(join(dir, '.husky/.keep'), '');
  writeFileSync(join(dir, '.gitignore'), '.devkit/\n');
  writeFileSync(join(dir, 'a.ts'), text());
  writeFileSync(join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'first ship']);
  git(dir, ['push', '-q', 'origin', 'HEAD:feat/pr']);
  git(dir, ['config', 'core.hooksPath', '.husky/_']);
  writeFileSync(join(dir, '.husky/_/pre-commit'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(dir, '.husky/_/pre-commit'), 0o755);
  if (record) {
    const sha = git(dir, ['rev-parse', 'HEAD']);
    const opts = { root: dir, branch: 'feat/pr', repo: 'acme/app', baseRef: 'work', baseSha: sha };
    expect(recordShip({ ...opts, pr: '7' }, ['a.ts', 'bin.dat'])).toBe(0);
  }
  git(peer, ['clone', '-q', '-b', 'feat/pr', bare, '.']);
  git(peer, ['config', 'user.email', 'p@b.c']);
  git(peer, ['config', 'user.name', 'p']);
  /** Push a commit that changes <file> on origin/feat/pr from elsewhere. */
  const foreign = (file: string, content: string | Buffer | null, subject: string) => {
    if (content === null) git(peer, ['rm', '-q', file]);
    else writeFileSync(join(peer, file), content);
    git(peer, ['commit', '-q', '-am', subject]);
    git(peer, ['push', '-q', 'origin', 'feat/pr']);
  };
  const reship = (extra: Record<string, string> = {}, paths = ['a.ts']) =>
    spawnSync('/bin/bash', [scriptPath, 'feat/pr', 'follow-up', '--pr', '--', ...paths], {
      cwd: dir,
      input: 'body\n',
      encoding: 'utf8',
      env: { ...env, ...extra },
    });
  const remote = (file: string) => git(bare, ['show', `feat/pr:${file}`]);
  const mode = (file: string) => git(bare, ['ls-tree', 'feat/pr', file]).split(' ')[0];
  const chmodTip = (file: string) => {
    git(peer, ['update-index', '--chmod=+x', file]);
    git(peer, ['commit', '-q', '-m', `chmod ${file}`]);
    git(peer, ['push', '-q', 'origin', 'feat/pr']);
  };
  /** Dry-run: the staged content of <file> in the kept worktree. */
  const staged = (file: string) => {
    const r = reship({ SHIP_DRY_RUN: '1' });
    expect(r.status, r.stderr).toBe(0);
    const wt = WT_RE.exec(r.stderr)?.[1] ?? '';
    const out = git(wt, ['show', `HEAD:${file}`]);
    git(dir, ['worktree', 'remove', '--force', wt]);
    return { out, stderr: r.stderr };
  };
  return { dir, foreign, reship, remote, staged, mode, chmodTip };
}

describe('reship-anchor — decide', () => {
  const e = (blob: string, mode = '100644') => ({ blob, mode });
  it.each([
    ['tip unmoved since the anchor', e('h'), e('a'), e('a'), 'copy'],
    ['caller already equals the tip', e('t'), e('t'), e('a'), 'copy'],
    ['caller did not change the path', e('a'), e('t'), e('a'), 'keep'],
    ['both changed a regular file', e('h'), e('t'), e('a'), 'merge'],
    ['caller deleted, tip changed', null, e('t'), e('a'), 'refuse'],
    ['both added differently', e('h'), e('t'), null, 'refuse'],
    ['both changed a symlink', e('h', '120000'), e('t', '120000'), e('a', '120000'), 'refuse'],
  ] as const)('%s → %s', (_, here, tip, anchor, want) => {
    expect(decide(here, tip, anchor)).toBe(want);
  });
});

describe('reship-anchor — hereEntry', () => {
  it('reads a symlink as its target, an executable with its mode, and a missing path as absent', () => {
    const dir = tmp('reship-anchor-here-');
    execFileSync('git', ['-C', dir, 'init', '-q'], { env: { ...process.env, ...GENV } });
    writeFileSync(join(dir, 'run.sh'), 'echo hi\n');
    chmodSync(join(dir, 'run.sh'), 0o755);
    symlinkSync('run.sh', join(dir, 'link'));
    expect(hereEntry(dir, 'run.sh')?.mode).toBe('100755');
    const link = hereEntry(dir, 'link');
    expect(link?.mode).toBe('120000');
    const target = execFileSync('git', ['-C', dir, 'cat-file', 'blob', link?.blob ?? ''], {
      encoding: 'utf8',
    });
    expect(target).toBe('run.sh');
    expect(hereEntry(dir, 'gone')).toBeNull();
  });
});

describe('reconcile manifest --anchors — a newer record is never regressed', () => {
  it('writes a path only while its record still matches the one the anchor read', () => {
    const r = prRepo();
    const record = () => manifestOf(r.dir).branches['feat/pr'].paths.find((p) => p.path === 'a.ts');
    const before = record();
    const sha = execFileSync('git', ['-C', r.dir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    const guards = join(r.dir, 'anchors');
    const write = (expect: string) => {
      writeFileSync(guards, `${expect}\0=\0a.ts\0`);
      return recordShip(
        { root: r.dir, branch: 'feat/pr', baseSha: sha, merge: true, anchors: guards },
        ['a.ts'],
      );
    };
    writeFileSync(join(r.dir, 'a.ts'), 'newer\n');
    expect(write('modify:0000000')).toBe(1); // another ship replaced the record meanwhile
    expect(record()).toEqual(before);
    expect(write(`${before.op}:${before.blobSha}`)).toBe(0);
    expect(record().blobSha).not.toBe(before.blobSha);
  });
});

describe('reship --pr — what reached the PR branch survives a re-push (sc-4607)', () => {
  it('merges a foreign hunk in another region and keeps it across a second re-push', () => {
    const r = prRepo();
    r.foreign('a.ts', text({ 9: 'merged from main' }), 'Merge main into feat/pr');
    writeFileSync(join(r.dir, 'a.ts'), text({ 0: 'caller edit' }));

    const first = r.reship();
    expect(first.status, first.stderr).toBe(0);
    expect(r.remote('a.ts')).toBe(text({ 0: 'caller edit', 9: 'merged from main' }).trim());
    expect(first.stderr).toContain('Merge main into feat/pr');
    const blob = execFileSync('git', ['-C', r.dir, 'hash-object', 'a.ts'], { encoding: 'utf8' });
    const rec = manifestOf(r.dir).branches['feat/pr'].paths.find((p) => p.path === 'a.ts');
    expect(rec.blobSha).toBe(blob.trim()); // the caller's bytes, so the next push anchors on them
    expect(rec.mode).toBe('100644');

    writeFileSync(join(r.dir, 'a.ts'), text({ 0: 'caller edit', 3: 'second edit' }));
    const second = r.reship();
    expect(second.status, second.stderr).toBe(0);
    expect(r.remote('a.ts')).toBe(
      text({ 0: 'caller edit', 3: 'second edit', 9: 'merged from main' }).trim(),
    );
  });

  it('refuses a same-region change, naming the commit, and pushes nothing', () => {
    const r = prRepo();
    r.foreign('a.ts', text({ 0: 'reviewer suggestion' }), 'Apply suggestion from review');
    const before = r.remote('a.ts');
    writeFileSync(join(r.dir, 'a.ts'), text({ 0: 'caller edit' }));

    const res = r.reship();
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('Apply suggestion from review');
    expect(res.stderr).toContain('GUARD_SHIP_REPLACE_OK=1');
    expect(r.remote('a.ts')).toBe(before);
  });

  it('anchors at the fork point when no ship was recorded for the path', () => {
    const r = prRepo({ record: false });
    r.foreign('a.ts', text({ 9: 'reviewer edit' }), 'reviewer edit');
    writeFileSync(join(r.dir, 'a.ts'), text({ 0: 'caller edit' }));
    expect(r.staged('a.ts').out).toBe(text({ 0: 'caller edit', 9: 'reviewer edit' }).trim());
  });

  it('does not trust a record without a mode: a chmod on the tip survives', () => {
    const r = prRepo();
    const file = join(r.dir, '.devkit/reconcile-manifest.json');
    const m = manifestOf(r.dir);
    for (const p of m.branches['feat/pr'].paths) delete p.mode;
    writeFileSync(file, JSON.stringify(m));
    r.foreign('a.ts', text({ 9: 'upstream' }), 'upstream edit');
    r.chmodTip('a.ts');
    writeFileSync(join(r.dir, 'a.ts'), text({ 0: 'caller edit' }));
    const res = r.reship();
    expect(res.status, res.stderr).toBe(0);
    expect(r.mode('a.ts')).toBe('100755');
    expect(r.remote('a.ts')).toBe(text({ 0: 'caller edit', 9: 'upstream' }).trim());
  });

  it('copies the caller file unchanged when the tip did not move, even on the same lines', () => {
    const r = prRepo();
    writeFileSync(join(r.dir, 'a.ts'), text({ 0: 'again' }));
    const { out, stderr } = r.staged('a.ts');
    expect(out).toBe(text({ 0: 'again' }).trim());
    expect(stderr).not.toContain('merged origin/');
  });

  it('re-anchors a path whose copy already equals the tip, so the next edit does not conflict', () => {
    const r = prRepo();
    r.foreign('a.ts', text({ 0: 'reviewer line' }), 'reviewer suggestion');
    writeFileSync(join(r.dir, 'a.ts'), text({ 0: 'reviewer line' }));
    expect(r.reship().stderr).toContain('no changes vs origin/feat/pr');
    writeFileSync(join(r.dir, 'a.ts'), text({ 0: 'reviewer line, refined' }));
    const next = r.reship();
    expect(next.status, next.stderr).toBe(0);
    expect(r.remote('a.ts')).toBe(text({ 0: 'reviewer line, refined' }).trim());
  });

  it('records a path both sides deleted, so re-adding it later is a plain copy', () => {
    const r = prRepo();
    r.foreign('a.ts', null, 'drop a.ts');
    rmSync(join(r.dir, 'a.ts'));
    expect(r.reship().stderr).toContain('no changes vs origin/feat/pr');
    const rec = manifestOf(r.dir).branches['feat/pr'].paths.find((p) => p.path === 'a.ts');
    expect(rec.op).toBe('delete');
    writeFileSync(join(r.dir, 'a.ts'), 'fresh\n');
    const readd = r.reship();
    expect(readd.status, readd.stderr).toBe(0);
    expect(r.remote('a.ts')).toBe('fresh');
  });

  it('keeps a deletion on the tip when the caller re-ships the file unchanged, twice', () => {
    const r = prRepo();
    r.foreign('a.ts', null, 'drop a.ts');
    for (const _ of [1, 2]) {
      expect(r.reship().stderr).toContain('no changes vs origin/feat/pr');
      expect(() => r.remote('a.ts')).toThrow();
    }
    const rec = manifestOf(r.dir).branches['feat/pr'].paths.find((p) => p.path === 'a.ts');
    expect(rec.op).toBe('modify');
  });

  it('refuses when the caller deleted a path the tip changed', () => {
    const r = prRepo();
    r.foreign('a.ts', text({ 9: 'kept upstream' }), 'upstream change');
    rmSync(join(r.dir, 'a.ts'));
    const res = r.reship();
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('upstream change');
  });

  it('refuses a binary both sides changed unless GUARD_SHIP_REPLACE_OK=1', () => {
    const r = prRepo();
    r.foreign('bin.dat', Buffer.from([0, 9, 9, 9]), 'regenerate asset');
    writeFileSync(join(r.dir, 'bin.dat'), Buffer.from([0, 7, 7, 7]));
    const res = r.reship({}, ['bin.dat']);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('regenerate asset');

    const ok = r.reship({ GUARD_SHIP_REPLACE_OK: '1' }, ['bin.dat']);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stderr).toContain('GUARD_SHIP_REPLACE_OK');
    const shipped = execFileSync('git', [
      '-C',
      r.dir,
      'cat-file',
      'blob',
      'origin/feat/pr:bin.dat',
    ]);
    expect(shipped).toEqual(readFileSync(join(r.dir, 'bin.dat')));
  });
});
