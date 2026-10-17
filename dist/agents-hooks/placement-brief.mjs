#!/usr/bin/env node
/**
 * Pre-write advisory: the NEW file about to be written will be rejected at commit by the
 * folder-structure grammar or the folder fan-out cap. Silent for every other write.
 *
 * Synced into consumer repos as a standalone script, so it shells out to the gates' own
 * `preflight` commands rather than reimplementing them, and is a no-op when they are absent.
 *
 * Advisory: additionalContext only, never a permissionDecision ("allow" would strip the user's
 * permission prompts). An existing target returns before any spawn, so no dedup state is needed.
 */
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const PATH_KEYS = ['file_path', 'path', 'target_file', 'target_path'];
const CALL_TIMEOUT_MS = 10_000;

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function targetOf(input) {
  const toolInput = input?.tool_input ?? {};
  const key = PATH_KEYS.find((name) => String(toolInput[name] ?? '').trim());
  return key ? String(toolInput[key]).trim() : null;
}

// The nearest guard.config.json at or above the target, never above the project: a monorepo
// package's own config governs its files.
function configRoot(project, file) {
  for (
    let dir = path.dirname(file);
    !path.relative(project, dir).startsWith('..');
    dir = path.dirname(dir)
  ) {
    if (existsSync(path.join(dir, 'guard.config.json'))) return dir;
    if (dir === project || dir === path.dirname(dir)) return null;
  }
  return null;
}

function resolveBin(dirs, name) {
  for (const dir of dirs) {
    const local = path.join(dir, 'node_modules', '.bin', name);
    if (existsSync(local)) return local;
  }
  const which = spawnSync('command', ['-v', name], { encoding: 'utf8', shell: true });
  return which.stdout?.trim() || null;
}

// The fan-out preview judges any repo with structure trees, so only ask it where the guard runs.
// init records the selection beside guard.config.json, which in a monorepo is the package.
function fanoutGuarded(root) {
  return Boolean(
    readJson(path.join(root, '.devkit', 'config.json'))?.components?.guards?.includes('fanout'),
  );
}

/** Resolves to the preflight's stdout when it says the commit would block (exit 1), else null. */
function blockingOutput(bin, rel, cwd) {
  return new Promise((resolve) => {
    execFile(
      bin,
      ['preflight', '--', rel],
      { cwd, encoding: 'utf8', timeout: CALL_TIMEOUT_MS },
      (error, stdout) => {
        resolve(error?.code === 1 && stdout.trim() ? stdout.trim() : null);
      },
    );
  });
}

function renderAdvisory(input, text) {
  if (input?.cursor_version) return { agent_message: text };
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } };
}

export async function main() {
  const input = readJson(0);
  if (input?.tool_name !== 'Write') return;
  const target = targetOf(input);
  if (!target) return;
  const project = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const file = path.resolve(project, target);
  if (existsSync(file)) return;
  const root = configRoot(project, file);
  if (!root) return;
  const rel = path.relative(root, file);
  const gates = fanoutGuarded(root) ? ['guard-structure', 'guard-fanout'] : ['guard-structure'];
  const outputs = await Promise.all(
    gates.map((name) => {
      const bin = resolveBin([root, project], name);
      return bin ? blockingOutput(bin, rel, root) : null;
    }),
  );
  const blocks = outputs.filter(Boolean);
  if (blocks.length === 0) return;
  const text = `\`${rel}\` is a new file that will be rejected at commit — place it elsewhere first:\n\n${blocks.join('\n\n')}`;
  process.stdout.write(`${JSON.stringify(renderAdvisory(input, text))}\n`);
}

main().catch(() => {
  // An advisory must never be the reason a write fails.
});
