import { describe, expect, it } from 'vitest';
import {
  cmpSemver,
  globalUpdateCommands,
  latestTag,
  repinPackageJson,
} from '../commands/update.mjs';

describe('cmpSemver', () => {
  it('orders numerically, not lexically', () => {
    expect(cmpSemver('0.9.0', '0.10.0')).toBeLessThan(0); // 9 < 10 despite lex order
    expect(cmpSemver('1.0.0', '0.9.9')).toBeGreaterThan(0);
    expect(cmpSemver('0.9.1', '0.9.1')).toBe(0);
  });
});

describe('latestTag', () => {
  it('picks the highest vX.Y.Z from ls-remote output', () => {
    const out = [
      'abc123\trefs/tags/v0.8.1',
      'def456\trefs/tags/v0.10.0',
      'aaa111\trefs/tags/v0.9.1',
      'bbb222\trefs/tags/v0.9.1^{}', // peeled annotated tag — same version, ignored as a dup
    ].join('\n');
    expect(latestTag(out)).toBe('0.10.0');
  });

  it('returns null when there are no version tags', () => {
    expect(latestTag('abc\trefs/heads/main\n')).toBeNull();
  });
});

describe('repinPackageJson', () => {
  it('rewrites the devkit dep git tag in place', () => {
    const raw = JSON.stringify(
      {
        devDependencies: {
          '@norvalbv/devkit': 'git+ssh://git@github.com/norvalbv/devkit.git#v0.8.1',
        },
      },
      null,
      2,
    );
    const out = repinPackageJson(raw, '0.10.0');
    expect(out).toContain('#v0.10.0');
    expect(out).not.toContain('#v0.8.1');
  });

  it('leaves a package.json without the devkit dep unchanged', () => {
    const raw = '{\n  "dependencies": { "react": "^19.0.0" }\n}';
    expect(repinPackageJson(raw, '0.10.0')).toBe(raw);
  });
});

describe('globalUpdateCommands', () => {
  it('removes the old global pin BEFORE adding the new tag (else bun DependencyLoops)', () => {
    const [removeOld, addNew] = globalUpdateCommands('0.26.1');
    expect(removeOld).toEqual(['bun', ['remove', '-g', '@norvalbv/devkit']]);
    expect(addNew[1]).toContain('add');
    expect(addNew[1]).toContain('-g');
    expect(addNew[1].at(-1)).toMatch(/#v0\.26\.1$/);
  });
});
