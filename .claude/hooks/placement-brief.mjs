#!/usr/bin/env node
/**
 * Pre-write advisory: a NEW file a Write or Codex apply_patch is about to create will be rejected at
 * commit by the folder-structure grammar. Silent for every other write; fanout-brief.mjs covers the
 * fan-out cap.
 *
 * Synced into consumer repos beside edit-targets-lib.mjs, so it shells out to the gate's own
 * `preflight` command rather than reimplementing it, and is a no-op when it is absent.
 *
 * Advisory: additionalContext (Cursor: additional_context, as base-drift-brief.mjs sends it), never a
 * permission decision: "allow" would strip the user's prompts. Existing targets skip every spawn.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { projectRoot, writtenFiles } from './edit-targets-lib.mjs';

const CALL_TIMEOUT_MS = 10_000;

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
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
  // Cursor reads additional_context on an allowed call; agent_message reaches the agent only on deny.
  if (input?.cursor_version) return { additional_context: text };
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } };
}

/** One preflight per config root, over every new file it governs. */
function rootAdvisory(project, root, rels) {
  const bin = resolveBin([root, project], 'guard-structure');
  if (!bin) return null;
  const run = spawnSync(bin, ['preflight', '--', ...rels], {
    cwd: root,
    encoding: 'utf8',
    timeout: CALL_TIMEOUT_MS,
  });
  // Exit 1 is the only "would block"; 0 is clean and 2 (no grammar, old bin) is not judged.
  if (run.status !== 1 || !run.stdout?.trim()) return null;
  const lead =
    rels.length === 1
      ? `\`${rels[0]}\` is a new file the folder-structure gate will reject at commit — place it elsewhere first:`
      : `New files here (${rels.map((rel) => `\`${rel}\``).join(', ')}) break the folder-structure gate at commit — place the ones below elsewhere first:`;
  return `${lead}\n\n${run.stdout.trim()}`;
}

export function main() {
  const input = readJson(0);
  const project = path.resolve(projectRoot());
  const byRoot = new Map();
  for (const file of writtenFiles(input, project)) {
    const root = existsSync(file) ? null : configRoot(project, file);
    if (root) byRoot.set(root, [...(byRoot.get(root) ?? []), path.relative(root, file)]);
  }
  const texts = [...byRoot].map(([root, rels]) => rootAdvisory(project, root, rels)).filter(Boolean);
  if (texts.length === 0) return;
  process.stdout.write(`${JSON.stringify(renderAdvisory(input, texts.join('\n\n')))}\n`);
}

try {
  main();
} catch {
  // An advisory must never be the reason a write fails.
}
