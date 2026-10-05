import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testExecFileSync as execFileSync, testSpawnSync as spawnSync } from './_helpers.mts';
import {
  dirs,
  dropWorktree,
  GIT_ENV,
  localBranchExists,
  remoteBranchExists,
  scriptPath,
  seedShipRepoLocalRemote,
} from './_ship-branch-fixture.mts';

const PREFLIGHT_BLOCK = 'blocked before creating a branch or worktree';
const anchorPath = join(scriptPath, '..', 'patch-anchor.sh');
const TEN_LINES = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join('\n') + '\n';

/** A checkout parked at the fork point A, plus an origin whose `base` branch is also at A and ready
 *  to be advanced. `seed(dir)` writes the fork-point content before it is committed and pushed. */
function seedForked(seed: (dir: string) => void, { hookBody = 'exit 0' } = {}) {
  const { dir, env, git, bare } = seedShipRepoLocalRemote({ hookBody });
  seed(dir);
  git(['add', '-A'], { stdio: 'ignore' });
  git(['commit', '-q', '-m', 'fork point'], { stdio: 'ignore' });
  git(['push', '-q', 'origin', 'work:base'], { stdio: 'ignore' });
  const forkPoint = git(['rev-parse', 'HEAD']).trim();
  return { dir, env, git, bare, forkPoint };
}

/** Advance origin/base with REAL new content, through a throwaway clone. The caller's checkout never
 *  fetches, so it stays at the fork point — which is the whole point of the bug. */
