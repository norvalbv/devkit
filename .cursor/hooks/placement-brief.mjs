#!/usr/bin/env node
/**
 * Pre-write advisory: the NEW file about to be written will be rejected at commit by the
 * folder-structure grammar. Silent for every other write; fanout-brief.mjs covers the fan-out cap.
 *
 * Synced into consumer repos as a standalone script, so it shells out to the gate's own
 * `preflight` command rather than reimplementing it, and is a no-op when it is absent.
 *
 * Advisory: additionalContext only, never a permissionDecision ("allow" would strip the user's
 * permission prompts). An existing target returns before any spawn, so no dedup state is needed.
 */
import { spawnSync } from 'node:child_process';
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

function renderAdvisory(input, text) {
  if (input?.cursor_version) return { agent_message: text };
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } };
}

export function main() {
  const input = readJson(0);
  if (input?.tool_name !== 'Write') return;
  const target = targetOf(input);
  if (!target) return;
  const project = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const file = path.resolve(project, target);
  if (existsSync(file)) return;
  const root = configRoot(project, file);
  if (!root) return;
  const bin = resolveBin([root, project], 'guard-structure');
  if (!bin) return;
  const rel = path.relative(root, file);
  const run = spawnSync(bin, ['preflight', '--', rel], {
    cwd: root,
    encoding: 'utf8',
    timeout: CALL_TIMEOUT_MS,
  });
  // Exit 1 is the only "would block"; 0 is clean and 2 (no grammar, old bin) is not judged.
  if (run.status !== 1 || !run.stdout?.trim()) return;
  const text = `\`${rel}\` is a new file the folder-structure gate will reject at commit — place it elsewhere first:\n\n${run.stdout.trim()}`;
  process.stdout.write(`${JSON.stringify(renderAdvisory(input, text))}\n`);
}

try {
  main();
} catch {
  // An advisory must never be the reason a write fails.
}
