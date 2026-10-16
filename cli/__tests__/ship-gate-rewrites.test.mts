// ship_sync_gate_rewrites: the compare-and-swap write-back of gate-rewritten briefed files, the
// cases it must refuse, and its wiring into ship-branch.sh and reship.sh.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { rootRegistry, testSpawnSync as spawnSync } from './_helpers.mts';
import { rewriteRepo } from './_reship-rewrite-fixture.mts';
import {
  bodyUpdateRepo,
  dropWorktree,
  ghStub,
  reshipScript,
  scriptPath,
  seedShipRepoLocalRemote,
} from './_ship-branch-fixture.mts';

const HELPER = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'lib',
  'ship',
  'assert-staged-set.sh',
);
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const ENV = { ...process.env, ...GIT_ENV };
const FORMAT_HOOK = "printf 'formatted\\n' > FILE\ngit add -- FILE\nexit 0";

const { mkTmp, cleanup } = rootRegistry();
afterEach(cleanup);

const git = (cwd: string, args: string[]) =>
  execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim();

/** A caller checkout plus a linked ship worktree cut at its HEAD, as ship-branch.sh builds them. */
function shipRepo() {
  const dir = mkTmp('gate-rewrites-');
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 't@t.t']);
  git(dir, ['config', 'user.name', 't']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'a.txt'), 'base\n');
  writeFileSync(join(dir, 'baseline.json'), '{"max":9}\n');
  writeFileSync(join(dir, 'run.sh'), 'base\n');
  chmodSync(join(dir, 'run.sh'), 0o755);
  symlinkSync('a.txt', join(dir, 'link'));
  writeFileSync(join(dir, '.gitattributes'), '*.crlf text eol=crlf\n');
  writeFileSync(join(dir, 'w x.txt'), 'neighbour\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'base']);
  const wt = mkTmp('gate-rewrites-wt-');
  git(dir, ['worktree', 'add', '-q', '--detach', wt]);
  const state = join(mkTmp('gate-rewrites-state-'), 'state');

  /** Brief `files`: the caller's copy and the ship worktree's staged copy hold the same bytes. */
  const stage = (files: Record<string, string>) => {
    for (const [path, body] of Object.entries(files)) {
      writeFileSync(join(dir, path), body);
      writeFileSync(join(wt, path), body);
      git(wt, ['add', '--', path]);
    }
    shell(`ship_record_staged_state "${wt}" "${state}"`);
  };
  /** What the gate chain does: rewrite and re-stage, then commit. */
  const gate = (files: Record<string, string>) => {
    for (const [path, body] of Object.entries(files)) {
      writeFileSync(join(wt, path), body);
      git(wt, ['add', '--', path]);
    }
    git(wt, ['commit', '-qm', 'ship', '--allow-empty']);
    return git(wt, ['rev-parse', 'HEAD']);
  };
  const sync = (commit: string, mode = '') =>
    shell(`ship_sync_gate_rewrites "${dir}" "${state}" "${commit}" ${mode}`);
  return { dir, wt, stage, gate, sync };
}

/** Run under the strict mode both ship scripts use, so an unbound empty array fails here too. */
function shell(body: string) {
  const r = spawnSync('bash', ['-c', `set -euo pipefail; . "${HELPER}"; ${body}`], {
    encoding: 'utf8',
    env: ENV,
  });
  expect(r.status, r.stderr).toBe(0);
  return r;
}

const read = (dir: string, path: string) => readFileSync(join(dir, path), 'utf8');

