import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gateConfigFingerprint } from '../config-fingerprint.mts';
import { checkPrefix, computeKey, recordPrefix } from '../prefix-cache.mts';

const SHA256 = /^[0-9a-f]{64}$/;

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'gate-fp-'));
  dirs.push(d);
  return d;
};
// A repo dir with an optional guard.config.json (no git — the fingerprint reads config + files, not git).
const repo = (config?: object) => {
  const d = tempDir();
  if (config) writeFileSync(join(d, 'guard.config.json'), JSON.stringify(config));
  return d;
};
const writeBaseline = (d: string, name: string, body: string) => {
  mkdirSync(join(d, 'eslint', 'baselines'), { recursive: true });
  writeFileSync(join(d, 'eslint', 'baselines', name), body);
};

let savedJscpd: string | undefined;
let savedShip: string | undefined;
beforeEach(() => {
  savedJscpd = process.env.JSCPD_BIN;
  savedShip = process.env.DEVKIT_SHIP;
});
afterEach(() => {
  if (savedJscpd === undefined) delete process.env.JSCPD_BIN;
  else process.env.JSCPD_BIN = savedJscpd;
  if (savedShip === undefined) delete process.env.DEVKIT_SHIP;
  else process.env.DEVKIT_SHIP = savedShip;
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

// Each of these changed a gate verdict in the session that surfaced the masking bug; the fingerprint
// must move for every one, or a stale all-green prefix would skip the newly-hardened gate.
describe('gateConfigFingerprint — invalidating inputs', () => {
  it('indexPath null → set (the matcher opting in) changes the fingerprint', () => {
    const d = repo({ scanRoots: ['src'] });
    const before = gateConfigFingerprint(d);
    writeFileSync(
      join(d, 'guard.config.json'),
      JSON.stringify({ scanRoots: ['src'], indexPath: '.search-code/index.db' }),
    );
    expect(gateConfigFingerprint(d)).not.toBe(before);
  });

  it('a ratchet .json AND a structure .mjs baseline each change the fingerprint', () => {
    const d = repo({ scanRoots: ['src'] });
    writeBaseline(d, 'fanout.json', '{"src/x":13}');
    const afterJson = gateConfigFingerprint(d);
    writeFileSync(join(d, 'eslint', 'baselines', 'fanout.json'), '{"src/x":99}');
    expect(gateConfigFingerprint(d)).not.toBe(afterJson);
    // The .mjs grandfather/exempt lists the structure gate reads — distinct from the .json ratchets.
    const beforeMjs = gateConfigFingerprint(d);
    writeBaseline(d, 'app.mjs', 'export default ["src/legacy.ts"];');
    expect(gateConfigFingerprint(d)).not.toBe(beforeMjs);
  });

  it('the index changes on both size and mtime (the stat proxy)', () => {
    const d = repo({ indexPath: '.search-code/index.db' });
    mkdirSync(join(d, '.search-code'), { recursive: true });
    const idx = join(d, '.search-code', 'index.db');
    writeFileSync(idx, 'aaa');
    const bySize = gateConfigFingerprint(d);
    writeFileSync(idx, 'bbbb'); // size change
    expect(gateConfigFingerprint(d)).not.toBe(bySize);
    const byMtime = gateConfigFingerprint(d);
    const t = Date.now() / 1000 + 120;
    utimesSync(idx, t, t); // same bytes, later mtime
    expect(gateConfigFingerprint(d)).not.toBe(byMtime);
  });

  it('a change to the co-occurrence allowlist contents changes the fingerprint', () => {
    const d = repo({ allowlistPath: '.co-occurrence-allowlist.json' });
    writeFileSync(join(d, '.co-occurrence-allowlist.json'), '{"clones":[]}');
    const before = gateConfigFingerprint(d);
    writeFileSync(join(d, '.co-occurrence-allowlist.json'), '{"clones":[{"hash":"abc"}]}');
    expect(gateConfigFingerprint(d)).not.toBe(before);
  });

  it('jscpd newly present, then upgraded in place, each change the fingerprint', () => {
    const d = repo({});
    const bin = join(d, 'jscpd-bin');
    process.env.JSCPD_BIN = bin; // resolved verbatim; does not exist yet
    const absent = gateConfigFingerprint(d);
    writeFileSync(bin, '#!/bin/sh\n'); // newly present
    const present = gateConfigFingerprint(d);
    expect(present).not.toBe(absent);
    writeFileSync(bin, '#!/bin/sh\necho v2\n'); // upgraded in place (size change)
    expect(gateConfigFingerprint(d)).not.toBe(present);
  });
});

// The fingerprint must NOT move when nothing that governs a verdict changed — else the cache never
// hits and its whole purpose (skip re-verifying an unchanged tree on retry) is silently defeated.
describe('gateConfigFingerprint — stability (or the cache is useless)', () => {
  it('is path-independent: the same config in two different dirs hashes identically (C1)', () => {
    delete process.env.JSCPD_BIN; // both resolve to devkit's own bundled jscpd → identical
    const cfg = { scanRoots: ['src'], indexPath: null };
    expect(gateConfigFingerprint(repo(cfg))).toBe(gateConfigFingerprint(repo(cfg)));
  });

  it('is stable under reordered keys inside a structure tree (canonicalization)', () => {
    delete process.env.JSCPD_BIN;
    const a = repo({ structure: { trees: [{ name: 'x', root: 'src' }] } });
    const b = repo({ structure: { trees: [{ root: 'src', name: 'x' }] } });
    expect(gateConfigFingerprint(a)).toBe(gateConfigFingerprint(b));
  });

  it('reads gate inputs through symlinks — a worktree symlinking $ROOT hashes identically (no lstat)', () => {
    // The real ship shape: link-gate-configs.sh SYMLINKS $ROOT's config/index/baselines into the
    // ephemeral worktree. statSync/readFileSync must FOLLOW those links (lstat would key on the symlink
    // inode → a fresh worktree per retry never matches the recorded prefix → the cache silently dies).
    delete process.env.JSCPD_BIN; // both resolve to devkit's own bundled jscpd → identical
    const root = repo({ scanRoots: ['src'], indexPath: '.search-code/index.db' });
    writeBaseline(root, 'fanout.json', '{"src/x":13}');
    mkdirSync(join(root, '.search-code'), { recursive: true });
    writeFileSync(join(root, '.search-code', 'index.db'), 'idx-bytes');
    const real = gateConfigFingerprint(root);

    const linkWorktree = () => {
      const wt = tempDir();
      symlinkSync(join(root, 'guard.config.json'), join(wt, 'guard.config.json'));
      mkdirSync(join(wt, 'eslint'), { recursive: true });
      symlinkSync(join(root, 'eslint', 'baselines'), join(wt, 'eslint', 'baselines')); // dir symlink
      mkdirSync(join(wt, '.search-code'), { recursive: true });
      symlinkSync(join(root, '.search-code', 'index.db'), join(wt, '.search-code', 'index.db'));
      return wt;
    };
    // A worktree that only symlinks the inputs hashes the SAME as reading the reals directly...
    expect(gateConfigFingerprint(linkWorktree())).toBe(real);
    // ...and two independent worktrees agree, so a retry from a fresh ship worktree hits the prefix.
    expect(gateConfigFingerprint(linkWorktree())).toBe(gateConfigFingerprint(linkWorktree()));
  });

  it('a global jscpd (bare-PATH terminal) yields a real hash, not a crash (H2)', () => {
    process.env.JSCPD_BIN = 'jscpd'; // the fail-open PATH terminal — must NOT statSync("jscpd")
    const d = repo({});
    expect(() => gateConfigFingerprint(d)).not.toThrow();
    expect(gateConfigFingerprint(d)).toMatch(SHA256);
  });
});

// The end-to-end masking bug this whole change exists to close.
describe('regression: a PASS earned under weaker config does not survive a config hardening', () => {
  it('checkPrefix misses after the config hardens, even with an unchanged staged tree', () => {
    process.env.DEVKIT_SHIP = '1';
    const d = tempDir();
    execSync('git init -q', { cwd: d });
    // guard.config.json is gitignored (the reported case) → NEVER in the staged tree, so git write-tree
    // can't see it change. Only the config fingerprint can.
    writeFileSync(join(d, '.gitignore'), 'guard.config.json\n.search-code/\n');
    writeFileSync(join(d, 'guard.config.json'), JSON.stringify({ scanRoots: ['src'] })); // weak: no index
    writeFileSync(join(d, 'a.ts'), 'export const a = 1;');
    execSync('git add -A', { cwd: d });
    recordPrefix(d); // all-green recorded under the weak config
    expect(checkPrefix(d)).toBe(true); // identical tree + identical config → hits (the cache still works)
    // Wire the matcher on (indexPath) WITHOUT touching the staged tree. Pre-fix this collided with the
    // weak-config PASS and silently skipped the newly-wired gate.
    writeFileSync(
      join(d, 'guard.config.json'),
      JSON.stringify({ scanRoots: ['src'], indexPath: '.search-code/index.db' }),
    );
    expect(checkPrefix(d)).toBe(false); // config hardened → miss → the gates re-run
  });
});

// Fail toward invalidation: an unreadable config must run the gates, never trust a prior PASS.
describe('malformed config → null key (run the gates)', () => {
  it('gateConfigFingerprint throws and computeKey returns null', () => {
    const d = tempDir();
    execSync('git init -q', { cwd: d });
    writeFileSync(join(d, 'a.txt'), 'x');
    execSync('git add .', { cwd: d });
    writeFileSync(join(d, 'guard.config.json'), '{ not json');
    expect(() => gateConfigFingerprint(d)).toThrow();
    // computeKey gets a valid tree + no hook, but the fingerprint throws → null (not a trusted key).
    expect(computeKey(d)).toBeNull();
  });
});
