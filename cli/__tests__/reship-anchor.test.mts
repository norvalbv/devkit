import {
  chmodSync,
  existsSync,
  lstatSync,
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
import {
  decide,
  hereEntry,
  stageAppend,
  stripBase,
  treeEntry,
} from '../lib/ship/reship/anchor.mts';
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
  git(dir, ['push', '-q', 'origin', 'HEAD:feat/pr', 'HEAD:main']);
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
  /** Commit <edit> on origin/main from the peer; the caller's origin/HEAD names main from then on. */
  const onMain = (subject: string, edit: (peerDir: string) => void) => {
    git(peer, ['fetch', '-q', 'origin', 'main']);
    git(peer, ['checkout', '-q', '-B', 'main', 'FETCH_HEAD']);
    edit(peer);
    git(peer, ['commit', '-q', '-am', subject]);
    git(peer, ['push', '-q', 'origin', 'main']);
    git(peer, ['checkout', '-q', 'feat/pr']);
    git(dir, ['fetch', '-q', 'origin', 'main:refs/remotes/origin/main']);
    git(dir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  };
  const caller = (a: string[]) => git(dir, a);
  const peerGit = (a: string[]) => git(peer, a);
  /** gh answers `pr view` with an open PR #7 onto <base>, as pr_identity's @tsv. */
  const ghBase = (base: string) =>
    writeFileSync(
      join(bin, 'gh'),
      `#!/bin/sh\n[ "$1 $2" = "pr view" ] && printf '7\\tOPEN\\tfeat/pr\\tx\\t\\t${base}\\tu\\n'\nexit 0\n`,
    );
  return { dir, foreign, reship, remote, staged, mode, chmodTip, onMain, caller, peerGit, ghBase };
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

/** In-process staging: a checkout at the first ship, a `pr` tip, and a worktree cut at that tip. */
function stageRepo(tipEdit: (dir: string) => void = () => {}) {
  const dir = tmp('reship-anchor-stage-');
  const wt = join(tmp('reship-anchor-stagewt-'), 'wt');
  const env = { ...process.env, ...GENV };
  const git = (cwd: string, a: string[]) =>
    execFileSync('git', ['-C', cwd, ...a], { env, encoding: 'utf8' }).trim();
  git(dir, ['init', '-q', '-b', 'work']);
  git(dir, ['config', 'user.email', 'a@b.c']);
  git(dir, ['config', 'user.name', 'a']);
  writeFileSync(join(dir, '.gitignore'), '.devkit/\nanchors\n');
  writeFileSync(join(dir, 'a.ts'), text());
  writeFileSync(join(dir, 'old.ts'), 'old\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'first ship']);
  const head = git(dir, ['rev-parse', 'HEAD']);
  const ship = { root: dir, branch: 'pr', repo: 'acme/app', baseRef: 'work', baseSha: head };
  expect(recordShip(ship, ['a.ts', 'old.ts'])).toBe(0);
  git(dir, ['checkout', '-q', '-b', 'pr']);
  tipEdit(dir);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'foreign change']);
  const tip = git(dir, ['rev-parse', 'HEAD']);
  git(dir, ['checkout', '-q', 'work']);
  git(dir, ['worktree', 'add', '-q', '--detach', wt, tip]);
  const run = (paths: string[]) =>
    stageAppend({ root: dir, wt, branch: 'pr', tip, head, out: join(dir, 'anchors') }, paths);
  /** "<mode> <blob>" of the staged entry, or '' when the path is staged as absent. */
  const staged = (path: string) => git(wt, ['ls-files', '-s', '--', path]).split(' 0\t')[0];
  const diff = () => git(wt, ['diff', '--cached', '--name-status']);
  return { dir, wt, git, run, staged, diff };
}

describe('reship-anchor — stageAppend stages what the copy loop staged', () => {
  it('stages a nested new file, a symlink, an edit and a deletion over an unmoved tip', () => {
    const r = stageRepo();
    mkdirSync(join(r.dir, 'deep/er'), { recursive: true });
    writeFileSync(join(r.dir, 'deep/er/new.ts'), 'new\n');
    symlinkSync('a.ts', join(r.dir, 'link'));
    writeFileSync(join(r.dir, 'a.ts'), text({ 0: 'edited' }));
    rmSync(join(r.dir, 'old.ts'));

    expect(r.run(['deep/er/new.ts', 'link', 'a.ts', 'old.ts'])).toBe(0);
    expect(r.diff().split('\n').sort()).toEqual([
      'A\tdeep/er/new.ts',
      'A\tlink',
      'D\told.ts',
      'M\ta.ts',
    ]);
    expect(r.staged('link').startsWith('120000 ')).toBe(true);
    expect(lstatSync(join(r.wt, 'link')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(r.wt, 'deep/er/new.ts'), 'utf8')).toBe('new\n');
    expect(existsSync(join(r.wt, 'old.ts'))).toBe(false);
  });

  it('stages nothing when one path merges and another must be refused', () => {
    const r = stageRepo((dir) => {
      writeFileSync(join(dir, 'a.ts'), text({ 9: 'foreign' }));
      writeFileSync(join(dir, 'old.ts'), 'foreign\n');
    });
    writeFileSync(join(r.dir, 'a.ts'), text({ 0: 'mine' }));
    writeFileSync(join(r.dir, 'old.ts'), 'mine\n');
    expect(r.run(['a.ts', 'old.ts'])).toBe(1);
    expect(r.diff()).toBe('');
  });

  it('falls back to the fork point when the recorded blob was garbage-collected', () => {
    const r = stageRepo((dir) => writeFileSync(join(dir, 'a.ts'), text({ 9: 'foreign' })));
    const file = join(r.dir, '.devkit/reconcile-manifest.json');
    const m = manifestOf(r.dir);
    const pruned = execFileSync('git', ['-C', r.dir, 'hash-object', '--stdin'], {
      input: 'bytes no commit ever held\n',
      encoding: 'utf8',
    }).trim();
    m.branches.pr.paths.find((p) => p.path === 'a.ts').blobSha = pruned;
    writeFileSync(file, JSON.stringify(m));
    writeFileSync(join(r.dir, 'a.ts'), text({ 0: 'mine' }));
    expect(r.run(['a.ts'])).toBe(0);
    expect(readFileSync(join(r.wt, 'a.ts'), 'utf8')).toBe(text({ 0: 'mine', 9: 'foreign' }));
  });

  it('keeps a chmod from either side through a merge', () => {
    const tipChmod = stageRepo((dir) => chmodSync(join(dir, 'a.ts'), 0o755));
    writeFileSync(join(tipChmod.dir, 'a.ts'), text({ 0: 'mine' }));
    expect(tipChmod.run(['a.ts'])).toBe(0);
    expect(tipChmod.staged('a.ts').startsWith('100755 ')).toBe(true);
    expect(readFileSync(join(tipChmod.wt, 'a.ts'), 'utf8')).toBe(text({ 0: 'mine' }));

    const callerChmod = stageRepo((dir) =>
      writeFileSync(join(dir, 'a.ts'), text({ 9: 'foreign' })),
    );
    chmodSync(join(callerChmod.dir, 'a.ts'), 0o755);
    expect(callerChmod.run(['a.ts'])).toBe(0);
    expect(callerChmod.staged('a.ts').startsWith('100755 ')).toBe(true);
    expect(readFileSync(join(callerChmod.wt, 'a.ts'), 'utf8')).toBe(text({ 9: 'foreign' }));
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
    expect(write(`modify:${before.mode}:0000000`)).toBe(1); // another ship replaced the blob meanwhile
    expect(write(`modify:100755:${before.blobSha}`)).toBe(1); // ...or only its mode
    expect(record()).toEqual(before);
    expect(write(`${before.op}:${before.mode}:${before.blobSha}`)).toBe(0);
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

  it('a ./-spelled re-push anchors on the recorded ship and records the tree path', () => {
    const r = prRepo();
    r.foreign('a.ts', text({ 9: 'merged from main' }), 'Merge main into feat/pr');
    writeFileSync(join(r.dir, 'a.ts'), text({ 0: 'caller edit' }));
    const first = r.reship({}, ['./a.ts']);
    expect(first.status, first.stderr).toBe(0);
    const paths = manifestOf(r.dir).branches['feat/pr'].paths.map((p) => p.path);
    expect(paths.sort()).toEqual(['a.ts', 'bin.dat']);

    writeFileSync(join(r.dir, 'a.ts'), text({ 0: 'caller edit', 3: 'second edit' }));
    const second = r.reship({}, ['./a.ts']);
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

describe('reship --pr — base content only the caller holds stays out of the PR (sc-7895)', () => {
  const intro = (peerDir: string) => writeFileSync(join(peerDir, 'a.ts'), text({ 0: 'from main' }));
  /** A PR checkout that merged origin/main locally after main changed line 1 of a.ts. */
  function merged() {
    const r = prRepo();
    r.onMain('main: new intro', intro);
    r.caller(['merge', '-q', '--no-edit', 'origin/main']);
    return r;
  }

  it('ships only the lane edit after a local base merge, and again once the tip is ahead', () => {
    const r = merged();
    writeFileSync(join(r.dir, 'a.ts'), text({ 0: 'from main', 9: 'lane edit' }));
    const first = r.reship();
    expect(first.status, first.stderr).toBe(0);
    expect(r.remote('a.ts')).toBe(text({ 9: 'lane edit' }).trim());
    expect(first.stderr).toContain('left origin/main changes');
    expect(first.stderr).toContain('main: new intro');
    expect(first.stderr).not.toContain('(see git log'); // the base commits are named, not the fallback
    const rec = manifestOf(r.dir).branches['feat/pr'].paths.find((p) => p.path === 'a.ts');
    expect(rec.blobSha).toBe(r.caller(['rev-parse', 'origin/feat/pr:a.ts']));

    writeFileSync(join(r.dir, 'a.ts'), text({ 0: 'from main', 9: 'lane edit', 10: 'second' }));
    const second = r.reship();
    expect(second.status, second.stderr).toBe(0);
    expect(r.remote('a.ts')).toBe(text({ 9: 'lane edit', 10: 'second' }).trim());
  });

  it("merges the PR branch's own change with the stripped copy", () => {
    const r = merged();
    r.foreign('a.ts', text({ 11: 'review suggestion' }), 'Apply review suggestion');
    writeFileSync(join(r.dir, 'a.ts'), text({ 0: 'from main', 9: 'lane edit' }));
    const res = r.reship();
    expect(res.status, res.stderr).toBe(0);
    expect(r.remote('a.ts')).toBe(text({ 9: 'lane edit', 11: 'review suggestion' }).trim());
    expect(res.stderr).toContain('left origin/main changes');
  });

  it("strips against the PR's own base from gh, and never against origin/HEAD for a missing one", () => {
    const r = merged();
    r.caller(['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD']);
    writeFileSync(join(r.dir, 'a.ts'), text({ 0: 'from main', 9: 'lane edit' }));
    r.ghBase('main');
    const known = r.reship();
    expect(known.status, known.stderr).toBe(0);
    expect(r.remote('a.ts')).toBe(text({ 9: 'lane edit' }).trim());

    const stacked = prRepo();
    stacked.onMain('main: new intro', intro);
    stacked.caller(['merge', '-q', '--no-edit', 'origin/main']);
    writeFileSync(join(stacked.dir, 'a.ts'), text({ 0: 'from main', 9: 'lane edit' }));
    stacked.ghBase('feat/parent'); // origin/feat/parent was never fetched
    const res = stacked.reship();
    expect(res.status, res.stderr).toBe(0);
    expect(res.stderr).not.toContain('left origin/main');
    expect(res.stderr).toContain('origin/feat/parent is not fetched');
    expect(stacked.remote('a.ts')).toBe(text({ 0: 'from main', 9: 'lane edit' }).trim());
  });

  it("keeps the caller's own unpushed commit while leaving the base out", () => {
    const r = prRepo();
    writeFileSync(join(r.dir, 'a.ts'), text({ 5: 'own commit' }));
    r.caller(['commit', '-q', '-am', 'own work']);
    r.onMain('main: new intro', intro);
    r.caller(['merge', '-q', '--no-edit', 'origin/main']);
    writeFileSync(join(r.dir, 'a.ts'), text({ 0: 'from main', 5: 'own commit', 9: 'lane edit' }));
    const res = r.reship();
    expect(res.status, res.stderr).toBe(0);
    expect(r.remote('a.ts')).toBe(text({ 5: 'own commit', 9: 'lane edit' }).trim());
  });

  it('leaves the base out from a shared checkout sitting on a main that moved', () => {
    const r = prRepo();
    r.onMain('main: new intro', intro);
    r.caller(['checkout', '-q', '-B', 'main', 'origin/main']);
    writeFileSync(join(r.dir, 'a.ts'), text({ 0: 'from main', 9: 'shared edit' }));
    expect(r.staged('a.ts').out).toBe(text({ 9: 'shared edit' }).trim());
  });

  it('refuses an edit that overlaps the base change unless GUARD_SHIP_REPLACE_OK=1', () => {
    const r = merged();
    writeFileSync(join(r.dir, 'a.ts'), text({ 0: 'mine over main' }));
    const res = r.reship();
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('cannot be left out');
    expect(res.stderr).toContain('main: new intro');
    expect(res.stderr).toContain('gh pr update-branch feat/pr');
    expect(r.remote('a.ts')).toBe(text().trim());

    const ok = r.reship({ GUARD_SHIP_REPLACE_OK: '1' });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stderr).toContain('GUARD_SHIP_REPLACE_OK');
    expect(r.remote('a.ts')).toBe(text({ 0: 'mine over main' }).trim());
  });

  it('copies as before once the PR branch already holds the base change', () => {
    const r = merged();
    r.peerGit(['fetch', '-q', 'origin', 'main']);
    r.peerGit(['merge', '-q', '--no-edit', 'FETCH_HEAD']);
    r.peerGit(['push', '-q', 'origin', 'feat/pr']);
    writeFileSync(join(r.dir, 'a.ts'), text({ 0: 'from main', 9: 'lane edit' }));
    const res = r.reship();
    expect(res.status, res.stderr).toBe(0);
    expect(r.remote('a.ts')).toBe(text({ 0: 'from main', 9: 'lane edit' }).trim());
    expect(res.stderr).not.toContain('left origin/main');
  });

  it('ships a deletion of a file the base changed, and leaves a base chmod out', () => {
    const del = merged();
    rmSync(join(del.dir, 'a.ts'));
    const res = del.reship();
    expect(res.status, res.stderr).toBe(0);
    expect(del.caller(['ls-tree', 'origin/feat/pr', 'a.ts'])).toBe('');

    const mod = prRepo();
    mod.onMain('main: make a.ts executable', (p) => chmodSync(join(p, 'a.ts'), 0o755));
    mod.caller(['merge', '-q', '--no-edit', 'origin/main']);
    writeFileSync(join(mod.dir, 'a.ts'), text({ 9: 'lane edit' }));
    const ok = mod.reship();
    expect(ok.status, ok.stderr).toBe(0);
    expect(mod.mode('a.ts')).toBe('100644');
    expect(mod.remote('a.ts')).toBe(text({ 9: 'lane edit' }).trim());
  });
});

describe('stripBase — a base change the tip already carries is never removed', () => {
  it('leaves a cherry-picked base hunk in, and strips it when the tip lacks it', () => {
    const dir = tmp('reship-anchor-strip-');
    const env = { ...process.env, ...GENV };
    const git = (a: string[]) =>
      execFileSync('git', ['-C', dir, ...a], { env, encoding: 'utf8' }).trim();
    const commit = (content: string) => {
      writeFileSync(join(dir, 'a.ts'), content);
      git(['add', 'a.ts']);
      git(['commit', '-q', '-m', 'c']);
      return git(['rev-parse', 'HEAD']);
    };
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'a@b.c']);
    git(['config', 'user.name', 'a']);
    const fork = commit(text());
    const head = commit(text({ 0: 'from main' }));
    git(['checkout', '-q', '-b', 'pr', fork]);
    const bare = commit(text({ 11: 'pr' }));
    const picked = commit(text({ 0: 'from main', 11: 'pr' }));
    writeFileSync(join(dir, 'a.ts'), text({ 0: 'from main', 9: 'mine' }));
    const here = hereEntry(dir, 'a.ts');
    const strip = (tip: string) =>
      stripBase(dir, here, treeEntry(dir, tip, 'a.ts'), { tip, head, baseRef: 'main' }, 'a.ts');

    expect(strip(picked)).toEqual({ here, commits: [], refuse: false });
    const left = strip(bare);
    expect(left.refuse).toBe(false);
    expect(left.commits).toHaveLength(1);
    expect(git(['cat-file', 'blob', left.here?.blob ?? ''])).toBe(text({ 9: 'mine' }).trim());

    // A copy that already lacks the base change names nothing as left out.
    writeFileSync(join(dir, 'a.ts'), text({ 9: 'mine' }));
    const reverted = hereEntry(dir, 'a.ts');
    const tipEntry = treeEntry(dir, bare, 'a.ts');
    const opts = { tip: bare, head, baseRef: 'main' };
    expect(stripBase(dir, reverted, tipEntry, opts, 'a.ts')).toEqual({
      here: reverted,
      commits: [],
      refuse: false,
    });
    // A HEAD older than the PR's fork holds no base change the PR lacks: nothing is touched.
    git(['checkout', '-q', '-f', '-b', 'late', head]);
    const late = commit(text({ 0: 'from main', 11: 'late pr' }));
    const old = { tip: late, head: fork, baseRef: 'main' };
    expect(stripBase(dir, reverted, treeEntry(dir, late, 'a.ts'), old, 'a.ts')).toEqual({
      here: reverted,
      commits: [],
      refuse: false,
    });
  });
});
