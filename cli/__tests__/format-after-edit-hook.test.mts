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
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { hasAnyCommand, rootRegistry, seedSessionLedger } from './_helpers.mts';
import { mainWithWorktree } from './_worktree-fixture.mts';

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

const editFile = (root, rel, { projectDir = root, cwd = undefined, env = process.env } = {}) => {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, 'export const x = 1;\n');
  return spawnSync('bash', [HOOK], {
    input: JSON.stringify({ file_path: abs, cwd }),
    env: { ...env, CLAUDE_PROJECT_DIR: projectDir },
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

  it("lints a worktree file with the worktree's own config when cwd is a linked worktree", () => {
    // Project-config-root sessions: CLAUDE_PROJECT_DIR is the main checkout, cwd the worktree.
    const { main, worktree } = mainWithWorktree(mkTmp);
    writeFileSync(
      join(worktree, 'guard.config.json'),
      JSON.stringify({ scanRoots: ['components'] }),
    );
    seedEslint(worktree, 1);
    const outside = editFile(worktree, 'components/widget.tsx', { projectDir: main });
    expect(outside.status).toBe(0);
    expect(outside.stderr).not.toContain('ESLINT_RAN');

    const r = editFile(worktree, 'components/widget.tsx', { projectDir: main, cwd: worktree });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('ESLINT_RAN');
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
        env: { ...process.env, PATH: isolatedPath(root, [runtime]) },
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
      env: { ...process.env, PATH: isolatedPath(root, []) },
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('{}');
    expect(r.stderr).not.toContain('ESLINT_RAN');
  });
});

// Overlay repos that format with their own Oxfmt: the agent hooks mirror the overlay commit chain.
const LINT_HOOK = join(dirname(HOOK), 'lint-check.sh');
const OXFMT_CALLS = 'oxfmt-calls.txt';

// A stub oxfmt that logs its argv, prints to stdout (which must not reach the hook's JSON) and exits
// $OXFMT_RC; a checkout whose `.devkit/config.json` holds `config`.
const overlayRepo = (root, config: string | null = '{"overlay":true}') => {
  if (config !== null) {
    mkdirSync(join(root, '.devkit'), { recursive: true });
    writeFileSync(join(root, '.devkit', 'config.json'), config);
  }
  writeFileSync(join(root, '.oxfmtrc.json'), '{}\n');
  writeFileSync(join(root, 'package.json'), '{"name":"fx"}\n');
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
  const bin = join(root, 'node_modules', '.bin', 'oxfmt');
  writeFileSync(
    bin,
    `#!/bin/sh\necho "$@" >> ${OXFMT_CALLS}\necho STUB_OUT\nexit \${OXFMT_RC:-0}\n`,
  );
  chmodSync(bin, 0o755);
  return root;
};
const oxfmtCalls = (root) =>
  existsSync(join(root, OXFMT_CALLS)) ? readFileSync(join(root, OXFMT_CALLS), 'utf8') : '';

const stopHook = (root, rc: number, { projectDir = root, cwd = undefined } = {}) => {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'export {};\n');
  writeFileSync(join(root, 'notes.md'), '# notes\n');
  return spawnSync('bash', [LINT_HOOK], {
    input: JSON.stringify({ session_id: 's1', cwd }),
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: projectDir,
      TMPDIR: seedSessionLedger(root, 's1', ['src/a.ts', 'notes.md']),
      OXFMT_RC: String(rc),
    },
    encoding: 'utf8',
  });
};

