/**
 * devkit playground — same bootstrap as the e2e suite, but instead of asserting it drops you (or an
 * agent) into a live shell inside a throwaway repo where the INSTALLED devkit + guard-* bins are on
 * PATH and the real pre-commit hook is armed. Type `devkit doctor`, make a commit, watch the gate
 * block — against the actual shipped CLI, not the source.
 *
 *   bun run playground [--stack <name>] [--guards <csv>] [--keep]
 *
 * With --change it runs no shell: it commits --seed (or the default seed) as the base, overlays
 * --change, prints a queued `devkit ship --dry-gates` of those files and exits with its status.
 * Flags after `--` go to ship. The stack defaults to generic there.
 *
 *   bun run playground --change <dir> [--seed <dir>] [--stack <name>] [--keep] [-- <ship flags>]
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { makeFixture } from '../e2e/lib/harness.mts';
import { prepareShipProof, writeDefaultSeed } from '../e2e/lib/ship-proof.mts';

const dashDash = process.argv.indexOf('--');
const ownArgs = dashDash >= 0 ? process.argv.slice(0, dashDash) : process.argv;
const shipArgs = dashDash >= 0 ? process.argv.slice(dashDash + 1) : [];
function flag(name: string): string | undefined {
  const i = ownArgs.indexOf(`--${name}`);
  return i >= 0 ? ownArgs[i + 1] : undefined;
}
const change = flag('change');
const stack = flag('stack') ?? (change ? 'generic' : 'component-lib');
const guards = flag('guards') ?? 'size,fanout';
const keep = ownArgs.includes('--keep');

if (change) process.exit(await runShipProof(change));

async function runShipProof(changeDir: string): Promise<number> {
  const proof = await prepareShipProof({ seed: flag('seed'), change: changeDir, stack, guards });
  const devkit = join(proof.fx.repoDir, 'node_modules', '.bin', 'devkit');
  const ship = spawnSync(
    devkit,
    ['ship', 'proof', 'proof', '--dry-gates', ...shipArgs, '--', ...proof.paths],
    { cwd: proof.fx.repoDir, env: proof.env, stdio: ['ignore', 'inherit', 'inherit'] },
  );
  if (keep) process.stdout.write(`\nkept: ${proof.fx.repoDir}\n      ${proof.root}\n`);
  else proof.cleanup();
  return ship.status ?? 1;
}

const fx = await makeFixture();

// Seed a base commit + init so the repo is a realistic consumer with the hook armed.
writeDefaultSeed(fx.repoDir);
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
