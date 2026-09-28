import { describe, expect, it } from 'vitest';
import { resolveSpec, specifierFor } from './specifiers.mts';

const alias = { prefix: '@/', root: '/repo/src/renderer' };

describe('specifierFor', () => {
  it('keeps alias form when importer and target both sit under the alias root', () => {
    expect(
      specifierFor('/repo/src/renderer/lib/x', '/repo/src/renderer/features/a.ts', alias),
    ).toBe('@/lib/x');
    expect(specifierFor('/repo/src/renderer/lib/index', '/repo/src/renderer/a.ts', alias)).toBe(
      '@/lib/index',
    );
  });

  it('emits a relative specifier when the target is outside the alias root', () => {
    expect(specifierFor('/repo/src/main/lib/c/x', '/repo/src/main/lib/b/i.ts', alias)).toBe(
      '../c/x',
    );
    expect(specifierFor('/repo/src/main/lib/b/x', '/repo/src/main/lib/b/i.ts', alias)).toBe('./x');
    expect(specifierFor('/repo/src/main/x', '/repo/src/renderer/features/r.ts', alias)).toBe(
      '../../main/x',
    );
  });

  it('emits a relative specifier when only the importer is outside the alias root', () => {
    expect(specifierFor('/repo/src/renderer/lib/r', '/repo/src/main/u.ts', alias)).toBe(
      '../renderer/lib/r',
    );
  });

  it('treats a sibling directory sharing the root name prefix as outside the root', () => {
    expect(
      specifierFor('/repo/src/renderer-legacy/old', '/repo/src/renderer-legacy/use.ts', alias),
    ).toBe('./old');
  });

  it('keeps an explicit /index segment in both forms — `foo` could resolve to a sibling foo.*', () => {
    expect(specifierFor('/repo/src/main/sub/index', '/repo/src/main/u.ts', alias)).toBe(
      './sub/index',
    );
    expect(specifierFor('/repo/src/main/sub/index', '/repo/src/main/sub/deeper/l.ts', alias)).toBe(
      '../index',
    );
    expect(specifierFor('/repo/src/main/index', '/repo/src/main/a/b/l.ts', alias)).toBe(
      '../../index',
    );
    expect(
      specifierFor('C:/repo/src/renderer/lib/index', 'C:/repo/src/renderer/a.ts', {
        prefix: '@/',
        root: 'C:/repo/src/renderer',
      }),
    ).toBe('@/lib/index');
  });

  it('never produces an alias that climbs out of its root', () => {
    for (const [mod, from] of [
      ['/repo/src/shared/y', '/repo/src/main/x.ts'],
      ['/repo/src/shared/y', '/repo/src/renderer/x.ts'],
      ['/repo/src/renderer/y', '/repo/src/shared/x.ts'],
    ])
      expect(specifierFor(mod, from, alias)).not.toContain('@/..');
  });
});

describe('resolveSpec', () => {
  it('resolves alias and relative specifiers to extensionless absolute paths; skips bare ones', () => {
    expect(resolveSpec('@/lib/x.ts', '/repo/src/main', alias)).toBe('/repo/src/renderer/lib/x');
    expect(resolveSpec('../shared/y', '/repo/src/main', alias)).toBe('/repo/src/shared/y');
    expect(resolveSpec('./z', '/repo/src/main', alias)).toBe('/repo/src/main/z');
    expect(resolveSpec('vitest', '/repo/src/main', alias)).toBeNull();
  });
});
