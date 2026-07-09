import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import update, {
  cmpSemver,
  installedVersion,
  latestTag,
  needsRerun,
  repinPackageJson,
  repoUrl,
} from '../commands/update.mts';

// Stub the two subprocesses `update` shells out to: `git ls-remote` (report a tag far ahead of any
// real version) and `bun` (pm cache rm / install — no-op, but recorded so we can assert the install).
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn((cmd: string, args: string[]) =>
    cmd === 'git' && args?.[0] === 'ls-remote' ? 'abc123\trefs/tags/v9.9.9\n' : '',
  ),
}));

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

describe('installedVersion', () => {
  it('package mode measures the repo (node_modules dep), NOT the running CLI', () => {
    // The regression: a global CLI at 0.31.2 must still see a repo pinned at 0.29.0 as behind.
    expect(installedVersion({ mode: 'package', repoDep: '0.29.0', running: '0.31.2' })).toBe(
      '0.29.0',
    );
  });

  it('package mode falls back to the pinned tag when node_modules is absent, then the running CLI', () => {
    expect(installedVersion({ mode: 'package', pinned: '0.29.0', running: '0.31.2' })).toBe(
      '0.29.0',
    );
    expect(installedVersion({ mode: 'package', running: '0.31.2' })).toBe('0.31.2');
  });

  it('global mode always measures the running CLI', () => {
    expect(installedVersion({ mode: 'global', repoDep: '0.29.0', running: '0.31.2' })).toBe(
      '0.31.2',
    );
  });
});

describe('needsRerun', () => {
  it('re-runs only when the running CLI is itself behind the just-installed tag', () => {
    expect(needsRerun('0.31.2', '0.29.0')).toBe(true); // running behind → can't hot-swap
    expect(needsRerun('0.31.2', '0.31.2')).toBe(false); // running already current → reconcile in-pass
    expect(needsRerun('0.31.2', '0.40.0')).toBe(false); // running ahead → in-pass
  });

  it('treats an unknown running version conservatively as needing a re-run', () => {
    expect(needsRerun('0.31.2', undefined)).toBe(true);
  });
});

// Command-level wiring locks: a future edit that reverts `current` to the running CLI's own version
// (the original bug) must turn these red — the pure-helper tests above wouldn't catch it. `git
// ls-remote` is stubbed (mock at top) to report v9.9.9, far ahead of any real version.
describe('update — command-level (mode detection, comparison basis, install branch)', () => {
  const made: string[] = [];
  const REF = 'git+https://github.com/norvalbv/devkit.git';

  // A throwaway consumer repo. `dep`: the devkit devDependency ref (null ⇒ package.json WITHOUT the
  // dep = global mode; undefined ⇒ no package.json at all). `nm`: version written to
  // node_modules/@norvalbv/devkit (undefined ⇒ not installed).
  const makeRepo = (o: { dep?: string | null; nm?: string }): string => {
    const dir = mkdtempSync(join(tmpdir(), 'devkit-update-'));
    made.push(dir);
    if (o.dep !== undefined) {
      const pkg =
        o.dep === null
          ? { name: 'c' }
          : { name: 'c', devDependencies: { '@norvalbv/devkit': o.dep } };
      writeFileSync(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
    }
    if (o.nm !== undefined) {
      mkdirSync(join(dir, 'node_modules', '@norvalbv', 'devkit'), { recursive: true });
      writeFileSync(
        join(dir, 'node_modules', '@norvalbv', 'devkit', 'package.json'),
        JSON.stringify({ version: o.nm }),
      );
    }
    return dir;
  };

  // Track console spies so afterEach restores ONLY them — never vi.restoreAllMocks(), which would
  // also reset the execFileSync module-mock's implementation and break the following tests.
  const spies: Array<{ mockRestore: () => void }> = [];
  const spy = (m: 'log' | 'error') => {
    const s = vi.spyOn(console, m).mockImplementation(() => {});
    spies.push(s);
    return s;
  };
  const silence = () => spy('log');
  const bunCalls = () => vi.mocked(execFileSync).mock.calls.filter((c) => c[0] === 'bun');
  const ranInstall = () =>
    bunCalls().some((c) => (c[1] as string[] | undefined)?.[0] === 'install');

  beforeEach(() => vi.mocked(execFileSync).mockClear());
  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('package mode, node_modules behind latest → re-pins package.json + runs `bun install`', async () => {
    const dir = makeRepo({ dep: `${REF}#v0.29.0`, nm: '0.29.0' });
    const log = silence();
    expect(await update([], dir)).toBe(0);
    expect(log.mock.calls.flat().join('\n')).not.toMatch(/up to date/); // the bug was a bare short-circuit
    const pkg = readFileSync(join(dir, 'package.json'), 'utf8');
    expect(pkg).toContain('#v9.9.9');
    expect(pkg).not.toContain('#v0.29.0');
    expect(vi.mocked(execFileSync)).toHaveBeenCalledWith('bun', ['install'], {
      cwd: dir,
      stdio: 'inherit',
    });
  });

  it('package mode, node_modules already at latest → "up to date", no install (not re-inverted)', async () => {
    const dir = makeRepo({ dep: `${REF}#v9.9.9`, nm: '9.9.9' });
    const log = silence();
    expect(await update([], dir)).toBe(0);
    expect(log.mock.calls.flat().join('\n')).toMatch(/up to date \(v9\.9\.9\)/);
    expect(bunCalls()).toHaveLength(0); // returns before even `bun pm cache rm`
  });

  it('package mode, node_modules absent → falls back to the pinned #v tag, still installs', async () => {
    const dir = makeRepo({ dep: `${REF}#v0.29.0` }); // no node_modules
    silence();
    expect(await update([], dir)).toBe(0);
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toContain('#v9.9.9');
    expect(ranInstall()).toBe(true);
  });

  it('package mode, non-#v ref (e.g. #main) with nothing to re-pin → fails loud (exit 1), no install', async () => {
    const dir = makeRepo({ dep: `${REF}#main` }); // repoDep + pinned both null ⇒ current = running CLI (< 9.9.9)
    silence();
    const err = spy('error');
    expect(await update([], dir)).toBe(1);
    expect(err.mock.calls.flat().join('\n')).toMatch(
      /could not find a "@norvalbv\/devkit" git ref/,
    );
    expect(ranInstall()).toBe(false);
  });

  it('global mode (no devkit dep) → `bun add -g` the tag, never re-pins or `bun install`s', async () => {
    const dir = makeRepo({ dep: null }); // package.json without the dep
    silence();
    expect(await update([], dir)).toBe(0);
    expect(vi.mocked(execFileSync)).toHaveBeenCalledWith('bun', ['add', '-g', `${REF}#v9.9.9`], {
      cwd: dir,
      stdio: 'inherit',
    });
    expect(ranInstall()).toBe(false);
  });
});
