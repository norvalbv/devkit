#!/usr/bin/env node
// PostToolUse (Edit|Write|MultiEdit, and Codex apply_patch): report an edit that left a file over its guard-size line
// ceiling, so the overrun is fixed now instead of surfacing as a blocked commit.
//
// Advisory only: it adds context and never blocks. Any failure prints `{}`.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { hookRoots, patchTargets } from './edit-targets-lib.mjs';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'apply_patch']);
// preflight's own overrun verdict: exit 1 alone also means an uncaught throw.
const OVERRUN_RE = /^🚫 \d+ file\(s\) exceed the line limit/m;

/** The nearest directory at or above `file`, inside `root`, holding guard.config.json. */
function configDir(root, file) {
  for (let dir = dirname(file); dir.startsWith(root); dir = dirname(dir)) {
    if (existsSync(join(dir, 'guard.config.json'))) return dir;
    if (dir === root) break;
  }
  return null;
}

/** The installed guard-size bin, falling back to PATH; never bunx/npx, which fetch from the network. */
function guardSizeBin(dir, roots) {
  for (const base of [dir, ...roots]) {
    const bin = join(base, 'node_modules', '.bin', 'guard-size');
    if (existsSync(bin)) return bin;
  }
  return 'guard-size';
}

/** Files the edit touched, grouped by the guard.config.json directory that governs them. */
function editedFilesByConfig(input, roots) {
  const groups = new Map();
  // `.trim?.()` exists only on strings, so it also drops every non-string value.
  const named = [input?.tool_input?.file_path, input?.tool_input?.path].filter((p) => p?.trim?.());
  named.push(...patchTargets(input));
  for (const path of new Set(named)) {
    const abs = resolve(roots[0], path);
    if (!existsSync(abs) || !statSync(abs).isFile()) continue;
    const real = realpathSync(abs);
    const root = roots.find((r) => real.startsWith(r + sep));
    const dir = root && configDir(root, real);
    if (dir) groups.set(dir, [...(groups.get(dir) ?? []), relative(dir, real)]);
  }
  return groups;
}

/** preflight's overrun block for each over-ceiling group, or an empty list. */
function overruns(input, checkouts) {
  if (!EDIT_TOOLS.has(input?.tool_name)) return [];
  const roots = checkouts.filter((root) => existsSync(root)).map((root) => realpathSync(root));
  const reports = [];
  for (const [dir, rels] of editedFilesByConfig(input, roots)) {
    const run = spawnSync(guardSizeBin(dir, roots), ['preflight', '--base', 'HEAD', '--', ...rels], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (run.status === 1 && OVERRUN_RE.test(run.stderr)) reports.push(run.stderr.trim());
  }
  return reports;
}

function main() {
  let output = {};
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const reports = overruns(input, hookRoots(input));
    if (reports.length > 0) {
      const additionalContext = `guard-size, measured after this edit:\n${reports.join('\n')}\nNet growth past the ceiling blocks the commit: trim this change, or move whole functions (with their tests) to another file.`;
      output = { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext } };
    }
  } catch {
    // An advisory must never be the reason an edit fails.
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

main();
