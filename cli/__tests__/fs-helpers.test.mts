import fs, {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { writeIfAbsent } from '../lib/fs-helpers.mts';

// writeIfAbsent must materialize a REAL file at the literal path it is given — even when a sibling
// tool left the dest dir (or file) as a symlink. The reported crash: `devkit init` aborted in
// skills-sync on a DANGLING .cursor/skills/<name> → ../../.agents/skills/<name> (mkdirSync recursive
// throws ENOENT on a dangling-symlink dir).

const dirs = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'dk-fsh-'));
  dirs.push(d);
  return d;
}

describe('writeIfAbsent — symlink dest is replaced with a real entry, never followed', () => {
  it('creates a real dir + file when the dest dir is a DANGLING symlink (the reported crash)', () => {
    const root = tmp();
    mkdirSync(join(root, '.cursor', 'skills'), { recursive: true });
    // .cursor/skills/brainstorming → ../../.agents/skills/brainstorming  (target absent → dangling)
    symlinkSync(
      '../../.agents/skills/brainstorming',
      join(root, '.cursor', 'skills', 'brainstorming'),
    );
    const dest = join(root, '.cursor', 'skills', 'brainstorming', 'SKILL.md');

    expect(() => writeIfAbsent(dest, 'hi', { force: true })).not.toThrow();
    expect(lstatSync(join(root, '.cursor', 'skills', 'brainstorming')).isDirectory()).toBe(true);
    expect(readFileSync(dest, 'utf8')).toBe('hi');
    expect(existsSync(join(root, '.agents'))).toBe(false); // never followed the link / created the target
  });

  it('replaces a LIVE symlink dir so the file lands at the literal path, not the link target', () => {
    const root = tmp();
    const realElsewhere = join(root, 'elsewhere');
    mkdirSync(realElsewhere, { recursive: true });
    mkdirSync(join(root, '.cursor', 'skills'), { recursive: true });
    symlinkSync('../../elsewhere', join(root, '.cursor', 'skills', 'foo'));
    const dest = join(root, '.cursor', 'skills', 'foo', 'SKILL.md');

    writeIfAbsent(dest, 'real', { force: true });
    expect(lstatSync(join(root, '.cursor', 'skills', 'foo')).isSymbolicLink()).toBe(false);
    expect(readFileSync(dest, 'utf8')).toBe('real');
    expect(existsSync(join(realElsewhere, 'SKILL.md'))).toBe(false); // write did NOT leak into the link target
  });

  it('replaces a dangling-symlink dest FILE', () => {
    const root = tmp();
    mkdirSync(join(root, 'd'), { recursive: true });
    symlinkSync('missing-target', join(root, 'd', 'f.json'));
    const dest = join(root, 'd', 'f.json');
    expect(() => writeIfAbsent(dest, '{}', { force: true })).not.toThrow();
    expect(lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(readFileSync(dest, 'utf8')).toBe('{}');
  });

  it('still behaves normally on plain paths (created / exists / forced)', () => {
    const root = tmp();
    const f = join(root, 'a', 'b', 'c.txt');
    expect(writeIfAbsent(f, 'one')).toBe('created');
    expect(writeIfAbsent(f, 'two')).toBe('exists');
    expect(readFileSync(f, 'utf8')).toBe('one');
    expect(writeIfAbsent(f, 'two', { force: true })).toBe('forced');
    expect(readFileSync(f, 'utf8')).toBe('two');
  });

  it('does not disturb a real existing dir (no spurious replace)', () => {
    const root = tmp();
    mkdirSync(join(root, 'real'), { recursive: true });
    writeFileSync(join(root, 'real', 'keep.txt'), 'keep');
    writeIfAbsent(join(root, 'real', 'new.txt'), 'new', { force: true });
    expect(readFileSync(join(root, 'real', 'keep.txt'), 'utf8')).toBe('keep'); // sibling untouched
    expect(readFileSync(join(root, 'real', 'new.txt'), 'utf8')).toBe('new');
  });
});

describe('writeIfAbsent — exclusive create without force', () => {
  it('keeps a file another writer creates between the call and the write', () => {
    const f = join(tmp(), 'cfg', 'guard.config.json');
    const realMkdirSync = fs.mkdirSync;
    // SAFETY: the wrapper forwards every argument to the real mkdirSync and returns its value.
    fs.mkdirSync = ((...args: Parameters<typeof fs.mkdirSync>) => {
      const made = realMkdirSync(...args);
      writeFileSync(f, 'theirs'); // a concurrent writer lands inside the window
      return made;
    }) as typeof fs.mkdirSync;
    syncBuiltinESMExports(); // fs-helpers.mts binds mkdirSync by name
    try {
      expect(writeIfAbsent(f, 'ours')).toBe('exists');
    } finally {
      fs.mkdirSync = realMkdirSync;
      syncBuiltinESMExports();
    }
    expect(readFileSync(f, 'utf8')).toBe('theirs');
  });

  it('leaves a LIVE leaf symlink and its target untouched', () => {
    const root = tmp();
    writeFileSync(join(root, 'mine.json'), 'mine');
    symlinkSync('mine.json', join(root, 'link.json'));
    expect(writeIfAbsent(join(root, 'link.json'), 'ours')).toBe('exists');
    expect(lstatSync(join(root, 'link.json')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(root, 'mine.json'), 'utf8')).toBe('mine');
  });

  it('replaces a DANGLING leaf symlink with a real file', () => {
    const root = tmp();
    symlinkSync('missing-target', join(root, 'f.json'));
    expect(writeIfAbsent(join(root, 'f.json'), '{}')).toBe('created');
    expect(lstatSync(join(root, 'f.json')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(root, 'f.json'), 'utf8')).toBe('{}');
  });

  it('writes through a consumer-symlinked parent dir instead of replacing it', () => {
    const root = tmp();
    mkdirSync(join(root, 'shared-husky'));
    symlinkSync('shared-husky', join(root, '.husky'));
    expect(writeIfAbsent(join(root, '.husky', 'pre-commit'), 'hook')).toBe('created');
    expect(lstatSync(join(root, '.husky')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(root, 'shared-husky', 'pre-commit'), 'utf8')).toBe('hook');
  });

  it('replaces a DANGLING parent-dir symlink rather than crashing in mkdir', () => {
    const root = tmp();
    symlinkSync('missing-dir', join(root, 'eslint'));
    expect(writeIfAbsent(join(root, 'eslint', 'domains.mjs'), 'x')).toBe('created');
    expect(lstatSync(join(root, 'eslint')).isDirectory()).toBe(true);
  });

  it('rethrows a write failure other than EEXIST instead of reporting the file as kept', () => {
    expect(() => writeIfAbsent(join(tmp(), 'x'.repeat(300)), 'x')).toThrow(/ENAMETOOLONG/);
  });

  it('reports a directory at the path as existing, untouched', () => {
    const root = tmp();
    mkdirSync(join(root, 'taken', 'inner'), { recursive: true });
    expect(writeIfAbsent(join(root, 'taken'), 'x')).toBe('exists');
    expect(lstatSync(join(root, 'taken', 'inner')).isDirectory()).toBe(true);
  });
});