describe('ship_sync_gate_rewrites', () => {
  it('writes a rewritten briefed file back and leaves the caller index alone', () => {
    const { dir, stage, gate, sync } = shipRepo();
    stage({ 'a.txt': 'needs fmt\n' });
    const indexBefore = git(dir, ['rev-parse', ':a.txt']);

    const r = sync(gate({ 'a.txt': 'formatted\n' }));

    expect(read(dir, 'a.txt')).toBe('formatted\n');
    expect(git(dir, ['rev-parse', ':a.txt'])).toBe(indexBefore);
    expect(r.stderr).toMatch(/rewrote 1 briefed file\(s\); synced your working copy/);
    expect(r.stderr).toContain('     a.txt');
  });

  it('leaves a file the caller changed after staging and names it', () => {
    const { dir, stage, gate, sync } = shipRepo();
    stage({ 'a.txt': 'needs fmt\n' });
    writeFileSync(join(dir, 'a.txt'), 'caller kept editing\n');

    const r = sync(gate({ 'a.txt': 'formatted\n' }));

    expect(read(dir, 'a.txt')).toBe('caller kept editing\n');
    expect(r.stderr).toMatch(/left as-is\. Compare with: git diff \w+ -- <path>/);
    expect(r.stderr).toContain('     a.txt');
    expect(r.stderr).not.toContain('synced');
  });

  // Both hash checks are one batched hash-object call; each hash must stay paired with its own path.
  it('judges each file of a batch on its own hash', () => {
    const { dir, stage, gate, sync } = shipRepo();
    stage({ 'a.txt': 'needs fmt\n', 'run.sh': 'needs fmt\n' });
    writeFileSync(join(dir, 'a.txt'), 'caller kept editing\n');

    const r = sync(gate({ 'a.txt': 'formatted\n', 'run.sh': 'formatted\n' }));

    expect(read(dir, 'a.txt')).toBe('caller kept editing\n');
    expect(read(dir, 'run.sh')).toBe('formatted\n');
    expect(r.stderr).toMatch(/synced your working copy to \w+:\n {5}run\.sh\n/);
  });

  it('prints nothing when the gates rewrote nothing', () => {
    const { stage, gate, sync } = shipRepo();
    stage({ 'a.txt': 'already formatted\n' });

    expect(sync(gate({})).stderr).toBe('');
  });

  it('never writes a path the gates changed outside the brief', () => {
    const { dir, stage, gate, sync } = shipRepo();
    stage({ 'a.txt': 'needs fmt\n' });

    sync(gate({ 'a.txt': 'formatted\n', 'baseline.json': '{"max":8}\n' }));

    expect(read(dir, 'baseline.json')).toBe('{"max":9}\n');
  });

  it('skips a briefed symlink', () => {
    const { dir, wt, stage, gate, sync } = shipRepo();
    for (const root of [dir, wt]) {
      rmSync(join(root, 'link'));
      symlinkSync('run.sh', join(root, 'link'));
    }
    git(wt, ['add', 'link']);
    stage({});
    rmSync(join(wt, 'link'));
    symlinkSync('baseline.json', join(wt, 'link'));
    git(wt, ['add', 'link']);

    const r = sync(gate({}));

    expect(readlinkSync(join(dir, 'link'))).toBe('run.sh');
    expect(r.stderr).toBe('');
  });

  it('keeps the exec bit of a rewritten executable', () => {
    const { dir, stage, gate, sync } = shipRepo();
    stage({ 'run.sh': 'needs fmt\n' });

    sync(gate({ 'run.sh': 'formatted\n' }));

    expect(read(dir, 'run.sh')).toBe('formatted\n');
    expect(statSync(join(dir, 'run.sh')).mode & 0o111).not.toBe(0);
  });

  it('writes back a formatter that restored the base content', () => {
    const { dir, stage, gate, sync } = shipRepo();
    stage({ 'a.txt': 'base \n' });

    sync(gate({ 'a.txt': 'base\n' }));

    expect(read(dir, 'a.txt')).toBe('base\n');
  });

  it('only names the files in hint mode, with the command that syncs them', () => {
    const { dir, stage, gate, sync } = shipRepo();
    stage({ 'a.txt': 'needs fmt\n' });

    const r = sync(gate({ 'a.txt': 'formatted\n' }), 'hint');

    expect(read(dir, 'a.txt')).toBe('needs fmt\n');
    expect(r.stderr).toMatch(/git restore --source=\w+ --worktree -- a\.txt/);
  });

  it('writes a new briefed file the caller has not added, keeping it untracked', () => {
    const { dir, stage, gate, sync } = shipRepo();
    stage({ 'new.txt': 'needs fmt\n' });

    sync(gate({ 'new.txt': 'formatted\n' }));

    expect(read(dir, 'new.txt')).toBe('formatted\n');
    expect(git(dir, ['ls-files', '--', 'new.txt'])).toBe('');
  });

  it("does not run the caller's post-checkout hook", () => {
    const { dir, stage, gate, sync } = shipRepo();
    const marker = join(dir, 'post-checkout-ran');
    writeFileSync(join(dir, '.git/hooks/post-checkout'), `#!/bin/sh\n: > "${marker}"\n`);
    chmodSync(join(dir, '.git/hooks/post-checkout'), 0o755);
    stage({ 'a.txt': 'needs fmt\n' });

    sync(gate({ 'a.txt': 'formatted\n' }));

    expect(read(dir, 'a.txt')).toBe('formatted\n');
    expect(existsSync(marker)).toBe(false);
  });

  // A peer git command in a shared checkout holds index.lock, so restore fails; it must not read as synced.
  it('names a file restore could not write instead of reporting it synced', () => {
    const { dir, stage, gate, sync } = shipRepo();
    stage({ 'a.txt': 'needs fmt\n' });
    writeFileSync(join(dir, '.git/index.lock'), '');

    const r = sync(gate({ 'a.txt': 'formatted\n' }));

    expect(read(dir, 'a.txt')).toBe('needs fmt\n');
    expect(r.stderr).not.toContain('synced');
    expect(r.stderr).toMatch(/left as-is[\s\S]*a\.txt/);
  });

  // Without literal pathspecs, the glob `w [x].txt` also matches the unbriefed `w x.txt`.
  it('matches briefed names literally, never as globs', () => {
    const { dir, stage, gate, sync } = shipRepo();
    stage({ 'w [x].txt': 'needs fmt\n' });

    sync(gate({ 'w [x].txt': 'formatted\n', 'w x.txt': 'gate touched\n' }));

    expect(read(dir, 'w [x].txt')).toBe('formatted\n');
    expect(read(dir, 'w x.txt')).toBe('neighbour\n');
  });

  // Raw blob bytes are LF; the caller's checkout converts to CRLF on write, so the sync must too.
  it('writes through the caller eol attributes', () => {
    const { dir, stage, gate, sync } = shipRepo();
    stage({ 'f.crlf': 'needs fmt\r\n' });

    sync(gate({ 'f.crlf': 'formatted\r\n' }));

    expect(read(dir, 'f.crlf')).toBe('formatted\r\n');
  });
});

