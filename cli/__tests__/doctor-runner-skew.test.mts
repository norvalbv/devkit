/**
 * sc-2100. `.devkit/oxc/*` is version-coupled — the RUNNING devkit is both writer and reader of the
 * managed base digest — so a devkit older than the repo's pin rewrites that state in its own older
 * shape, which the pinned gate then reports as stale, while the drift message re-prescribes the
 * command that caused it. These tests pin the two guarantees: an older runner never writes managed
 * state, and it hands off to the repo's own binary rather than naming a remedy it cannot perform.
 *
 * Running version comes from `packageDir()/package.json`, i.e. THIS package — so a fixture creates
 * skew by writing a node_modules devkit at a version above/below it, the same way
 * upgrade-version-step.test.mts fakes a differently-versioned devkit.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ALLOW_SKEW_ENV,
  assertRunnerMayWrite,
  DELEGATED_ENV,
  delegateToPinned,
  runnerSkew,
  skewCheck,
} from '../lib/doctor/pin/runner-identity.mts';
import { packageDir, readJson } from '../lib/fs-helpers.mts';
import { rootRegistry } from './_helpers.mts';

/** A stand-in for execFileSync: records the call, then behaves as the child would have. */
function fakeExec(onCall: (bin: string, args: string[], opts: ExecOpts) => void, exitCode = 0) {
  return (bin: string, args: string[], opts: ExecOpts): string => {
    onCall(bin, args, opts);
    if (exitCode !== 0)
      throw Object.assign(new Error(`child exited ${exitCode}`), {
        status: exitCode,
      });
    return '';
  };
}
interface ExecOpts {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

const RUNNING = readJson<{ version: string }>(join(packageDir(), 'package.json'))?.version ?? '';
// Move the MAJOR up and the MINOR down so both stay valid semver for any real running version.
const parts = RUNNING.split('.').map(Number);
const NEWER = `${parts[0] + 1}.${parts[1]}.${parts[2]}`;
const OLDER = `${parts[0]}.${Math.max(parts[1] - 1, 0)}.${parts[2]}`;

const { mkTmp, cleanup } = rootRegistry();

/** A consumer repo pinning `pin`, optionally with an installed devkit + bin to hand off to. */
function repo(pin: string, { installed = true, bin = installed, at = '' } = {}): string {
  const root = mkTmp('skew-');
  const dir = at ? join(root, at) : root;
  mkdirSync(join(dir, '.devkit'), { recursive: true });
  writeFileSync(join(dir, '.devkit', 'config.json'), JSON.stringify({ stack: 'generic' }));
  // `at` puts the declaration/install at the git root while doctor runs from a package subdir.
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ devDependencies: { '@norvalbv/devkit': `git+https://x/y.git#v${pin}` } }),
  );
  if (installed) {
    const nm = join(root, 'node_modules', '@norvalbv', 'devkit');
    mkdirSync(nm, { recursive: true });
    writeFileSync(
      join(nm, 'package.json'),
      JSON.stringify({ version: pin, bin: { devkit: './dist/cli/index.mjs' } }),
    );
    if (bin) {
      // The spawnable entrypoint. The .bin shim below is display-only — delegation never runs it.
      mkdirSync(join(nm, 'dist', 'cli'), { recursive: true });
      writeFileSync(join(nm, 'dist', 'cli', 'index.mjs'), 'process.exit(0);\n');
    }
  }
  if (bin) {
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    const p = join(root, 'node_modules', '.bin', 'devkit');
    writeFileSync(p, '#!/bin/sh\n');
    chmodSync(p, 0o755);
  }
  return dir;
}

afterEach(cleanup);