function advanceBase(bare: string, mutate: (clone: string) => void, message = 'base advances') {
  const clone = mkdtempSync(join(tmpdir(), 'shipbase-'));
  dirs.push(clone);
  const cgit = (a: string[]) =>
    execFileSync('git', a, { cwd: clone, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' });
  cgit(['clone', '-q', '--branch', 'base', bare, '.']);
  cgit(['config', 'user.email', 'a@b.c']);
  cgit(['config', 'user.name', 'a']);
  mutate(clone);
  cgit(['add', '-A']);
  cgit(['commit', '-q', '-m', message]);
  cgit(['push', '-q', 'origin', 'base']);
  return execFileSync('git', ['-C', bare, 'rev-parse', 'base'], {
    env: { ...process.env, ...GIT_ENV },
    encoding: 'utf8',
  }).trim();
}

function ship(dir: string, env: NodeJS.ProcessEnv, branch: string, paths: string[], extra = {}) {
  return spawnSync('/bin/bash', [scriptPath, branch, 'ship it', '--base', 'base', '--', ...paths], {
    cwd: dir,
    input: 'b\n',
    encoding: 'utf8',
    env: { ...env, SHIP_DRY_RUN: '1', ...extra },
  });
}

describe('ship --base: newer same-file base changes survive a stale caller patch (sc-2451)', () => {
  it('keeps the base’s hunk when the caller edited a DIFFERENT hunk of the same file', () => {
    const { dir, env, git, bare, forkPoint } = seedForked((d) =>
      writeFileSync(join(d, 'f.txt'), TEN_LINES),
    );
    const advancedTip = advanceBase(bare, (c) =>
      writeFileSync(join(c, 'f.txt'), TEN_LINES.replace('l10', 'l10-BASE')),
    );
    // The caller, still at the fork point, edits a disjoint hunk in their working tree.
    writeFileSync(join(dir, 'f.txt'), TEN_LINES.replace('l1\n', 'l1-CALLER\n'));
    expect(git(['rev-parse', 'HEAD']).trim()).toBe(forkPoint); // never fetched, still stale

    const r = ship(dir, env, 'feat/keep', ['f.txt']);
    dropWorktree(git, r.stderr);

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain(PREFLIGHT_BLOCK);
    expect(git(['rev-parse', 'feat/keep^']).trim()).toBe(advancedTip); // cut from the refreshed tip
    const shipped = git(['show', 'feat/keep:f.txt']);
    expect(shipped).toContain('l1-CALLER'); // the caller's work landed
    expect(shipped).toContain('l10-BASE'); // ...and the base's work was NOT reverted
    // The PR therefore carries ONLY the caller's change.
    expect(git(['diff', '--name-only', 'origin/base', 'feat/keep']).trim()).toBe('f.txt');
    expect(git(['diff', 'origin/base', 'feat/keep'])).not.toContain('-l10-BASE');
  });

  it('reverts nothing when the caller changed only the file MODE and the base changed its content', () => {
    const { dir, env, git, bare } = seedForked((d) => {
      writeFileSync(join(d, 'm.sh'), TEN_LINES);
    });
    advanceBase(bare, (c) => writeFileSync(join(c, 'm.sh'), TEN_LINES.replace('l10', 'l10-BASE')));
    chmodSync(join(dir, 'm.sh'), 0o755); // mode-only change; bytes untouched

    const r = ship(dir, env, 'feat/mode', ['m.sh']);
    dropWorktree(git, r.stderr);

    expect(r.status, r.stderr).toBe(0);
    expect(git(['ls-tree', 'feat/mode', '--', 'm.sh'])).toMatch(/^100755 /);
    expect(git(['show', 'feat/mode:m.sh'])).toContain('l10-BASE');
  });

  /** A binary b.dat that the base and the caller each changed since the fork point. */
  function seedBinaryBothSides(callerBytes: Buffer, baseBytes = Buffer.from([0x00, 0x09, 0x09])) {
    const fx = seedForked((d) => writeFileSync(join(d, 'b.dat'), Buffer.from([0x00, 0x01, 0x02])));
    advanceBase(fx.bare, (c) => writeFileSync(join(c, 'b.dat'), baseBytes));
    writeFileSync(join(fx.dir, 'b.dat'), callerBytes);
    return fx;
  }

  it('REFUSES before any branch on a binary path both sides changed', () => {
    // No three-way merge exists for a binary, so staging the caller's copy would revert the base's
    // change — git merge refuses the same case as a conflict.
    const { dir, env, git } = seedBinaryBothSides(Buffer.from([0x00, 0xff, 0x43]));

    const r = ship(dir, env, 'feat/bin', ['b.dat']);
    dropWorktree(git, r.stderr);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('non-mergeable path');
    expect(r.stderr).toMatch(/b\.dat\n\s+[0-9a-f]{7,} base advances\n/);
    expect(r.stderr).toContain('GUARD_SHIP_REPLACE_OK=1');
    expect(r.stderr).toContain(PREFLIGHT_BLOCK);
    expect(localBranchExists(git, 'feat/bin')).toBe(false);
  });

  it('ships the caller’s bytes wholesale on a both-sides binary under GUARD_SHIP_REPLACE_OK', () => {
    const { dir, env, git } = seedBinaryBothSides(Buffer.from([0x00, 0xff, 0x43]));

    const r = ship(dir, env, 'feat/binok', ['b.dat'], { GUARD_SHIP_REPLACE_OK: '1' });
    dropWorktree(git, r.stderr);

    expect(r.status, r.stderr).toBe(0);
    const callerOid = git(['hash-object', '--', join(dir, 'b.dat')]).trim();
    expect(git(['rev-parse', 'feat/binok:b.dat']).trim()).toBe(callerOid);
    expect(r.stderr).toContain('GUARD_SHIP_REPLACE_OK:');
    expect(r.stderr).toContain('non-mergeable path');
  });

  it('still refuses when GUARD_SHIP_REPLACE_OK=0', () => {
    const { dir, env, git } = seedBinaryBothSides(Buffer.from([0x00, 0xff, 0x43]));

    const r = ship(dir, env, 'feat/binoff', ['b.dat'], { GUARD_SHIP_REPLACE_OK: '0' });
    dropWorktree(git, r.stderr);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain(PREFLIGHT_BLOCK);
  });

  it('ships quietly when both sides changed a binary to IDENTICAL bytes', () => {
    const same = Buffer.from([0x00, 0x07, 0x07]);
    const { dir, env, git } = seedBinaryBothSides(same, same);
    writeFileSync(join(dir, 'f.txt'), 'caller\n'); // so the ship has something to carry

    const r = ship(dir, env, 'feat/binsame', ['b.dat', 'f.txt']);
    dropWorktree(git, r.stderr);

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain('non-mergeable path');
  });

  it('REFUSES on a symlink both sides retargeted DIFFERENTLY', () => {
    const { dir, env, git, bare } = seedForked((d) => {
      writeFileSync(join(d, 'a.txt'), 'a\n');
      symlinkSync('a.txt', join(d, 'lnk'));
    });
    advanceBase(bare, (c) => {
      unlinkSync(join(c, 'lnk'));
      symlinkSync('base.txt', join(c, 'lnk'));
    });
    unlinkSync(join(dir, 'lnk'));
    symlinkSync('caller.txt', join(dir, 'lnk'));

    const r = ship(dir, env, 'feat/lnkclash', ['lnk']);
    dropWorktree(git, r.stderr);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('non-mergeable path');
    expect(r.stderr).toContain('lnk');
    expect(localBranchExists(git, 'feat/lnkclash')).toBe(false);
  });

  it('REFUSES a binary deleted on one side and modified on the other, in both directions', () => {
    // An absent entry is the empty string: shipping would resurrect a binary the base deleted, or
    // carry a deletion over a binary the base just changed.
    const { dir, env, git, bare } = seedForked((d) => {
      writeFileSync(join(d, 'gone-on-base.dat'), Buffer.from([0x00, 0x01]));
      writeFileSync(join(d, 'gone-here.dat'), Buffer.from([0x00, 0x02]));
    });
    advanceBase(bare, (c) => {
      unlinkSync(join(c, 'gone-on-base.dat'));
      writeFileSync(join(c, 'gone-here.dat'), Buffer.from([0x00, 0x09]));
    });
    writeFileSync(join(dir, 'gone-on-base.dat'), Buffer.from([0x00, 0xff]));
    unlinkSync(join(dir, 'gone-here.dat'));

    const r = ship(dir, env, 'feat/bindel', ['gone-on-base.dat', 'gone-here.dat']);
    dropWorktree(git, r.stderr);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain(PREFLIGHT_BLOCK);
    const listing = r.stderr.split('non-mergeable path(s)')[1] ?? '';
    expect(listing).toContain('gone-on-base.dat');
    expect(listing).toContain('gone-here.dat');
  });

  it('staging refuses a both-sides binary the caller edited AFTER the preflight passed', () => {
    // The checkout is shared: a parallel agent can edit b.dat between the preflight's read and
    // staging's. Staging must not replace the base's copy just because the preflight saw it untouched.
    const { dir, git, bare, forkPoint } = seedForked((d) =>
      writeFileSync(join(d, 'b.dat'), Buffer.from([0x00, 0x01, 0x02])),
    );
    advanceBase(bare, (c) => writeFileSync(join(c, 'b.dat'), Buffer.from([0x00, 0x09, 0x09])));
    git(['fetch', '-q', 'origin', 'base'], { stdio: 'ignore' });
    const wt = join(dir, '.ship-wt');
    git(['worktree', 'add', '-q', '--detach', wt, 'FETCH_HEAD'], { stdio: 'ignore' });
    writeFileSync(join(dir, 'b.dat'), Buffer.from([0x00, 0xff, 0x43])); // the late edit

    const stage = (extra = {}) =>
      spawnSync(
        '/bin/bash',
        [
          '-c',
          `. "$1"; ship_stage_whole_file "$2" "$3" "$4" b.dat`,
          '_',
          anchorPath,
          dir,
          wt,
          forkPoint,
        ],
        { encoding: 'utf8', env: { ...process.env, ...GIT_ENV, ...extra } },
      );
    const baseOid = git(['rev-parse', 'FETCH_HEAD:b.dat']).trim();
    const stagedOid = () =>
      execFileSync('git', ['-C', wt, 'rev-parse', ':b.dat'], { encoding: 'utf8' }).trim();

    const r = stage();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('retry the same command');
    expect(stagedOid()).toBe(baseOid);

    // An approved replacement (the preflight's override, or a preserved-commit retry) still stages it.
    expect(stage({ WHOLE_REPLACE_ALLOWED: '1' }).status).toBe(0);
    expect(stagedOid()).not.toBe(baseOid);
  });

  it('SUCCEEDS on a symlink both sides retargeted', () => {
    const { dir, env, git, bare } = seedForked((d) => {
      writeFileSync(join(d, 'a.txt'), 'a\n');
      writeFileSync(join(d, 'b.txt'), 'b\n');
      symlinkSync('a.txt', join(d, 'lnk'));
    });
    advanceBase(bare, (c) => {
      unlinkSync(join(c, 'lnk'));
      symlinkSync('b.txt', join(c, 'lnk'));
    });
    unlinkSync(join(dir, 'lnk'));
    symlinkSync('b.txt', join(dir, 'lnk'));
    writeFileSync(join(dir, 'b.txt'), 'b-CALLER\n'); // so the ship has something to carry

    const r = ship(dir, env, 'feat/lnk', ['lnk', 'b.txt']);
    dropWorktree(git, r.stderr);

    expect(r.status, r.stderr).toBe(0);
    expect(git(['show', 'feat/lnk:lnk'])).toBe('b.txt');
    expect(r.stderr).not.toContain('non-mergeable path'); // same retarget both sides: nothing lost
  });

  it('ABORTS before the gate chain when both sides changed the same region', () => {
    const mark = join(tmpdir(), `ship-hook-mark-${process.pid}-${Date.now()}`);
    const { dir, env, git, bare } = seedForked((d) => writeFileSync(join(d, 'f.txt'), TEN_LINES), {
      // Tolerates an unset marker: this same hook runs for the fixture's OWN seed commit, where the
      // ship env does not exist yet. Only the ship's gate-chain invocation records anything.
      hookBody: '[ -n "${TEST_HOOK_MARK:-}" ] && echo ran >> "$TEST_HOOK_MARK"\nexit 0',
    });
    advanceBase(bare, (c) => writeFileSync(join(c, 'f.txt'), TEN_LINES.replace('l5', 'l5-BASE')));
    writeFileSync(join(dir, 'f.txt'), TEN_LINES.replace('l5', 'l5-CALLER'));

    const r = ship(dir, env, 'feat/clash', ['f.txt'], { TEST_HOOK_MARK: mark });
    dropWorktree(git, r.stderr);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('changed the same region of');
    expect(r.stderr).toContain('f.txt');
    // Decided BEFORE any branch or worktree exists (sc-3496), naming the commit and the remedy.
    expect(r.stderr).toContain(PREFLIGHT_BLOCK);
    expect(r.stderr).toMatch(/f\.txt\n\s+[0-9a-f]{7,} base advances\n/);
    expect(r.stderr).toContain('Merge or rebase origin/base into this checkout');
    expect(r.stderr.split('changed the same region of').length).toBe(2); // staging never re-ran it
    // The base-drift advisory printed to this same stderr, just above the abort. It must not
    // contradict it — that self-contradiction inside one run cost two ship rounds (sc-2664).
    expect(r.stderr).not.toMatch(/not blocked/i);
    // The negative only bites if the advisory fired at all; pin the wiring positively.
    expect(r.stderr).toContain('devkit ship:');
    expect(r.stderr).toContain('decided at staging');
    expect(existsSync(mark)).toBe(false); // the gate chain never ran
    expect(localBranchExists(git, 'feat/clash')).toBe(false);
    expect(remoteBranchExists(bare, 'feat/clash')).toBe(false);
    if (existsSync(mark)) rmSync(mark);
  });

  // sc-2770: a generated file both sides regenerated must be pointed at its generator, never at a
  // hand-merge that yields a manifest matching neither tree.
  const MANIFEST = '.devkit/skills-manifest.json';
  const manifest = (stamp: string) =>
    JSON.stringify({ generatedAt: stamp, files: { 'a/SKILL.md': stamp } }, null, 2) + '\n';

  function seedManifestClash(extra: (d: string) => void = () => {}) {
    const forked = seedForked((d) => {
      mkdirSync(join(d, '.devkit'), { recursive: true });
      writeFileSync(join(d, MANIFEST), manifest('fork'));
      writeFileSync(join(d, 'f.txt'), TEN_LINES);
      extra(d);
    });
    advanceBase(forked.bare, (c) => writeFileSync(join(c, MANIFEST), manifest('base')));
    writeFileSync(join(forked.dir, MANIFEST), manifest('caller'));
    return forked;
  }

  it('ABORTS naming the generator — not a hand-merge — when only a generated file conflicts', () => {
    const { dir, env, git, bare } = seedManifestClash();

    const r = ship(dir, env, 'feat/manifest', [MANIFEST]);
    dropWorktree(git, r.stderr);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain(MANIFEST);
    expect(r.stderr).toContain('`devkit sync-skills`');
    expect(r.stderr).toMatch(/do not hand-merge/i);
    expect(r.stderr).not.toContain('where you can see both sides');
    expect(localBranchExists(git, 'feat/manifest')).toBe(false);
    expect(remoteBranchExists(bare, 'feat/manifest')).toBe(false);
  });

  it('ABORTS listing generated and hand-written conflicts separately', () => {
    const { dir, env, git, bare } = seedManifestClash();
    advanceBase(bare, (c) => writeFileSync(join(c, 'f.txt'), TEN_LINES.replace('l5', 'l5-BASE')));
    writeFileSync(join(dir, 'f.txt'), TEN_LINES.replace('l5', 'l5-CALLER'));

    const r = ship(dir, env, 'feat/mixed', [MANIFEST, 'f.txt']);
    dropWorktree(git, r.stderr);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('`devkit sync-skills`');
    const hand = r.stderr.slice(r.stderr.indexOf('changed the same region of'));
    expect(hand).toContain('f.txt');
    expect(hand.split('where you can see both sides')[0]).not.toContain(MANIFEST);
  });

  it('ABORTS naming a CONSUMER-declared generator from guard.config.json verbatim', () => {
    const { dir, env, git, bare } = seedForked((d) => {
      mkdirSync(join(d, 'gen'), { recursive: true });
      writeFileSync(join(d, 'gen', 'api.json'), TEN_LINES);
      writeFileSync(
        join(d, 'guard.config.json'),
        JSON.stringify({ generated: [{ glob: 'gen/*.json', command: 'pnpm codegen' }] }),
      );
    });
    advanceBase(bare, (c) =>
      writeFileSync(join(c, 'gen', 'api.json'), TEN_LINES.replace('l5', 'l5-BASE')),
    );
    writeFileSync(join(dir, 'gen', 'api.json'), TEN_LINES.replace('l5', 'l5-CALLER'));

    const r = ship(dir, env, 'feat/codegen', ['gen/api.json']);
    dropWorktree(git, r.stderr);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('`pnpm codegen`');
    expect(r.stderr).not.toContain('where you can see both sides');
  });

  it('classifies a generated conflict whose NAME holds a tab — git C-quotes it unless read with -z', () => {
    const name = 'gen/a\tb.json';
    const { dir, env, git, bare } = seedForked((d) => {
      mkdirSync(join(d, 'gen'), { recursive: true });
      writeFileSync(join(d, name), TEN_LINES);
      writeFileSync(
        join(d, 'guard.config.json'),
        JSON.stringify({ generated: [{ glob: 'gen/**', command: 'pnpm codegen' }] }),
      );
    });
    advanceBase(bare, (c) => writeFileSync(join(c, name), TEN_LINES.replace('l5', 'l5-BASE')));
    writeFileSync(join(dir, name), TEN_LINES.replace('l5', 'l5-CALLER'));

    const r = ship(dir, env, 'feat/tabname', [name]);
    dropWorktree(git, r.stderr);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('`pnpm codegen`');
    expect(r.stderr).toContain(JSON.stringify(name));
    expect(r.stderr).not.toContain('where you can see both sides');
  });

  it('classifies by the config in the tree being SHIPPED, which a base-side declaration reaches', () => {
    // The stale checkout has no guard.config.json; origin/base declares gen/** as generated. The
    // conflicts come from the staged tree, so the declaration must be read from that same tree.
    const { dir, env, git, bare } = seedForked((d) => {
      mkdirSync(join(d, 'gen'), { recursive: true });
      writeFileSync(join(d, 'gen', 'api.json'), TEN_LINES);
    });
    advanceBase(bare, (c) => {
      writeFileSync(join(c, 'gen', 'api.json'), TEN_LINES.replace('l5', 'l5-BASE'));
      writeFileSync(
        join(c, 'guard.config.json'),
        JSON.stringify({ generated: [{ glob: 'gen/**', command: 'pnpm codegen' }] }),
      );
    });
    writeFileSync(join(dir, 'gen', 'api.json'), TEN_LINES.replace('l5', 'l5-CALLER'));

    const r = ship(dir, env, 'feat/basecfg', ['gen/api.json']);
    dropWorktree(git, r.stderr);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('`pnpm codegen`');
    expect(r.stderr).not.toContain('where you can see both sides');
  });

  it('FALLS BACK to the hand-merge text, still aborting, when the generated config is malformed', () => {
    const { dir, env, git } = seedManifestClash((d) =>
      writeFileSync(join(d, 'guard.config.json'), JSON.stringify({ generated: 'nope' })),
    );

    const r = ship(dir, env, 'feat/badcfg', [MANIFEST]);
    dropWorktree(git, r.stderr);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('changed the same region of');
    expect(r.stderr).toContain(MANIFEST);
    expect(r.stderr).toContain('where you can see both sides');
    expect(localBranchExists(git, 'feat/badcfg')).toBe(false);
  });

  it('ABORTS with a devkit message — not raw git — when the base DELETED a briefed path', () => {
    const { dir, env, git, bare } = seedForked((d) => {
      writeFileSync(join(d, 'd.txt'), TEN_LINES);
      writeFileSync(join(d, 'k.txt'), 'keep\n');
    });
    advanceBase(bare, (c) => unlinkSync(join(c, 'd.txt')));
    writeFileSync(join(dir, 'd.txt'), TEN_LINES.replace('l1\n', 'l1-CALLER\n'));

    const r = ship(dir, env, 'feat/gone', ['d.txt']);
    dropWorktree(git, r.stderr);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('deleted or retyped briefed path');
    expect(r.stderr).toContain('d.txt');
    expect(r.stderr).toContain(PREFLIGHT_BLOCK);
    expect(localBranchExists(git, 'feat/gone')).toBe(false);
  });

  it('ABORTS before the gate chain when the base already landed byte-identical content', () => {
    // The fork-point patch is NON-EMPTY (so the pre-worktree guard passes) yet three-way merges to a
    // no-op, leaving an empty index. Without the post-staging check the operator pays the whole gate
    // chain to reach git's "nothing added to commit but untracked files present".
    const mark = join(tmpdir(), `ship-dup-mark-${process.pid}-${Date.now()}`);
    const { dir, env, git, bare } = seedForked((d) => writeFileSync(join(d, 'f.txt'), TEN_LINES), {
      // Tolerates an unset marker: this same hook runs for the fixture's OWN seed commit, where the
      // ship env does not exist yet. Only the ship's gate-chain invocation records anything.
      hookBody: '[ -n "${TEST_HOOK_MARK:-}" ] && echo ran >> "$TEST_HOOK_MARK"\nexit 0',
    });
    const identical = TEN_LINES.replace('l1\n', 'l1-BOTH\n');
    advanceBase(bare, (c) => writeFileSync(join(c, 'f.txt'), identical));
    writeFileSync(join(dir, 'f.txt'), identical); // the same edit, made independently

    const r = ship(dir, env, 'feat/dup', ['f.txt'], { TEST_HOOK_MARK: mark });
    dropWorktree(git, r.stderr);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('already contains every briefed change');
    expect(existsSync(mark)).toBe(false);
    expect(localBranchExists(git, 'feat/dup')).toBe(false);
    if (existsSync(mark)) rmSync(mark);
  });

  it('ABORTS rather than clobbering a path that is untracked here but tracked on the base', () => {
    const { dir, env, git, bare } = seedForked((d) => writeFileSync(join(d, 'f.txt'), TEN_LINES));
    advanceBase(bare, (c) => writeFileSync(join(c, 'u.txt'), 'base owns this\n'));
    writeFileSync(join(dir, 'u.txt'), 'caller made this locally\n'); // untracked HERE, tracked on base

    const r = ship(dir, env, 'feat/untracked', ['u.txt']);
    dropWorktree(git, r.stderr);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('already tracks these briefed path');
    expect(r.stderr).toContain('u.txt');
    expect(localBranchExists(git, 'feat/untracked')).toBe(false);
  });

  it('is byte-identical to the old behaviour when the base has NOT moved', () => {
    // The no-regression anchor: merge-base(BASE, HEAD) == BASE, so no classification runs, the patch
    // stays BASE-anchored and the apply stays a plain `--index`.
    const { dir, env, git } = seedForked((d) => writeFileSync(join(d, 'f.txt'), TEN_LINES));
    writeFileSync(join(dir, 'f.txt'), TEN_LINES.replace('l1\n', 'l1-CALLER\n'));

    const r = ship(dir, env, 'feat/insync', ['f.txt']);
    dropWorktree(git, r.stderr);

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain('anchored at the fork point');
    expect(git(['show', 'feat/insync:f.txt'])).toBe(TEN_LINES.replace('l1\n', 'l1-CALLER\n'));
    expect(readFileSync(join(dir, 'f.txt'), 'utf8')).toContain('l1-CALLER');
  });
});

/** Edge cases around the fork-point anchoring: the shapes the happy-path suite above does not reach.
 *  Each one is a way the mechanism could be right in the common case and wrong in a real one. */
describe('ship --base: fork-point anchoring edge cases (sc-2451)', () => {
  it('still ships the caller’s local COMMITS, not just their dirty working tree', () => {
    // The fork-point diff runs merge-base -> WORKING TREE, which traverses HEAD. If it were ever
    // narrowed to HEAD -> working tree, every committed-but-unpushed change would be silently
    // dropped — the same class of loss as the bug being fixed, with the sign flipped.
    const { dir, env, git, bare } = seedForked((d) => writeFileSync(join(d, 'f.txt'), TEN_LINES));
    writeFileSync(join(dir, 'f.txt'), TEN_LINES.replace('l3', 'l3-COMMITTED'));
    git(['commit', '-q', '-am', 'local commit the caller made'], { stdio: 'ignore' });
    advanceBase(bare, (c) => writeFileSync(join(c, 'f.txt'), TEN_LINES.replace('l10', 'l10-BASE')));
    // ...and then a dirty edit on top of that commit.
    writeFileSync(
      join(dir, 'f.txt'),
      TEN_LINES.replace('l3', 'l3-COMMITTED').replace('l1\n', 'l1-DIRTY\n'),
    );

    const r = ship(dir, env, 'feat/commits', ['f.txt']);
    dropWorktree(git, r.stderr);

    expect(r.status, r.stderr).toBe(0);
    const shipped = git(['show', 'feat/commits:f.txt']);
    expect(shipped).toContain('l1-DIRTY'); // the working-tree edit
    expect(shipped).toContain('l3-COMMITTED'); // the local commit — must NOT be dropped
    expect(shipped).toContain('l10-BASE'); // and the base's work still survives
  });

  it('works from a DETACHED worktree — the shape the incident was reported from', () => {
    // sc-2451's report: "a detached worktree started at a4e71f69". Every Frink-provisioned worktree
    // is detached, so this is the primary environment, not an exotic one. merge-base must resolve
    // against a detached HEAD exactly as it does against a branch.
    const { dir, env, git, bare } = seedForked((d) => writeFileSync(join(d, 'f.txt'), TEN_LINES));
    git(['checkout', '-q', '--detach'], { stdio: 'ignore' });
    const advancedTip = advanceBase(bare, (c) =>
      writeFileSync(join(c, 'f.txt'), TEN_LINES.replace('l10', 'l10-BASE')),
    );
    writeFileSync(join(dir, 'f.txt'), TEN_LINES.replace('l1\n', 'l1-CALLER\n'));

    const r = ship(dir, env, 'feat/detached', ['f.txt']);
    dropWorktree(git, r.stderr);

    expect(r.status, r.stderr).toBe(0);
    expect(git(['rev-parse', 'feat/detached^']).trim()).toBe(advancedTip);
    const shipped = git(['show', 'feat/detached:f.txt']);
    expect(shipped).toContain('l1-CALLER');
    expect(shipped).toContain('l10-BASE');
  });

  it('preserves a base change to a briefed BINARY the caller never touched', () => {
    const { dir, env, git, bare } = seedForked((d) => {
      writeFileSync(join(d, 'b.dat'), Buffer.from([0x00, 0x01, 0x02]));
      writeFileSync(join(d, 'f.txt'), TEN_LINES);
    });
    const baseBytes = Buffer.from([0x00, 0x09, 0x09, 0x09]);
    advanceBase(bare, (c) => writeFileSync(join(c, 'b.dat'), baseBytes));
    writeFileSync(join(dir, 'f.txt'), TEN_LINES.replace('l1\n', 'l1-CALLER\n')); // b.dat untouched

    const r = ship(dir, env, 'feat/binkeep', ['f.txt', 'b.dat']);
    dropWorktree(git, r.stderr);

    expect(r.status, r.stderr).toBe(0);
    expect(git(['show', 'feat/binkeep:f.txt'])).toContain('l1-CALLER');
    // The base's binary must survive untouched, and the PR must not claim to change it.
    expect(git(['rev-parse', 'feat/binkeep:b.dat']).trim()).toBe(
      git(['rev-parse', 'origin/base:b.dat']).trim(),
    );
    expect(git(['diff', '--name-only', 'origin/base', 'feat/binkeep']).trim()).toBe('f.txt');
    // Nothing was replaced wholesale, so the drift advisory must stay quiet.
    expect(r.stderr).not.toContain('non-mergeable path');
  });

  it('does not false-abort on an untracked SYMLINK the base tracks identically', () => {
    // The untracked clobber probe compares OIDs. `git hash-object <path>` FOLLOWS a symlink and
    // hashes its target's content, while git stores the target STRING — so a naive comparison reads
    // an identical symlink as a conflict and aborts a ship that is entirely fine.
    const { dir, env, git, bare } = seedForked((d) => {
      writeFileSync(join(d, 'a.txt'), 'a\n');
      writeFileSync(join(d, 'f.txt'), TEN_LINES);
    });
    advanceBase(bare, (c) => symlinkSync('a.txt', join(c, 's')));
    symlinkSync('a.txt', join(dir, 's')); // untracked here, byte-identical to the base's
    writeFileSync(join(dir, 'f.txt'), TEN_LINES.replace('l1\n', 'l1-CALLER\n'));

    const r = ship(dir, env, 'feat/symkeep', ['f.txt', 's']);
    dropWorktree(git, r.stderr);

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain('already tracks these briefed path');
    expect(git(['show', 'feat/symkeep:s'])).toBe('a.txt');
  });

  it('falls back to the old behaviour when the base shares NO history with this checkout', () => {
    // `git merge-base` exits non-zero on unrelated histories. The fallback has to keep the ship
    // running on the pre-change path rather than letting a non-zero status kill it under `set -e`.
    const { dir, env, git, bare } = seedForked((d) => writeFileSync(join(d, 'f.txt'), TEN_LINES));
    const orphan = mkdtempSync(join(tmpdir(), 'shiporphan-'));
    dirs.push(orphan);
    const ogit = (a: string[]) =>
      execFileSync('git', a, {
        cwd: orphan,
        env: { ...process.env, ...GIT_ENV },
        encoding: 'utf8',
      });
    ogit(['init', '-q', '-b', 'unrelated']);
    ogit(['config', 'user.email', 'a@b.c']);
    ogit(['config', 'user.name', 'a']);
    writeFileSync(join(orphan, 'only-here.txt'), 'orphan\n');
    ogit(['add', 'only-here.txt']);
    ogit(['commit', '-q', '-m', 'unrelated root']);
    ogit(['push', '-q', '-f', bare, 'unrelated:base']);
    writeFileSync(join(dir, 'f.txt'), TEN_LINES.replace('l1\n', 'l1-CALLER\n'));

    // GUARD_SHIP_BASE_OK: an unrelated base is exactly what sc-2357's relatedness check refuses, and
    // this test needs one to reach the staging fallback under test. The hatch is the audited way in.
    const r = ship(dir, env, 'feat/orphan', ['f.txt'], { GUARD_SHIP_BASE_OK: '1' });
    dropWorktree(git, r.stderr);

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain('anchored at the fork point'); // no fork point exists
    expect(git(['show', 'feat/orphan:f.txt'])).toContain('l1-CALLER');
  });

  it('carries a briefed GITLINK deletion instead of resurrecting it from the stale index', () => {
    // The third member of the non-mergeable carve-out. A gitlink (mode 160000) is a bare commit
    // pointer whose object lives in the SUBMODULE's database, so `git apply --3way` has nothing to
    // merge and would fail on it — the same reason binary and symlink are carved out.
    //
    // The specific trap this pins: a 160000 index entry OUTLIVES `rm -rf sub/`. Reading the pointer
    // from `ls-files -s` alone therefore compares the fork point against itself, concludes nothing
    // changed, and silently drops a deletion the caller explicitly briefed. The worktree entry is
    // also a DIRECTORY, so carrying the deletion needs a recursive remove — a plain `rm -f` fails and
    // `set -e` would kill the ship.
    const { dir, env, git, bare } = seedForked((d) => writeFileSync(join(d, 'f.txt'), TEN_LINES));
    const subA = git(['rev-parse', 'HEAD']).trim();
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub/.keep'), ''); // a directory git will actually materialise
    git(['update-index', '--add', '--cacheinfo', `160000,${subA},sub`], { stdio: 'ignore' });
    git(['commit', '-q', '-m', 'add gitlink'], { stdio: 'ignore' });
    git(['push', '-q', '-f', 'origin', 'work:base'], { stdio: 'ignore' });
    expect(git(['ls-tree', 'HEAD', '--', 'sub'])).toContain(subA); // non-vacuity: it really is a gitlink

    // The base moves a normal file; the caller removes the submodule directory and edits that file.
    advanceBase(bare, (c) => writeFileSync(join(c, 'f.txt'), TEN_LINES.replace('l10', 'l10-BASE')));
    rmSync(join(dir, 'sub'), { recursive: true, force: true });
    writeFileSync(join(dir, 'f.txt'), TEN_LINES.replace('l1\n', 'l1-CALLER\n'));

    const r = ship(dir, env, 'feat/gitlink', ['f.txt', 'sub']);
    dropWorktree(git, r.stderr);

    // The gitlink never reached `git apply --3way`, so nothing conflicted and the ship completed.
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain('changed the same region of');
    // The briefed deletion was carried rather than resurrected from the stale index entry.
    expect(git(['ls-tree', 'feat/gitlink', '--', 'sub']).trim()).toBe('');
    // ...and the text path beside it still three-way merged correctly.
    const shipped = git(['show', 'feat/gitlink:f.txt']);
    expect(shipped).toContain('l1-CALLER');
    expect(shipped).toContain('l10-BASE');
  });

  it('does not false-abort on an untracked symlink whose target ENDS in a newline', () => {
    // A POSIX symlink target is an arbitrary byte string, so `ln -s $'a\n' lnk` is legal. Plain
    // readlink appends a newline git does not store, and the obvious correction — command
    // substitution — strips ALL trailing newlines, including ones belonging to the target. That
    // hashes "a\n" as "a" and reports an identical symlink as a clobber.
    const { dir, env, git, bare } = seedForked((d) => {
      writeFileSync(join(d, 'f.txt'), TEN_LINES);
    });
    advanceBase(bare, (c) => symlinkSync('a\n', join(c, 'nl')));
    symlinkSync('a\n', join(dir, 'nl')); // untracked here, byte-identical to the base's
    writeFileSync(join(dir, 'f.txt'), TEN_LINES.replace('l1\n', 'l1-CALLER\n'));

    const r = ship(dir, env, 'feat/nlsym', ['f.txt', 'nl']);
    dropWorktree(git, r.stderr);

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain('already tracks these briefed path');
  });

  it('ABORTS rather than clobbering a base path that is gitignored-and-untracked here', () => {
    // The ignored pass force-adds (`git add -f`), because a briefed path can legitimately sit under a
    // gitignored-but-force-tracked tree — devkit's own `dist/` is exactly that. Force-adding a path
    // the base ADDED after the fork replaces the base's version with no merge and no diff to review,
    // so this pass needs the same clobber check as the ordinary untracked one.
    const { dir, env, git, bare } = seedForked((d) => {
      writeFileSync(join(d, '.gitignore'), 'dist/\n');
      writeFileSync(join(d, 'f.txt'), TEN_LINES);
    });
    advanceBase(bare, (c) => {
      mkdirSync(join(c, 'dist'), { recursive: true });
      writeFileSync(join(c, 'dist/x.js'), 'base built this\n');
      // Force-tracked past the ignore rule, the shape the ignored pass exists to serve.
      execFileSync('git', ['-C', c, 'add', '-f', 'dist/x.js'], {
        env: { ...process.env, ...GIT_ENV },
        encoding: 'utf8',
      });
    });
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist/x.js'), 'caller built this\n'); // ignored + untracked HERE

    const r = ship(dir, env, 'feat/ignored', ['dist/x.js']);
    dropWorktree(git, r.stderr);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('already tracks these briefed path');
    expect(r.stderr).toContain('dist/x.js');
    expect(localBranchExists(git, 'feat/ignored')).toBe(false);
  });

  it('--dry-gates preserves the base hunk too, and keeps nothing behind', () => {
    // The safe-preview command an agent runs first. It shares this staging arm, so if it disagreed
    // with the real ship an agent would get a false green from the very command meant to de-risk.
    const { dir, env, git, bare } = seedForked((d) => writeFileSync(join(d, 'f.txt'), TEN_LINES), {
      hookBody: [
        '[ "${DEVKIT_RUN_MODE:-}" = dry-gates ] || exit 0',
        'grep -q l10-BASE f.txt || exit 91', // the base's hunk reached the prepared tree
        'grep -q l1-CALLER f.txt || exit 92',
        'echo DRY_BASE_OK',
      ].join('\n'),
    });
    advanceBase(bare, (c) => writeFileSync(join(c, 'f.txt'), TEN_LINES.replace('l10', 'l10-BASE')));
    writeFileSync(join(dir, 'f.txt'), TEN_LINES.replace('l1\n', 'l1-CALLER\n'));

    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/drygate', 'ship it', '--base', 'base', '--dry-gates', '--', 'f.txt'],
      { cwd: dir, input: 'b\n', encoding: 'utf8', env },
    );

    expect(r.status, r.stderr).toBe(0);
    expect(localBranchExists(git, 'feat/drygate')).toBe(false);
    expect(remoteBranchExists(bare, 'feat/drygate')).toBe(false);
  });
});

/** The region of stderr that names same-region conflicts, so a path merely narrated by git's own
 *  "Applied patch to 'x' cleanly." cannot satisfy — or break — an assertion about what was blamed. */
function conflictListing(stderr: string) {
  return stderr.split('changed the same region of:')[1]?.split('ship cannot resolve')[0] ?? '';
}

/** The per-path base-commit section printed under the conflict listing (sc-3496). */
function commitListing(stderr: string) {
  return stderr.split('base commits behind these conflicts')[1]?.split('Merge or rebase')[0] ?? '';
}

describe('ship --base: the hunk-level verdict is taken before any branch exists (sc-3496)', () => {
  it('names EVERY conflicting path and never blames a path that merged cleanly', () => {
    const { dir, env, git, bare } = seedForked((d) => {
      for (const f of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(join(d, f), TEN_LINES);
    });
    advanceBase(bare, (c) => {
      writeFileSync(join(c, 'a.txt'), TEN_LINES.replace('l5', 'l5-BASE'));
      writeFileSync(join(c, 'b.txt'), TEN_LINES.replace('l2', 'l2-BASE'));
    });
    writeFileSync(join(dir, 'a.txt'), TEN_LINES.replace('l5', 'l5-CALLER'));
    writeFileSync(join(dir, 'b.txt'), TEN_LINES.replace('l2', 'l2-CALLER'));
    writeFileSync(join(dir, 'c.txt'), TEN_LINES.replace('l7', 'l7-CALLER')); // base never touched it

    const r = ship(dir, env, 'feat/multi', ['a.txt', 'b.txt', 'c.txt']);
    dropWorktree(git, r.stderr);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain(PREFLIGHT_BLOCK);
    const listed = conflictListing(r.stderr);
    expect(listed).toContain('a.txt');
    expect(listed).toContain('b.txt');
    expect(listed).not.toContain('c.txt');
    expect(localBranchExists(git, 'feat/multi')).toBe(false);
  });

  it('caps the diverging-commit list at the three NEWEST, so history cannot bury the remedy', () => {
    const { dir, env, git, bare } = seedForked((d) => writeFileSync(join(d, 'f.txt'), TEN_LINES));
    for (const n of [1, 2, 3, 4]) {
      const body = TEN_LINES.replace('l5', `l5-BASE-${n}`);
      advanceBase(bare, (c) => writeFileSync(join(c, 'f.txt'), body), `base edit ${n}`);
    }
    writeFileSync(join(dir, 'f.txt'), TEN_LINES.replace('l5', 'l5-CALLER'));

    const r = ship(dir, env, 'feat/hot', ['f.txt']);
    dropWorktree(git, r.stderr);

    expect(r.status).toBe(1);
    const listed = commitListing(r.stderr);
    expect(listed).toMatch(/base edit 4[\s\S]*base edit 3[\s\S]*base edit 2/); // newest first
    expect(listed).not.toContain('base edit 1');
    expect(r.stderr.trimEnd().split('\n').at(-2)).toContain('Merge or rebase origin/base');
  });

  it('names a conflicting path that holds glob and pathspec-magic characters literally', () => {
    const odd = ':weird name*.txt';
    const { dir, env, git, bare } = seedForked((d) => {
      writeFileSync(join(d, odd), TEN_LINES);
      writeFileSync(join(d, 'weird name-sibling.txt'), TEN_LINES); // a `*` glob would also match this
    });
    advanceBase(
      bare,
      (c) => {
        writeFileSync(join(c, odd), TEN_LINES.replace('l5', 'l5-BASE'));
        writeFileSync(join(c, 'weird name-sibling.txt'), 'sibling moved\n');
      },
      'odd path edit',
    );
    writeFileSync(join(dir, odd), TEN_LINES.replace('l5', 'l5-CALLER'));

    const r = ship(dir, env, 'feat/odd', [odd]);
    dropWorktree(git, r.stderr);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain(PREFLIGHT_BLOCK);
    const listed = conflictListing(r.stderr);
    expect(listed).toContain(':weird name*.txt');
    expect(listed).not.toContain('sibling');
    const commits = commitListing(r.stderr);
    expect(commits).toContain('weird\\ name\\*.txt'); // %q-quoted, one entry
    expect(commits).toContain('odd path edit'); // the commit lookup matched the name literally
    expect(commits).not.toContain('sibling');
  });

  it('names a conflicting path that holds a NEWLINE as one path, not as fragments', () => {
    const nl = 'two\nlines.txt';
    const { dir, env, git, bare } = seedForked((d) => {
      writeFileSync(join(d, nl), TEN_LINES);
      writeFileSync(join(d, 'lines.txt'), TEN_LINES); // the fragment a newline split would blame
    });
    advanceBase(
      bare,
      (c) => writeFileSync(join(c, nl), TEN_LINES.replace('l5', 'l5-BASE')),
      'nl edit',
    );
    writeFileSync(join(dir, nl), TEN_LINES.replace('l5', 'l5-CALLER'));

    const r = ship(dir, env, 'feat/nl', [nl]);
    dropWorktree(git, r.stderr);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain(PREFLIGHT_BLOCK);
    const listed = conflictListing(r.stderr);
    expect(listed.trim().split('\n')).toHaveLength(1); // one entry, not two fragments
    expect(listed).not.toMatch(/^ {2}lines\.txt$/m);
    const commits = commitListing(r.stderr);
    expect(commits).toContain("$'two\\nlines.txt'"); // %q-quoted, one entry
    expect(commits).toContain('nl edit'); // the commit lookup used the whole path
    expect(commits).not.toMatch(/^ {2}lines\.txt$/m);
    expect(commits).not.toMatch(/^ {2}two$/m);
  });

  it('leaves the caller’s own index and TMPDIR exactly as it found them', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ship-trial-tmp-'));
    dirs.push(tmp);
    const { dir, env, git, bare } = seedForked((d) => {
      writeFileSync(join(d, 'f.txt'), TEN_LINES);
      writeFileSync(join(d, 'staged.txt'), 'before\n');
    });
    advanceBase(bare, (c) => writeFileSync(join(c, 'f.txt'), TEN_LINES.replace('l5', 'l5-BASE')));
    writeFileSync(join(dir, 'f.txt'), TEN_LINES.replace('l5', 'l5-CALLER'));
    writeFileSync(join(dir, 'staged.txt'), 'staged by the caller\n');
    git(['add', 'staged.txt']);
    const indexBefore = git(['ls-files', '-s']);

    const r = ship(dir, env, 'feat/clean', ['f.txt'], { TMPDIR: tmp });
    dropWorktree(git, r.stderr);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain(PREFLIGHT_BLOCK);
    expect(git(['ls-files', '-s'])).toBe(indexBefore);
    expect(git(['ls-files', '-u'])).toBe('');
    expect(git(['diff', '--cached', '--name-only']).trim()).toBe('staged.txt');
    expect(readdirSync(tmp).filter((f) => f.startsWith('ship-trial'))).toEqual([]);
  });

  it('fails OPEN when the trial itself cannot run, leaving staging to take the verdict', () => {
    // A git that rejects `apply --cached --3way` — the shape of git < 2.32. The trial must neither
    // block a ship that merges cleanly nor swallow a real conflict: staging still decides both.
    const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const shim = mkdtempSync(join(tmpdir(), 'ship-git-shim-'));
    dirs.push(shim);
    writeFileSync(
      join(shim, 'git'),
      [
        '#!/bin/bash',
        'cached=0; three=0',
        'for a in "$@"; do case $a in --cached) cached=1;; --3way) three=1;; esac; done',
        '[ "$cached$three" = 11 ] && { echo "error: --cached and --3way cannot be used together." >&2; exit 128; }',
        `exec '${realGit}' "$@"`,
      ].join('\n'),
    );
    chmodSync(join(shim, 'git'), 0o755);
    const shimEnv = (env: NodeJS.ProcessEnv) => ({
      PATH: `${shim}:${env.PATH ?? process.env.PATH}`,
    });

    const clean = seedForked((d) => writeFileSync(join(d, 'f.txt'), TEN_LINES));
    advanceBase(clean.bare, (c) =>
      writeFileSync(join(c, 'f.txt'), TEN_LINES.replace('l10', 'l10-BASE')),
    );
    writeFileSync(join(clean.dir, 'f.txt'), TEN_LINES.replace('l1\n', 'l1-CALLER\n'));
    const ok = ship(clean.dir, clean.env, 'feat/old-git', ['f.txt'], shimEnv(clean.env));
    dropWorktree(clean.git, ok.stderr);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stderr).not.toContain(PREFLIGHT_BLOCK);

    const clash = seedForked((d) => writeFileSync(join(d, 'f.txt'), TEN_LINES));
    advanceBase(clash.bare, (c) =>
      writeFileSync(join(c, 'f.txt'), TEN_LINES.replace('l5', 'l5-BASE')),
    );
    writeFileSync(join(clash.dir, 'f.txt'), TEN_LINES.replace('l5', 'l5-CALLER'));
    const late = ship(clash.dir, clash.env, 'feat/old-git-clash', ['f.txt'], shimEnv(clash.env));
    dropWorktree(clash.git, late.stderr);
    expect(late.status).toBe(1);
    expect(late.stderr).not.toContain(PREFLIGHT_BLOCK); // the trial stepped aside...
    expect(late.stderr).toContain('changed the same region of'); // ...and staging still caught it
    expect(localBranchExists(clash.git, 'feat/old-git-clash')).toBe(false);
  });

  it('steps aside for an existing branch so a preserved-commit retry reaches its OWN refusal', () => {
    const { dir, env, git, bare } = seedForked((d) => writeFileSync(join(d, 'f.txt'), TEN_LINES));
    git(['branch', 'feat/again']); // a prior attempt's branch, still at the fork point
    advanceBase(bare, (c) => writeFileSync(join(c, 'f.txt'), TEN_LINES.replace('l5', 'l5-BASE')));
    writeFileSync(join(dir, 'f.txt'), TEN_LINES.replace('l5', 'l5-CALLER'));

    // Non-dry: a dry run refuses any existing branch outright, before the trial could be reached.
    const r = ship(dir, env, 'feat/again', ['f.txt'], { SHIP_DRY_RUN: '' });
    dropWorktree(git, r.stderr);

    expect(r.status).not.toBe(0);
    expect(r.stderr).not.toContain(PREFLIGHT_BLOCK);
    expect(r.stderr).toContain('branch already exists: feat/again');
    expect(remoteBranchExists(bare, 'feat/again')).toBe(false);
  });
});
