// format-after-edit.sh must resolve the ESLint gate's scanRoots by PARSING guard.config.json — not
// by importing @norvalbv/devkit. Under the global-CLI consumption model the package is NOT in
// node_modules, so the old `import("@norvalbv/devkit/gate-engine/config")` resolver rejected →
// scan_roots empty → the structure/size early-warning silently never ran (sc-1041). These fixtures
// deliberately omit @norvalbv/devkit: the regression is that the gate now fires with no package
// present. Runs the REAL hook script in throwaway consumer dirs.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

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
function fixture(config) {
  const root = mkdtempSync(join(tmpdir(), 'fae-scanroots-'));
  dirs.push(root);
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
  const filePath = join(root, relFile);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, 'export const x = 1;\n');
  const r = spawnSync('bash', [HOOK], {
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