describe('ship-branch.sh — gate rewrites reach the caller', () => {
  const ghBin = () => ghStub('echo "https://github.com/acme/app/pull/42"');

  it('syncs the formatted file into the working copy on a real ship', () => {
    const { dir, env, bare } = seedShipRepoLocalRemote({
      hookBody: FORMAT_HOOK.replaceAll('FILE', 'note.txt'),
    });
    writeFileSync(join(dir, 'note.txt'), 'raw\n');

    const r = spawnSync('/bin/bash', [scriptPath, 'feat/fmt', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, PATH: `${ghBin()}:${process.env.PATH}` },
    });

    expect(r.status, r.stderr).toBe(0);
    expect(read(dir, 'note.txt')).toBe('formatted\n');
    expect(git(dir, ['--git-dir', bare, 'show', 'feat/fmt:note.txt'])).toBe('formatted');
    expect(r.stderr).toMatch(/synced your working copy/);
  });

  // --dry-gates commits nothing, so the "commit" is BASE: syncing it would revert the caller's edit.
  it('leaves an edited tracked file alone on a --dry-gates rehearsal', () => {
    const {
      dir,
      env,
      git: g,
    } = seedShipRepoLocalRemote({
      hookBody: FORMAT_HOOK.replaceAll('FILE', 'note.txt'),
    });
    writeFileSync(join(dir, 'note.txt'), 'base\n');
    g(['add', 'note.txt'], { stdio: 'ignore' });
    g(['commit', '-q', '--no-verify', '-m', 'tracked note'], { stdio: 'ignore' });
    g(['push', '-q', 'origin', 'work:work'], { stdio: 'ignore' });
    writeFileSync(join(dir, 'note.txt'), 'raw\n');

    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/fmt-dry-gates', 't', '--dry-gates', '--', 'note.txt'],
      { cwd: dir, input: '', encoding: 'utf8', env },
    );

    expect(r.status, r.stderr).toBe(0);
    expect(read(dir, 'note.txt')).toBe('raw\n');
  });

  it('leaves the working copy alone on a dry run', () => {
    const {
      dir,
      env,
      git: g,
    } = seedShipRepoLocalRemote({
      hookBody: FORMAT_HOOK.replaceAll('FILE', 'note.txt'),
    });
    writeFileSync(join(dir, 'note.txt'), 'raw\n');

    const r = spawnSync('/bin/bash', [scriptPath, 'feat/fmt-dry', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });

    dropWorktree(g, r.stderr);
    expect(r.status, r.stderr).toBe(0);
    expect(read(dir, 'note.txt')).toBe('raw\n');
  });

  it('only prints the sync command under --from-branch', () => {
    const {
      dir,
      env,
      git: g,
    } = seedShipRepoLocalRemote({
      hookBody: FORMAT_HOOK.replaceAll('FILE', 'note.txt'),
    });
    writeFileSync(join(dir, 'note.txt'), 'raw\n');
    g(['add', 'note.txt'], { stdio: 'ignore' });
    g(['commit', '-q', '--no-verify', '-m', 'raw note'], { stdio: 'ignore' });

    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/fmt-branch', 't', '--base', 'work', '--from-branch'],
      {
        cwd: dir,
        input: '',
        encoding: 'utf8',
        env: { ...env, PATH: `${ghBin()}:${process.env.PATH}` },
      },
    );

    expect(r.status, r.stderr).toBe(0);
    expect(read(dir, 'note.txt')).toBe('raw\n');
    expect(r.stderr).toMatch(/git restore --source=\w+ --worktree -- note\.txt/);
  });
});

