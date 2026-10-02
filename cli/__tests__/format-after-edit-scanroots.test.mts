// format-after-edit.sh must resolve the ESLint gate's scanRoots by PARSING guard.config.json — not
// by importing @norvalbv/devkit. Under the global-CLI consumption model the package is NOT in
// node_modules, so the old `import("@norvalbv/devkit/gate-engine/config")` resolver rejected →
// scan_roots empty → the structure/size early-warning silently never ran (sc-1041). These fixtures
// deliberately omit @norvalbv/devkit: the regression is that the gate now fires with no package
// present. Runs the REAL hook script in throwaway consumer dirs.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { testSpawnSync } from './_helpers.mts';

const HOOK = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'agents-hooks',
  'format-after-edit.sh',
);

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// A fixture consumer repo: a stub LOCAL eslint that always "fails" (so any reached invocation
// surfaces as the hook's exit-2 path) and NO @norvalbv/devkit in node_modules — the exact
// global-CLI shape where the old package-import resolver silently died. `config === undefined`
// writes no guard.config.json at all.
function fixture(config, parent = '') {
  const base = mkdtempSync(join(tmpdir(), 'fae-scanroots-'));
  dirs.push(base);
  const root = join(base, parent);
  mkdirSync(root, { recursive: true });
  if (config !== undefined) writeFileSync(join(root, 'guard.config.json'), JSON.stringify(config));
  const bin = join(root, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  const eslint = join(bin, 'eslint');
  writeFileSync(eslint, '#!/bin/sh\necho "max-lines"\nexit 1\n');
  chmodSync(eslint, 0o755); // hook line 41 needs `-x`
  return root;
}

// Build file_path from the SAME mkdtemp string used for CLAUDE_PROJECT_DIR (avoids the macOS
// /var→/private/var symlink mismatch that would trip the hook's sibling-checkout guard), and
// explicitly override CLAUDE_PROJECT_DIR — an agent-launched test run inherits the devkit repo
// path, which would short-circuit the guard → exit 0 → false pass. Spread keeps PATH (bash/node).
function runHook(root, relFile) {
  const filePath = `${root}/${relFile}`; // not join(): keep `..`/`.`/`//` segments as sent
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, 'export const x = 1;\n');
  const r = testSpawnSync('bash', [HOOK], {
    cwd: root,
    input: JSON.stringify({ file_path: filePath }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
  return { code: r.status, err: r.stderr ?? '', out: r.stdout ?? '' };
}

describe('format-after-edit.sh — scanRoots resolved from guard.config.json (no package import)', () => {
  it('regression: file under a configured scanRoot → exit 2, surfaces the violation (no package present)', () => {
    const root = fixture({ scanRoots: ['app'] });
    const r = runHook(root, 'app/big.ts');
    expect(r.code).toBe(2);
    expect(r.err).toContain('ESLint violation');
  });

  it('file outside every scanRoot → exit 0, eslint never invoked', () => {
    const root = fixture({ scanRoots: ['app'] });
    const r = runHook(root, 'other/x.ts');
    expect(r.code).toBe(0);
    expect(r.err).not.toContain('ESLint violation');
  });

  it('absent guard.config.json → degrade-skip (exit 0, no crash)', () => {
    const root = fixture(undefined);
    const r = runHook(root, 'app/big.ts');
    expect(r.code).toBe(0);
    expect(r.err).not.toContain('ESLint violation');
  });

  it('config present but no scanRoots key → defaults to ["src"] (exit 2 for a src/ file)', () => {
    const root = fixture({});
    const r = runHook(root, 'src/big.ts');
    expect(r.code).toBe(2);
    expect(r.err).toContain('ESLint violation');
  });
});

describe('format-after-edit.sh — scanRoots match whole repo-relative segments (sc-1053)', () => {
  it.each([['src2/a.ts'], ['src-old/a.ts'], ['srcfoo.ts'], ['lib/vendor/src/x.ts']])(
    'scanRoot "src" does not cover %s → exit 0, eslint never invoked',
    (file) => {
      const r = runHook(fixture({ scanRoots: ['src'] }), file);
      expect(r.code).toBe(0);
      expect(r.err).not.toContain('ESLint violation');
    },
  );

  it('a project that itself lives under a src/ directory does not put every file in scope', () => {
    const root = fixture({ scanRoots: ['src'] }, 'src/proj');
    const r = runHook(root, 'other/x.ts');
    expect(r.code).toBe(0);
    expect(r.err).not.toContain('ESLint violation');
  });

  it('a project path containing spaces still matches its in-scope files', () => {
    const root = fixture({ scanRoots: ['src'] }, 'Application Support/proj');
    expect(runHook(root, 'src/a.ts').code).toBe(2);
    expect(runHook(root, 'src2/a.ts').code).toBe(0);
  });

  it.each([
    [['socket-server/src'], 'socket-server/src/a.ts'],
    [['src/'], 'src/a.ts'],
    [['./src'], 'src/a.ts'],
    [['.'], 'anything/a.ts'],
    [['src/index.ts'], 'src/index.ts'],
    [['app', 'src'], 'src/a.ts'],
  ])('scanRoots %j cover %s → exit 2', (scanRoots, file) => {
    const r = runHook(fixture({ scanRoots }), file);
    expect(r.code).toBe(2);
    expect(r.err).toContain('ESLint violation');
  });

  it('a nested root does not cover a sibling sharing its prefix (socket-server/src vs socket-server/src2)', () => {
    const r = runHook(fixture({ scanRoots: ['socket-server/src'] }), 'socket-server/src2/a.ts');
    expect(r.code).toBe(0);
  });

  it('an absolute scanRoot (accepted by gate-engine config) covers files under it', () => {
    const root = fixture({});
    writeFileSync(
      join(root, 'guard.config.json'),
      JSON.stringify({ scanRoots: [join(root, 'app')] }),
    );
    expect(runHook(root, 'app/a.ts').code).toBe(2);
    expect(runHook(root, 'app2/a.ts').code).toBe(0);
  });

  // A harness without CLAUDE_PROJECT_DIR: the hook cd's to HOOK_DIR/../.., so a copy under
  // <root>/.claude/hooks makes that the fixture, and file_path arrives repo-relative.
  function runRelativeWithoutProjectDir(root, cases) {
    const hook = join(root, '.claude', 'hooks', 'format-after-edit.sh');
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, readFileSync(HOOK, 'utf8'));
    const { CLAUDE_PROJECT_DIR: _omit, ...env } = process.env;
    for (const [file, expected] of cases) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), 'export const x = 1;\n');
      const input = JSON.stringify({ file_path: file });
      const r = testSpawnSync('bash', [hook], { cwd: root, input, encoding: 'utf8', env });
      expect([file, r.status]).toEqual([file, expected]);
    }
  }

  it('without CLAUDE_PROJECT_DIR, a relative file_path under a scanRoot is still gated', () => {
    runRelativeWithoutProjectDir(fixture({ scanRoots: ['src'] }), [
      ['src/a.ts', 2],
      ['./src/b.ts', 2],
      ['src2/a.ts', 0],
    ]);
  });

  it('without CLAUDE_PROJECT_DIR, a relative file_path is matched against an absolute scanRoot', () => {
    const root = fixture({});
    writeFileSync(
      join(root, 'guard.config.json'),
      JSON.stringify({ scanRoots: [join(root, 'src')] }),
    );
    runRelativeWithoutProjectDir(root, [
      ['src/a.ts', 2],
      ['src2/a.ts', 0],
    ]);
  });

  it.each([
    ['src/../other.ts', 0],
    ['src/../../other.ts', 0],
    ['./src/./a.ts', 2],
    ['src//a.ts', 2],
    ['other/../src/a.ts', 2],
  ])('dot and empty segments are resolved before matching: %s → exit %i', (file, code) => {
    const root = fixture({ scanRoots: ['src'] });
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'other'), { recursive: true });
    expect(runHook(root, file).code).toBe(code);
  });

  it('a scanRoot with dot segments is resolved too (src/../lib covers lib/, not src/)', () => {
    const root = fixture({ scanRoots: ['src/../lib'] });
    expect(runHook(root, 'lib/a.ts').code).toBe(2);
    expect(runHook(root, 'src/a.ts').code).toBe(0);
  });

  it('without CLAUDE_PROJECT_DIR, a relative path climbing out of a scanRoot is not in scope', () => {
    runRelativeWithoutProjectDir(fixture({ scanRoots: ['src'] }), [
      ['src/a.ts', 2],
      ['src/../other.ts', 0],
    ]);
  });

  it('without CLAUDE_PROJECT_DIR, leading `..` segments resolve lexically instead of truncating', () => {
    const root = fixture({ scanRoots: ['src', '../shared'] }, 'repo');
    runRelativeWithoutProjectDir(root, [
      ['../repo/src/a.ts', 2],
      ['../repo/src2/a.ts', 0],
      ['../shared/a.ts', 2],
      ['../shared2/a.ts', 0],
    ]);
  });
});
