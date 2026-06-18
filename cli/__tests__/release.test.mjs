import { describe, expect, it } from 'vitest';
import { bumpReadmePins, nextVersion } from '../commands/release.mjs';

describe('nextVersion', () => {
  it('bumps patch/minor/major', () => {
    expect(nextVersion('0.9.0', 'patch')).toBe('0.9.1');
    expect(nextVersion('0.9.0', 'minor')).toBe('0.10.0');
    expect(nextVersion('0.9.3', 'major')).toBe('1.0.0');
  });

  it('zeroes lower components on minor/major', () => {
    expect(nextVersion('1.4.7', 'minor')).toBe('1.5.0');
    expect(nextVersion('1.4.7', 'major')).toBe('2.0.0');
  });

  it('accepts an explicit x.y.z and returns it verbatim', () => {
    expect(nextVersion('0.9.0', '2.1.4')).toBe('2.1.4');
  });

  it('throws on a bad bump keyword', () => {
    expect(() => nextVersion('0.9.0', 'huge')).toThrow(/bad bump/);
  });

  it('throws when current is not x.y.z and bump is a keyword', () => {
    expect(() => nextVersion('0.9', 'patch')).toThrow(/not x\.y\.z/);
  });
});

describe('bumpReadmePins', () => {
  it('rewrites every devkit.git#vX.Y.Z install pin', () => {
    const md = [
      'bun add -D git+ssh://git@github.com/norvalbv/devkit.git#v0.8.1',
      'bun add -g git+ssh://git@github.com/norvalbv/devkit.git#v0.8.1   # once',
    ].join('\n');
    const out = bumpReadmePins(md, '0.9.0');
    expect(out).not.toContain('#v0.8.1');
    expect(out.match(/#v0\.9\.0/g)).toHaveLength(2);
  });

  it('leaves a README with no pins unchanged', () => {
    const md = '# devkit\n\nno install pins here.';
    expect(bumpReadmePins(md, '1.2.3')).toBe(md);
  });
});
