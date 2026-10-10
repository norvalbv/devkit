/**
 * Runtime test for format-after-edit.sh's runtime-agnostic scanRoots resolution (sc-1043). This
 * PostToolUse hook resolves the consumer's eslint scanRoots via a JS runtime, then runs the local
 * eslint binary on in-scope edited files. sc-1043 made the resolver use bun-if-present-else-node so
 * a bun-only toolchain (no node) stops silently skipping the structure gate — the exact silent-skip
 * class the ticket fixes. Guards that the happy path fires (resolve → in-scope match → eslint runs)
 * and that scanRoot gating still excludes out-of-scope files. No existing suite exercises this hook.
 *
 * Under cli/ because vitest's include glob is ['gate-engine/**\/*.test.mjs','cli/**\/*.test.mjs'].
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { hasAnyCommand, rootRegistry } from './_helpers.mts';

const HOOK = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'agents-hooks',
  'format-after-edit.sh',
);
const HAS_BUN = hasAnyCommand('bun');

const { mkTmp, cleanup } = rootRegistry();
afterEach(cleanup);

// A stub eslint that announces itself (stderr) and exits `code`. The hook only forwards eslint's
// output when it FAILS, so a non-zero stub surfaces as exit 2 + the marker; a run that never happens
// leaves no marker. `components` (not `src`) as the scanRoot avoids collisions with random tmp path
// segments in the loose `*/scanRoot*` matcher.
const seedEslint = (root, code = 1) => {
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
  const bin = join(root, 'node_modules', '.bin', 'eslint');
  writeFileSync(bin, `#!/bin/sh\necho ESLINT_RAN >&2\nexit ${code}\n`);
  chmodSync(bin, 0o755);
};

const editFile = (root, rel, env = process.env) => {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, 'export const x = 1;\n');
  return spawnSync('bash', [HOOK], {
    input: JSON.stringify({ file_path: abs }),
    env: { ...env, CLAUDE_PROJECT_DIR: root },
    encoding: 'utf8',
  });
};

// A PATH holding only the hook's coreutils plus the named JS runtimes, so one runtime can be tested alone.
const HOOK_TOOLS = ['bash', 'cat', 'dirname', 'grep', 'head', 'sed', 'cksum', 'cut', 'mkdir'];
const isolatedPath = (root, runtimes) => {
  const bin = join(root, '.isolated-bin');
  mkdirSync(bin, { recursive: true });
  for (const tool of [...HOOK_TOOLS, ...runtimes]) {
    const found = spawnSync('bash', ['-c', 'command -v "$1"', '_', tool], { encoding: 'utf8' });
    symlinkSync(found.stdout.trim(), join(bin, tool));
  }
  return bin;
};

describe.skipIf(!HAS_BUN)('format-after-edit.sh runtime-agnostic scanRoots resolution', () => {
  it('resolves scanRoots and runs eslint on an in-scope file (blocks on violation)', () => {
    const root = mkTmp('fae-hook-');
    writeFileSync(join(root, 'guard.config.json'), JSON.stringify({ scanRoots: ['components'] }));
    seedEslint(root, 1);
    const r = editFile(root, 'components/widget.tsx');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('ESLINT_RAN');
    expect(r.stderr).toContain('ESLint violation');
  });

  it('skips eslint for an out-of-scope file (resolved scanRoots actually gate)', () => {
    const root = mkTmp('fae-hook-');
    writeFileSync(join(root, 'guard.config.json'), JSON.stringify({ scanRoots: ['components'] }));
    seedEslint(root, 1);
    const r = editFile(root, 'vendor/notes.tsx');
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('ESLINT_RAN');
  });

  it('degrade-skips when guard.config.json is absent (resolver yields no scanRoots)', () => {
    const root = mkTmp('fae-hook-');
    seedEslint(root, 1); // eslint present, but no guard.config.json → resolver exits 1 → skip
    const r = editFile(root, 'components/widget.tsx');
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('ESLINT_RAN');
  });
});

// The payload parse and the scanRoots resolver share one runtime pick; each runtime alone must drive both.
describe('format-after-edit.sh on a single JS runtime', () => {
  it.each(['bun', 'node'].filter((runtime) => hasAnyCommand(runtime)))(
    'parses the payload and resolves scanRoots with only %s on PATH',
    (runtime) => {
      const root = mkTmp('fae-hook-');
      writeFileSync(join(root, 'guard.config.json'), JSON.stringify({ scanRoots: ['components'] }));
      seedEslint(root, 1);
      const r = editFile(root, 'components/widget.tsx', {
        ...process.env,
        PATH: isolatedPath(root, [runtime]),
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('ESLINT_RAN');
    },
  );

  it('fails open with {} when neither bun nor node is on PATH', () => {
    const root = mkTmp('fae-hook-');
    writeFileSync(join(root, 'guard.config.json'), JSON.stringify({ scanRoots: ['components'] }));
    seedEslint(root, 1);
    const r = editFile(root, 'components/widget.tsx', {
      ...process.env,
      PATH: isolatedPath(root, []),
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('{}');
    expect(r.stderr).not.toContain('ESLINT_RAN');
  });
});