describe('format-after-edit.sh — overlay Oxfmt', () => {
  it.each(['src/a.ts', 'src/b.mts'])('formats %s with the repo oxfmt; stdout stays {}', (rel) => {
    const root = overlayRepo(mkTmp('fae-oxfmt-'));
    const r = editFile(root, rel);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('{}');
    expect(oxfmtCalls(root)).toBe(`--no-error-on-unmatched-pattern --write ${join(root, rel)}\n`);
  });

  it.each([
    ['self-host', '{"selfHost":true}'],
    ['a string flag', '{"overlay":"true"}'],
    ['corrupt', '{"overlay":tru'],
    ['absent', null],
  ])('never runs oxfmt when the config is %s (devkit writes .oxfmtrc.json itself)', (_, config) => {
    const root = overlayRepo(mkTmp('fae-oxfmt-'), config);
    expect(editFile(root, 'src/a.ts').status).toBe(0);
    expect(oxfmtCalls(root)).toBe('');
  });

  it('leaves the file to biome when a biome config exists, even for an .mts biome skips', () => {
    const root = overlayRepo(mkTmp('fae-oxfmt-'));
    writeFileSync(join(root, 'biome.json'), '{}\n');
    editFile(root, 'src/b.mts');
    expect(oxfmtCalls(root)).toBe('');
  });

  it('reads the overlay flag from the main checkout when the agent edits a linked worktree', () => {
    const { main, worktree } = mainWithWorktree((p) => mkTmp(`${p}with space-`));
    overlayRepo(main);
    overlayRepo(worktree, null);
    const r = editFile(worktree, 'src/a.ts', { projectDir: main, cwd: worktree });
    expect(r.status).toBe(0);
    expect(oxfmtCalls(worktree)).toContain(join(worktree, 'src/a.ts'));
  });

  it('finds the flag from its own install dir when CLAUDE_PROJECT_DIR is unset (Codex, Cursor)', () => {
    const root = overlayRepo(mkTmp('fae-oxfmt-'));
    const hooks = join(root, '.codex', 'hooks');
    mkdirSync(hooks, { recursive: true });
    for (const f of ['format-after-edit.sh', 'session-edits-lib.sh'])
      copyFileSync(join(dirname(HOOK), f), join(hooks, f));
    const abs = join(root, 'src', 'a.ts');
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, 'export const x = 1;\n');
    const { CLAUDE_PROJECT_DIR: _, ...env } = process.env;
    const r = spawnSync('bash', [join(hooks, 'format-after-edit.sh')], {
      input: JSON.stringify({ file_path: abs }),
      env,
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(oxfmtCalls(root)).toContain(abs);
  });
});

describe('lint-check.sh — overlay Oxfmt', () => {
  it.each([1, 2])('blocks the stop on oxfmt exit %i with its output and the fix hint', (rc) => {
    const root = overlayRepo(mkTmp('lc-oxfmt-'));
    const r = stopHook(root, rc);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('STUB_OUT');
    expect(r.stderr).toContain("Run './node_modules/.bin/oxfmt --write <file>' to auto-fix.");
    expect(oxfmtCalls(root)).toBe('--no-error-on-unmatched-pattern --check src/a.ts\n');
  });

  it('stands down when the bin cannot run (exit 127), and passes a formatted set', () => {
    for (const rc of [127, 0]) {
      const root = overlayRepo(mkTmp('lc-oxfmt-'));
      expect(stopHook(root, rc).status).toBe(0);
    }
  });

  it('still checks when the declared package manager is not installed (the PM guard sits below)', () => {
    const root = overlayRepo(mkTmp('lc-oxfmt-'));
    writeFileSync(join(root, 'package.json'), '{"name":"fx","packageManager":"pnpm@9.0.0"}\n');
    const tools = ['bun', 'node', 'mktemp', 'sort', 'rm'].filter((t) => hasAnyCommand(t));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), 'export {};\n');
    const r = spawnSync('bash', [LINT_HOOK], {
      input: JSON.stringify({ session_id: 's1' }),
      env: {
        ...process.env,
        PATH: isolatedPath(root, tools),
        CLAUDE_PROJECT_DIR: root,
        TMPDIR: seedSessionLedger(root, 's1', ['src/a.ts']),
        OXFMT_RC: '1',
      },
      encoding: 'utf8',
    });
    expect(r.status).toBe(2);
    expect(oxfmtCalls(root)).toContain('src/a.ts');
  });

  it('never runs oxfmt outside overlay', () => {
    const root = overlayRepo(mkTmp('lc-oxfmt-'), '{"selfHost":true}');
    expect(stopHook(root, 1).status).toBe(0);
    expect(oxfmtCalls(root)).toBe('');
  });

  it('reads the overlay flag from the main checkout in a linked worktree', () => {
    const { main, worktree } = mainWithWorktree(mkTmp);
    overlayRepo(main);
    overlayRepo(worktree, null);
    const r = stopHook(worktree, 1, { projectDir: main, cwd: worktree });
    expect(r.status).toBe(2);
    expect(oxfmtCalls(worktree)).toContain('src/a.ts');
  });
});