describe('reship.sh (ship --pr) — gate rewrites reach the caller', () => {
  const runReship = (dir: string, env: Record<string, string>, args: string[]) =>
    spawnSync('/bin/bash', [reshipScript, ...args], {
      cwd: dir,
      input: 'body\n',
      encoding: 'utf8',
      env: { ...ENV, ...env },
    });

  it('syncs the formatted file on an append', () => {
    const { dir, env } = bodyUpdateRepo({ hookBody: FORMAT_HOOK.replaceAll('FILE', 'a.ts') });
    writeFileSync(join(dir, 'a.ts'), 'v2\n');

    const r = runReship(dir, env, ['feat/pr', 'add v2', '--pr', '--', 'a.ts']);

    expect(r.status, r.stderr).toBe(0);
    expect(read(dir, 'a.ts')).toBe('formatted\n');
  });

  it('syncs the formatted file on a --base rewrite', () => {
    const repo = rewriteRepo();
    const hook = join(repo.dir, '.husky/_/pre-commit');
    writeFileSync(hook, `#!/bin/sh\n${FORMAT_HOOK.replaceAll('FILE', 'conflict.txt')}\n`);

    const r = runReship(repo.dir, repo.env, [
      'feat/pr',
      'publish resolved PR',
      '--pr',
      '--base',
      'main',
      '--',
      'conflict.txt',
    ]);

    expect(r.status, r.stderr).toBe(0);
    expect(read(repo.dir, 'conflict.txt')).toBe('formatted\n');
  });

  it('leaves a file merged with a newer PR tip as-is', () => {
    const { dir, env, g } = bodyUpdateRepo({
      hookBody: "printf 'fmt\\n' >> a.ts\ngit add -- a.ts\nexit 0",
    });
    g(['config', 'core.hooksPath', '/dev/null']);
    writeFileSync(join(dir, 'a.ts'), 'l1\nl2\nl3\nl4\nl5\n');
    g(['commit', '-qam', 'five lines']);
    g(['push', '-q', 'origin', 'HEAD:feat/pr']);
    const callerHead = g(['rev-parse', 'HEAD']);
    writeFileSync(join(dir, 'a.ts'), 'l1\nl2\nl3\nl4\nL5 from the PR\n');
    g(['commit', '-qam', 'pr tip moves']);
    g(['push', '-q', 'origin', 'HEAD:feat/pr']);
    g(['reset', '-q', '--hard', callerHead]);
    g(['config', 'core.hooksPath', '.husky/_']);
    writeFileSync(join(dir, 'a.ts'), 'L1 from the caller\nl2\nl3\nl4\nl5\n');

    const r = runReship(dir, env, ['feat/pr', 'edit l1', '--pr', '--', 'a.ts']);

    expect(r.status, r.stderr).toBe(0);
    expect(read(dir, 'a.ts')).toBe('L1 from the caller\nl2\nl3\nl4\nl5\n');
    expect(r.stderr).toMatch(/left as-is/);
  });
});
