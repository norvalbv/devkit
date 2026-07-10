import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { type Fixture, makeFixture } from './lib/harness.mts';

// Flow: the INSTALLED agent hooks (what `devkit init` copies into .claude/hooks/, from the packed
// dist) scope in-flight Stop-hook errors to the session that edited the file. Exercises the full
// consumer shape end-to-end: format-after-edit.sh writes the per-session ledger, lint-check.sh
// sources the co-installed session-edits-lib.sh and filters — a lib missing from the dist/tarball
// or from syncHookScripts' copy set fails HERE even though the unit suites (which run the source
// scripts in agents-hooks/) stay green.

const created: Fixture[] = [];
afterAll(() => {
  for (const f of created) f.cleanup();
});

// --agent-hooks is opt-in (init defaults it OFF) — without it .claude/hooks/ is never written.
const INIT_ARGS = ['init', '--stack', 'generic', '--guards', 'size,fanout', '--yes', '--no-skills', '--no-agents', '--agent-hooks'];

// Run an installed hook the way the agent harness does: bash, stdin JSON payload, repo-scoped env.
// TMPDIR is fixture-local so no machine/session state leaks into the ledger.
const runHook = (fx: Fixture, hook: string, payload: object) => {
  const tmp = join(fx.repoDir, '.e2e-tmpdir');
  mkdirSync(tmp, { recursive: true });
  return spawnSync('bash', [join(fx.repoDir, '.claude', 'hooks', hook)], {
    cwd: fx.repoDir,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...fx.env, CLAUDE_PROJECT_DIR: fx.repoDir, TMPDIR: tmp },
  });
};

describe('e2e: session-scoped agent hooks', () => {
  it('blocks only the session that edited the failing file', async () => {
    const fx = await makeFixture();
    created.push(fx);
    expect(fx.run('devkit', INIT_ARGS).status).toBe(0);

    // Two files, a structure-lint stub flagging both (eslint-stylish shape), wired as the
    // consumer's own `lint:structure` script — the hook runs the consumer's scripts, not ours.
    writeFileSync(join(fx.repoDir, 'mine.ts'), 'export {};\n');
    writeFileSync(join(fx.repoDir, 'other.ts'), 'export {};\n');
    writeFileSync(
      join(fx.repoDir, 'structure-stub.sh'),
      [
        'echo "mine.ts"',
        'echo "  3:1  error  max-lines  MINE_ROW"',
        'echo "other.ts"',
        'echo "  9:1  error  max-lines  OTHER_ROW"',
        'exit 1',
      ].join('\n'),
    );
    const pkgPath = join(fx.repoDir, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    pkg.scripts = { ...pkg.scripts, 'lint:structure': 'bash structure-stub.sh' };
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

    // Session s1 edits mine.ts → the installed PostToolUse hook records it in the ledger.
    const edit = runHook(fx, 'format-after-edit.sh', {
      session_id: 's1',
      tool_input: { file_path: join(fx.repoDir, 'mine.ts') },
    });
    expect(edit.status).toBe(0);

    // Session s2 (no edits) stops → never blocked by s1's breakage.
    const s2 = runHook(fx, 'lint-check.sh', { session_id: 's2' });
    expect(s2.status).toBe(0);
    expect(s2.stderr).toBe('');

    // Session s1 stops → blocked, but ONLY with its own file's block.
    const s1 = runHook(fx, 'lint-check.sh', { session_id: 's1' });
    expect(s1.status).toBe(2);
    expect(s1.stderr).toContain('MINE_ROW');
    expect(s1.stderr).not.toContain('OTHER_ROW');
  });
});