describe('runnerSkew', () => {
  it('older: names both versions and resolves a hand-off target', () => {
    const s = runnerSkew(repo(NEWER));
    expect(s.kind).toBe('older');
    expect(s.running).toBe(RUNNING);
    expect(s.pinned).toBe(NEWER);
    // Spawned: the package's own JS entry. Printed: the .bin path a human would type.
    expect(s.pinnedEntry).toMatch(/@norvalbv\/devkit\/dist\/cli\/index\.mjs$/);
    expect(s.pinnedBin).toMatch(/node_modules\/\.bin\/devkit$/);
  });

  it('newer never refuses — moving forward is `devkit update`, not a skew fault', () => {
    expect(runnerSkew(repo(OLDER)).kind).toBe('newer');
  });

  it('equal pin is none', () => {
    expect(runnerSkew(repo(RUNNING)).kind).toBe('none');
  });

  it('self-host is always none: the source tree IS the binary, whatever devkitRef says', () => {
    const root = repo(NEWER);
    expect(runnerSkew(root, { selfHost: true, devkitRef: `v${NEWER}` }).kind).toBe('none');
  });

  it('resolves a hoisted monorepo pin from the git root, not `unknown`', () => {
    // devkit declared+installed at the root; doctor runs from the package dir.
    expect(runnerSkew(repo(NEWER, { at: 'packages/app' })).kind).toBe('older');
  });

  it('falls back to the declared #v pin when nothing is installed', () => {
    const s = runnerSkew(repo(NEWER, { installed: false, bin: false }));
    expect(s.kind).toBe('older');
    expect(s.pinned).toBe(NEWER);
  });

  it('an unresolvable pin is `unknown`, which proceeds rather than refusing', () => {
    const root = mkTmp('skew-none-');
    expect(runnerSkew(root, {}).kind).toBe('unknown');
    expect(() => assertRunnerMayWrite(root)).not.toThrow();
  });

  it('overlay reads its pin from config.json devkitRef', () => {
    const s = runnerSkew(mkTmp('skew-ov-'), { overlay: true, devkitRef: `v${NEWER}` });
    expect(s.kind).toBe('older');
    expect(s.pinned).toBe(NEWER);
  });
});

describe('remediation strings', () => {
  // `devkit` is an unrelated public npm package and bunx falls through to the registry exactly when
  // the local install is missing — devkit must never tell a repo it does not own to run that.
  const BUNX = /\b(bunx|npx)\s+devkit\b/;

  it('never emits a bare `bunx devkit`, with or without a local install', () => {
    for (const root of [repo(NEWER), repo(NEWER, { installed: false, bin: false })]) {
      expect(runnerSkew(root).remediation).not.toMatch(BUNX);
    }
    const overlay = runnerSkew(mkTmp('skew-ov2-'), { overlay: true, devkitRef: `v${NEWER}` });
    expect(overlay.remediation).not.toMatch(BUNX);
    expect(overlay.remediation).toContain('@norvalbv/devkit');
  });

  it('names the resolved binary by absolute path when one exists', () => {
    const s = runnerSkew(repo(NEWER));
    expect(s.pinnedBin).toBeDefined(); // guards the ?? '' below from passing vacuously
    expect(s.remediation).toContain(s.pinnedBin ?? '');
    expect(skewCheck(s)?.remediation).toBe(s.remediation);
  });

  it('skewCheck reports a row only for `older`', () => {
    expect(skewCheck(runnerSkew(repo(OLDER)))).toBeNull();
    expect(skewCheck(runnerSkew(repo(NEWER)))?.status).toBe('DRIFT');
  });
});

describe('assertRunnerMayWrite', () => {
  it('throws for an older runner, naming both versions and a runnable remedy', () => {
    const root = repo(NEWER);
    expect(() => assertRunnerMayWrite(root)).toThrow(
      new RegExp(`running devkit ${RUNNING}.*pins ${NEWER}`),
    );
  });

  it('permits newer, equal and self-host writers', () => {
    expect(() => assertRunnerMayWrite(repo(OLDER))).not.toThrow();
    expect(() => assertRunnerMayWrite(repo(RUNNING))).not.toThrow();
  });

  it('the opt-out writes, but announces itself (visible + detectable)', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const skew = assertRunnerMayWrite(repo(NEWER), false, {
      ...process.env,
      [ALLOW_SKEW_ENV]: '1',
    });
    expect(skew.kind).toBe('older');
    expect(log.mock.calls.flat().join('\n')).toContain(ALLOW_SKEW_ENV);
    log.mockRestore();
  });
});

describe('delegateToPinned', () => {
  it('re-execs the pinned entrypoint under this node and returns its exit code', () => {
    const skew = runnerSkew(repo(NEWER));
    const calls: Array<[string, string[], ExecOpts]> = [];
    const code = delegateToPinned(
      skew,
      ['doctor', '--fix'],
      '/cwd',
      {},
      fakeExec((bin, args, opts) => calls.push([bin, args, opts])),
    );
    expect(code).toBe(0);
    const [bin, args, opts] = calls[0];
    // process.execPath, never a shell: a .cmd hand-off would put user argv through a shell.
    expect(bin).toBe(process.execPath);
    expect(args).toEqual([skew.pinnedEntry, 'doctor', '--fix']);
    expect(opts.env?.[DELEGATED_ENV]).toBe('1'); // recursion marker
  });

  it("surfaces the child's failing exit code", () => {
    const skew = runnerSkew(repo(NEWER));
    const exec = fakeExec(() => {}, 3);
    expect(delegateToPinned(skew, ['doctor'], '/cwd', {}, exec)).toBe(3);
  });

  it('a delegated child does not hand off again — no fork loop', () => {
    const skew = runnerSkew(repo(NEWER));
    let called = false;
    const exec = fakeExec(() => {
      called = true;
    });
    const env = { [DELEGATED_ENV]: '1' };
    expect(delegateToPinned(skew, ['doctor'], '/cwd', env, exec)).toBeNull();
    expect(called).toBe(false);
  });

  it('returns null when there is no pinned binary, so the caller can refuse instead', () => {
    const skew = runnerSkew(repo(NEWER, { installed: false, bin: false }));
    expect(
      delegateToPinned(
        skew,
        ['doctor'],
        '/cwd',
        {},
        fakeExec(() => {}),
      ),
    ).toBeNull();
  });
});

