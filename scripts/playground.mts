/**
 * devkit playground — same bootstrap as the e2e suite, but instead of asserting it drops you (or an
 * agent) into a live shell inside a throwaway repo where the INSTALLED devkit + guard-* bins are on
 * PATH and the real pre-commit hook is armed. Type `devkit doctor`, make a commit, watch the gate
 * block — against the actual shipped CLI, not the source.
 *
 *   bun run playground [--stack <name>] [--guards <csv>] [--keep]
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { makeFixture } from '../e2e/lib/harness.mts';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const stack = flag('stack') ?? 'component-lib';
const guards = flag('guards') ?? 'size,fanout';
const keep = process.argv.includes('--keep');

const fx = await makeFixture();

// Seed a base commit + init so the repo is a realistic consumer with the hook armed.
mkdirSync(join(fx.repoDir, 'src'), { recursive: true });
writeFileSync(join(fx.repoDir, 'README.md'), '# playground\n');
writeFileSync(join(fx.repoDir, 'src', 'index.ts'), 'export {};\n');
fx.git('add', 'README.md', 'src/index.ts');
fx.git('commit', '-q', '-m', 'base');

// --agent-hooks: opt-in surface, but the playground exists to poke at everything — install the
// in-flight session hooks too so the banner's simulate-a-session recipe works out of the box.
const init = fx.run('devkit', ['init', '--stack', stack, '--guards', guards, '--yes', '--agent-hooks']);
if (init.status !== 0) {
  process.stderr.write(`devkit init failed:\n${init.stdout ?? ''}${init.stderr ?? ''}\n`);
  fx.cleanup();
  process.exit(1);
}
fx.git('config', 'core.hooksPath', '.husky');

const shell = process.env.SHELL ?? '/bin/zsh';
process.stdout.write(
  [
    '',
    '━━━ devkit playground ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    `  repo   : ${fx.repoDir}`,
    `  stack  : ${stack}   guards: ${guards}`,
    '  devkit + guard-* are LIVE on PATH (the installed dist bins).',
    '  The real pre-commit gate is armed (core.hooksPath=.husky).',
    '  NOTE: no global git identity here (GIT_CONFIG_GLOBAL=/dev/null) —',
    '        the repo-local user is preset, aliases/config are not.',
    '  Try:  devkit doctor',
    '        echo x > src/loose.ts && git add src/loose.ts && git commit -m x   # blocked',
    '  Agent hooks are installed (.claude/hooks/, CLAUDE_PROJECT_DIR is set) — simulate a session:',
    `        echo '{"session_id":"s1","tool_input":{"file_path":"'$PWD'/src/index.ts"}}' \\`,
    '          | bash .claude/hooks/format-after-edit.sh    # records the edit in the s1 ledger',
    `        echo '{"session_id":"s1"}' | bash .claude/hooks/lint-check.sh   # scoped to s1's edits`,
    `  Exit the shell to ${keep ? 'keep' : 'nuke'} the fixture.`,
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
  ].join('\n'),
);

// CLAUDE_PROJECT_DIR so the installed .claude/hooks/* scripts are drivable from this shell
// exactly as the agent harness invokes them (they cd/scope on it).
spawnSync(shell, [], {
  cwd: fx.repoDir,
  stdio: 'inherit',
  env: { ...fx.env, CLAUDE_PROJECT_DIR: fx.repoDir },
});

if (keep) {
  process.stdout.write(`\nfixture kept at ${fx.repoDir}\n`);
} else {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = (await rl.question(`\nNuke fixture ${fx.repoDir}? [Y/n] `)).trim().toLowerCase();
  rl.close();
  if (ans === 'n' || ans === 'no') {
    process.stdout.write(`kept at ${fx.repoDir}\n`);
  } else {
    fx.cleanup();
    process.stdout.write('nuked.\n');
  }
}
