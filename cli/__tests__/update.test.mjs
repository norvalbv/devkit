import { describe, expect, it } from 'vitest';
import { cmpSemver, latestTag, repinPackageJson, repoUrl } from '../commands/update.mjs';

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

describe('repoUrl', () => {
  it('defaults to git+https — public repo, bun can clone it (its git+ssh clone is unreliable)', () => {
    expect(repoUrl({})).toBe('git+https://github.com/norvalbv/devkit.git');
  });

  it('honours a DEVKIT_REPO override (private fork / ssh host alias)', () => {
    const ssh = 'git+ssh://git@github-personal/norvalbv/devkit.git';
    expect(repoUrl({ DEVKIT_REPO: ssh })).toBe(ssh);
  });
});