describe('managed writes under skew', () => {
  it('leaves .devkit/oxc bytes byte-identical when an older runner is refused', async () => {
    const { syncOxcCapability } = await import('../lib/install/oxc/lifecycle.mts');
    const root = repo(NEWER);
    mkdirSync(join(root, '.devkit', 'oxc'), { recursive: true });
    const base = join(root, '.devkit', 'oxc', 'oxlint.base.json');
    writeFileSync(base, '{"sentinel":true}\n');
    const before = readFileSync(base);
    expect(() => syncOxcCapability(root, { antiSlop: false })).toThrow(/refusing to write/);
    expect(readFileSync(base).equals(before)).toBe(true);
  });
});

describe('malformed and unparseable inputs', () => {
  // `devkitDepRef` reads package.json through readJson, which THROWS on bad JSON. Before the guard
  // was total, a half-written package.json would crash every managed write instead of degrading.
  it('a malformed package.json degrades to `unknown` and never blocks a write', () => {
    const root = repo(NEWER, { installed: false, bin: false });
    writeFileSync(join(root, 'package.json'), '{ "devDependencies": ');
    expect(runnerSkew(root).kind).toBe('unknown');
    expect(() => assertRunnerMayWrite(root)).not.toThrow();
  });

  it('a hand-edited .devkit/config.json does not crash the guard', () => {
    const root = repo(NEWER);
    writeFileSync(join(root, '.devkit', 'config.json'), '{ overlay: tru');
    // The config is unreadable, so mode is unknown — but the package pin still resolves.
    expect(() => runnerSkew(root)).not.toThrow();
  });

  it('an installed devkit manifest with no version falls back to the declared pin', () => {
    const root = repo(NEWER);
    writeFileSync(
      join(root, 'node_modules', '@norvalbv', 'devkit', 'package.json'),
      JSON.stringify({ name: '@norvalbv/devkit' }),
    );
    expect(runnerSkew(root).pinned).toBe(NEWER); // from package.json's #v tag
  });
});

describe('real-world version shapes', () => {
  // init.mts writes devkitRef 'main' when no devkit package resolves — a genuine overlay config.
  it("a branch devkitRef (init's own default) is `unknown`, not a refusal", () => {
    const s = runnerSkew(mkTmp('skew-main-'), { overlay: true, devkitRef: 'main' });
    expect(s.kind).toBe('unknown');
  });

  // An unorderable ref must fall through to `unknown`, which proceeds. Ordering it would be a FALSE
  // REFUSAL: `#v1.2.3-feature` is an ordinary branch name, and reading it as the release 1.2.3
  // would block a legitimate 1.2.2 runner for a skew that does not exist.
  it.each([
    ['a branch that looks like a tag', 'git+https://x/y.git#v1.2.3-feature'],
    ['a prerelease tag', 'git+https://x/y.git#v1.2.3-rc.1'],
    ['a bare branch', 'git+https://x/y.git#main'],
  ])('treats %s as unorderable rather than refusing', (_label, ref) => {
    const root = repo('9.9.9', { installed: false, bin: false });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ devDependencies: { '@norvalbv/devkit': ref } }),
    );
    expect(runnerSkew(root).kind).toBe('unknown');
    expect(() => assertRunnerMayWrite(root)).not.toThrow();
  });

  it('treats a prerelease overlay devkitRef as unordered, which proceeds rather than refuses', () => {
    const root = mkTmp('skew-pre-');
    expect(runnerSkew(root, { overlay: true, devkitRef: 'v1.2.3-rc.1' }).kind).toBe('unknown');
    expect(() => assertRunnerMayWrite(root)).not.toThrow();
  });

  // A lexicographic compare would call 0.100.0 LOWER than 0.57.0 and 0.6.0 HIGHER — inverting both
  // verdicts and letting an older devkit write. cmpSemver is numeric per component; pin that.
  it('orders version components numerically, not as strings', () => {
    const [major, , patch] = RUNNING.split('.');
    expect(runnerSkew(repo(`${major}.100.${patch}`)).kind).toBe('older');
    expect(runnerSkew(repo(`${major}.6.${patch}`)).kind).toBe('newer');
  });

  // A stale node_modules must NOT mask a package.json that already asks for a newer devkit: a
  // runner matching the stale install would otherwise be judged in sync and publish state the
  // declared pin rejects. The requirement is the HIGHER of the two.
  it('takes the higher of the declared and installed pins', () => {
    const root = repo(NEWER); // declares #vNEWER
    writeFileSync(
      join(root, 'node_modules', '@norvalbv', 'devkit', 'package.json'),
      JSON.stringify({ version: RUNNING }), // ...but a stale install at the running version
    );
    const s = runnerSkew(root);
    expect(s.kind).toBe('older');
    expect(s.pinned).toBe(NEWER);
    // Handing off to the stale install would re-run the same code, so no bin is offered.
    expect(s.pinnedBin).toBeUndefined();
    expect(s.remediation).toContain('bun install');
  });
});

