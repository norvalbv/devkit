import { describe, expect, it } from 'vitest';
import { nameStatusRecords, renamesFrom } from '../git-index.mts';

const z = (...fields: string[]) => fields.map((field) => `${field}\0`).join('');

describe('nameStatusRecords', () => {
  it('reads two paths for R and C records and one for every other status', () => {
    expect(
      nameStatusRecords(
        z(
          'A',
          'a.ts',
          'R087',
          'old.ts',
          'new.ts',
          'M',
          'm.ts',
          'C100',
          'c.ts',
          'd.ts',
          'D',
          'x.ts',
        ),
      ),
    ).toEqual([
      { status: 'A', path: 'a.ts' },
      { status: 'R087', from: 'old.ts', path: 'new.ts' },
      { status: 'M', path: 'm.ts' },
      { status: 'C100', from: 'c.ts', path: 'd.ts' },
      { status: 'D', path: 'x.ts' },
    ]);
  });

  it.each([
    ['space', 'a b.ts'],
    ['brackets', 'app/[id]/page.tsx'],
    ['tab', 'a\tb.ts'],
    ['newline', 'a\nb.ts'],
  ])('returns a path with a %s verbatim', (_label, name) => {
    expect(nameStatusRecords(z('R100', name, `moved/${name}`, 'M', name))).toEqual([
      { status: 'R100', from: name, path: `moved/${name}` },
      { status: 'M', path: name },
    ]);
  });

  it('keeps field alignment when a path is spelled like a status letter', () => {
    expect(nameStatusRecords(z('R090', 'D', 'A', 'D', 'real.ts'))).toEqual([
      { status: 'R090', from: 'D', path: 'A' },
      { status: 'D', path: 'real.ts' },
    ]);
  });

  it('reads output with and without the trailing NUL, and empty output as no records', () => {
    expect(nameStatusRecords('M\0m.ts')).toEqual([{ status: 'M', path: 'm.ts' }]);
    expect(nameStatusRecords('')).toEqual([]);
  });
});

describe('renamesFrom', () => {
  it('maps each renamed destination to its source; only R100 is pure; copies are not renames', () => {
    const renames = renamesFrom(
      nameStatusRecords(
        z(
          'R100',
          'a.ts',
          'b [x].ts',
          'R087',
          'c.ts',
          'd\ne.ts',
          'C100',
          'f.ts',
          'g.ts',
          'M',
          'h.ts',
        ),
      ),
    );
    expect([...renames]).toEqual([
      ['b [x].ts', { from: 'a.ts', pure: true }],
      ['d\ne.ts', { from: 'c.ts', pure: false }],
    ]);
  });

  it('skips a truncated rename record', () => {
    expect(renamesFrom(nameStatusRecords('R100\0a.ts')).size).toBe(0);
  });
});
