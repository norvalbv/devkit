import { describe, expect, it } from 'vitest';
import { matchedBy, normalizePath, parseNameStatusZ, rearmToken } from './drift.mts';

const ROOT = '/repo';

describe('normalizePath', () => {
  it('folds the spellings callers actually hand us to one repo-relative key', () => {
    expect(normalizePath(ROOT, 'cli/lib/ship')).toBe('cli/lib/ship');
    expect(normalizePath(ROOT, './cli/lib/ship')).toBe('cli/lib/ship');
    expect(normalizePath(ROOT, 'cli/lib/ship/')).toBe('cli/lib/ship');
    expect(normalizePath(ROOT, '/repo/cli/lib/ship')).toBe('cli/lib/ship');
  });

  it('keeps a filename whose own name has leading or trailing spaces', () => {
    // git allows these, so trimming would look for a different file and report no overlap for one
    // that really moved.
    expect(normalizePath(ROOT, ' spaced.mts')).toBe(' spaced.mts');
    expect(normalizePath(ROOT, 'dir/trailing .mts')).toBe('dir/trailing .mts');
    expect(normalizePath(ROOT, '   ')).toBeNull();
  });

  it('drops anything outside the checkout rather than matching it against moved files', () => {
    expect(normalizePath(ROOT, '..')).toBeNull();
    expect(normalizePath(ROOT, '../elsewhere')).toBeNull();
    expect(normalizePath(ROOT, '/etc/passwd')).toBeNull();
    expect(normalizePath(ROOT, '')).toBeNull();
  });
});

describe('matchedBy', () => {
  it('matches an exact path', () => {
    expect(matchedBy('a/b.mts', ['a/b.mts'])).toBe('a/b.mts');
  });

  it('matches a file under a directory the caller named', () => {
    // ship passes directories, so containment is required, not optional.
    expect(matchedBy('cli/lib/ship/x.mts', ['cli/lib/ship'])).toBe('cli/lib/ship');
  });

  it('does NOT let a directory prefix bleed into a sibling with the same stem', () => {
    // The `/` boundary is the whole reason this is not a bare startsWith.
    expect(matchedBy('cli/lib/shipwreck.mts', ['cli/lib/ship'])).toBeNull();
    expect(matchedBy('docs/decisions/x.md', ['docs/decision'])).toBeNull();
  });

  it('treats glob metacharacters as literal path characters', () => {
    // None of the three input sources is a glob source, and paths legally contain these.
    expect(matchedBy('src/a[0].mts', ['src/a[0].mts'])).toBe('src/a[0].mts');
    expect(matchedBy('src/anything.mts', ['src/*.mts'])).toBeNull();
  });

  it('returns null when the caller named nothing that covers this file', () => {
    expect(matchedBy('a/b.mts', ['c/d.mts'])).toBeNull();
  });
});

describe('parseNameStatusZ', () => {
  it('reads NUL-delimited status/path pairs', () => {
    expect(parseNameStatusZ('M\0a.mts\0A\0b.mts\0')).toEqual([
      { status: 'M', path: 'a.mts' },
      { status: 'A', path: 'b.mts' },
    ]);
  });

  it('preserves a path containing a newline, tab or quote', () => {
    // The reason for -z: --name-status would C-QUOTE these, and the mangled name is then fed back
    // into `git log -- <path>`, where it silently matches nothing.
    const raw = 'M\0weird\nname.mts\0M\0tab\tname.mts\0M\0"quoted".mts\0';
    expect(parseNameStatusZ(raw).map((entry) => entry.path)).toEqual([
      'weird\nname.mts',
      'tab\tname.mts',
      '"quoted".mts',
    ]);
  });

  it('is empty for empty input and drops a truncated final record', () => {
    expect(parseNameStatusZ('')).toEqual([]);
    expect(parseNameStatusZ('M\0a.mts\0D')).toEqual([{ status: 'M', path: 'a.mts' }]);
  });

  it('keeps an unfamiliar status letter rather than failing the parse', () => {
    expect(parseNameStatusZ('T\0link.mts\0')).toEqual([{ status: 'T', path: 'link.mts' }]);
  });
});

describe('rearmToken', () => {
  const token = (sha: string, path = 'a.mts') => rearmToken('/repo/.git', 'main', sha, path);

  it('is stable for the same inputs', () => {
    expect(token('sha1')).toBe(token('sha1'));
  });

  it('CHANGES when the base sha changes — this is what re-arms a second move', () => {
    // sc-2297's base moved twice. A token that ignored the sha would silence the second move.
    expect(token('sha1')).not.toBe(token('sha2'));
  });

  it('changes per path, so one briefed file does not silence another', () => {
    expect(token('sha1', 'a.mts')).not.toBe(token('sha1', 'b.mts'));
  });

  it('is filename-safe — consumers interpolate it into a marker name', () => {
    expect(token('sha1')).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('normalizePath — the repo root itself', () => {
  it('maps the root to the everything marker, not to null', () => {
    // `devkit base-status -- .` is an ordinary way to ask about the whole repo. Dropping it would
    // silently turn "everything" into "nothing named", which changes the answer.
    expect(normalizePath(ROOT, '.')).toBe('.');
    expect(normalizePath(ROOT, ROOT)).toBe('.');
    expect(normalizePath(ROOT, './')).toBe('.');
  });
});

describe('matchedBy — the everything marker', () => {
  it('matches every moved file', () => {
    expect(matchedBy('any/where.mts', ['.'])).toBe('.');
  });

  it('still matches when mixed with a narrower path', () => {
    expect(matchedBy('unrelated/file.mts', ['a/b.mts', '.'])).toBe('.');
  });
});
