/**
 * The class invariant behind sc-1338 / sc-1417: a devkit hook registered on PreToolUse with matcher
 * `Bash` sees EVERY shell command an agent runs, so if it blocks one it did not mean to gate, the
 * agent loses the `git reset` that would clear the condition — and recovery needs the exact tool the
 * block removes. No registration on that matcher may deny a non-commit command.
 *
 * This lives apart from cli/__tests__/fallow-staged-gate.test.mts on purpose. That suite proves ONE
 * script is scoped, and travels with it: a checkout that reverts the script and its suite together
 * stays green. This one is driven by HOOK_REGISTRATIONS, so it fails on a wholesale revert and on a
 * future hook added to the matcher without command scoping.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { HOOK_REGISTRATIONS } from '../lib/install/hook-registration-ledger/registrations.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FAIL_VERDICT = '{"verdict":"fail","attribution":{"duplication_introduced":0}}';

const PRE_BASH = Object.entries(HOOK_REGISTRATIONS)
  .flatMap(([ownerId, registrations]) => registrations.map((r) => ({ ownerId, ...r })))
  .filter((r) => r.event === 'PreToolUse' && r.matcher === 'Bash');

/**
 * A registration's command is written for a CONSUMER's tree. Map it back onto devkit's own layout:
 * synced agent hooks live in `agents-hooks/`, engine bins are addressed through the installed
 * package that devkit itself does not depend on (see [[devkit-self-dogfood]]).
 */
function resolveHookScript(command: string): { runner: string; script: string } {
  const [runner, target] = command.replaceAll('"', '').split(/\s+/);
  const rel = (target ?? '').replace(/^\$CLAUDE_PROJECT_DIR\/?/, '');
  const repoRel = rel
    .replace(/^\.claude\/hooks\//, 'agents-hooks/')
    .replace(/^node_modules\/@norvalbv\/devkit\//, '');
  return { runner: runner ?? '', script: join(REPO_ROOT, repoRel) };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A repo in the exact state sc-1417 reported: fallow adopted, a staged set its audit fails. Any hook
 * that gates the index on the wrong command will block here — which is what makes a green result
 * evidence rather than an absence of configuration (asserted by the armed-fixture test below).
 */
function armedRepo(): { dir: string; binDir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pre-bash-'));
  dirs.push(dir);
  const git = (args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git(['init', '-q', '.']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'test']);
  writeFileSync(join(dir, '.fallowrc.jsonc'), '{}\n');
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'base']);
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\nexport const b = 2;\n');
  git(['add', 'a.ts']);

  const binDir = join(dir, 'stub-bin');
  mkdirSync(binDir);
  const stub = join(binDir, 'fallow');
  writeFileSync(
    stub,
    `#!/bin/sh\ncase "$*" in *--version*) echo "fallow 9.9.9";; *) echo '${FAIL_VERDICT}';; esac\n`,
    {
      mode: 0o755,
    },
  );
  symlinkSync(process.execPath, join(binDir, 'node'));
  return { dir, binDir };
}

function runHook(
  registrationCommand: string,
  { dir, binDir }: { dir: string; binDir: string },
  { command, cursor = false }: { command: string; cursor?: boolean },
) {
  const { runner, script } = resolveHookScript(registrationCommand);
  const payload = cursor ? { command } : { tool_input: { command } };
  const r = spawnSync(runner, [script], {
    cwd: dir,
    encoding: 'utf8',
    input: JSON.stringify(payload),
    env: {
      ...process.env,
      PATH: [binDir, '/usr/bin', '/bin'].join(':'),
      CLAUDE_PROJECT_DIR: dir,
    },
  });
  return { status: r.status, stdout: r.stdout ?? '' };
}

/** Claude Code denies a tool call by exit 2 OR by a stdout verdict — an invariant must read both. */
function deniedByStdout(stdout: string): boolean {
  try {
    const decision = JSON.parse(stdout)?.hookSpecificOutput?.permissionDecision;
    return decision === 'deny' || decision === 'ask';
  } catch {
    return false;
  }
}

describe('PreToolUse hooks registered on matcher Bash', () => {
  it('registers at least one, and each resolves to a script that exists', () => {
    expect(PRE_BASH.length).toBeGreaterThan(0);
    for (const registration of PRE_BASH) {
      const { runner, script } = resolveHookScript(registration.command);
      expect(['bash', 'node']).toContain(runner);
      expect(existsSync(script), `${registration.registrationId} -> ${script}`).toBe(true);
    }
  });

  it.each(PRE_BASH.map((r) => [r.registrationId, r.command] as const))(
    'never denies a recovery command with a failing staged set: %s',
    (_id, registrationCommand) => {
      const repo = armedRepo();
      for (const command of ['git reset', 'git restore --staged a.ts', 'git status', 'bun test']) {
        for (const cursor of [false, true]) {
          const { status, stdout } = runHook(registrationCommand, repo, { command, cursor });
          expect(status, `${command} (cursor=${cursor})`).not.toBe(2);
          expect(deniedByStdout(stdout), `${command} (cursor=${cursor})`).toBe(false);
        }
      }
    },
  );

  it('is armed: the same fixture still produces a block for a real commit', () => {
    const repo = armedRepo();
    const blocked = PRE_BASH.filter(
      (r) => runHook(r.command, repo, { command: 'git commit -m "test"' }).status === 2,
    );
    expect(blocked.map((r) => r.registrationId)).toContain('fallow:pre-bash');
  });
});
