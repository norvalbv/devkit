import {
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