describe('opt-out and delegation markers are separate powers', () => {
  // The delegation marker rides in the child's env and is inherited by everything it spawns. If it
  // ALSO disabled the write guard, any skewed devkit reached from a delegated run would resume
  // writing older-shaped state — reinstating sc-2100 through the back door.
  it('DEVKIT_SKEW_DELEGATED suppresses hand-off but never the write guard', () => {
    const root = repo(NEWER);
    expect(() => assertRunnerMayWrite(root, false, { [DELEGATED_ENV]: '1' })).toThrow(
      /refusing to write/,
    );
  });

  it('only ALLOW_SKEW_ENV opens the write', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const env = { [DELEGATED_ENV]: '1', [ALLOW_SKEW_ENV]: '1' };
    expect(() => assertRunnerMayWrite(repo(NEWER), false, env)).not.toThrow();
    log.mockRestore();
  });
});

describe('resolution does not strand a usable hand-off', () => {
  // A package-local manifest with no runnable bin must not mask a COMPLETE install at the git root:
  // returning the partial one refuses a monorepo --fix while a valid hand-off target sits up-tree.
  it('prefers the root that has both a version and a spawnable entrypoint', () => {
    const root = mkTmp('skew-partial-');
    const pkg = join(root, 'packages', 'app');
    mkdirSync(join(pkg, '.devkit'), { recursive: true });
    writeFileSync(join(pkg, '.devkit', 'config.json'), JSON.stringify({ stack: 'generic' }));
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ devDependencies: { '@norvalbv/devkit': `git+https://x/y.git#v${NEWER}` } }),
    );
    // Partial install in the package dir: manifest present, no bin.
    const pkgNm = join(pkg, 'node_modules', '@norvalbv', 'devkit');
    mkdirSync(pkgNm, { recursive: true });
    writeFileSync(join(pkgNm, 'package.json'), JSON.stringify({ version: NEWER }));
    // Complete install at the git root: manifest AND a spawnable entrypoint.
    const rootNm = join(root, 'node_modules', '@norvalbv', 'devkit');
    mkdirSync(join(rootNm, 'dist', 'cli'), { recursive: true });
    writeFileSync(
      join(rootNm, 'package.json'),
      JSON.stringify({ version: NEWER, bin: { devkit: './dist/cli/index.mjs' } }),
    );
    const entry = join(rootNm, 'dist', 'cli', 'index.mjs');
    writeFileSync(entry, 'process.exit(0);\n');

    const s = runnerSkew(pkg);
    expect(s.kind).toBe('older');
    expect(s.pinnedEntry).toBe(entry); // hand-off available, not a refusal
  });
});

describe('overlay devkitRef requires the v prefix', () => {
  // init writes `v${version}`. Without requiring the `v`, a branch literally named 1.2.3 would read
  // as a release and refuse a runner over a skew that does not exist — the package-mode rule too.
  it.each([
    ['a bare numeric branch', '1.2.3'],
    ['a named branch', 'main'],
    ['a sha', 'a1b2c3d4'],
  ])('treats %s as unorderable', (_label, ref) => {
    const root = mkTmp('skew-ovref-');
    expect(runnerSkew(root, { overlay: true, devkitRef: ref }).kind).toBe('unknown');
    expect(() => assertRunnerMayWrite(root)).not.toThrow();
  });

  it('still reads a proper v-prefixed tag as the pin', () => {
    const s = runnerSkew(mkTmp('skew-ovok-'), { overlay: true, devkitRef: `v${NEWER}` });
    expect(s.kind).toBe('older');
    expect(s.pinned).toBe(NEWER);
  });
});
