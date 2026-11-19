#!/usr/bin/env node
/**
 * The files a Codex `apply_patch` call touches. Codex runs devkit's Edit|Write hooks for it but sends
 * the patch text instead of a file_path, so each edit hook adds these paths to its own extraction.
 *
 * Only `*** Add File:` / `Update File:` / `Delete File:` / `Move to:` header lines are read; hunk lines
 * always start with a space, `+` or `-`, so they never match. Anything unreadable yields [] (fail-open).
 *
 * CLI: stdin payload → one absolute path per line, or with `--payloads` the same payload once per path
 * with `tool_input` replaced by `{ file_path }`, for a shell hook that handles one file per run.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HEADER = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;

/** The patch text: freeform calls send it as `command`, function calls as `input` or the raw value. */
function patchText(toolInput) {
  const candidates = [toolInput?.command, toolInput?.input, toolInput].map((c) => String(c ?? ''));
  return candidates.find((c) => c.includes('*** Begin Patch')) ?? '';
}

/** Patch paths are relative to the turn cwd; resolve it physically, as git spells the hook roots. */
function baseDir(cwd) {
  try {
    return realpathSync(cwd || process.cwd());
  } catch {
    return String(cwd);
  }
}

/** Absolute paths an apply_patch call adds, updates, deletes or moves; [] for every other tool. */
export function patchTargets(input) {
  if (input?.tool_name !== 'apply_patch') return [];
  const base = baseDir(input.cwd);
  const named = [...patchText(input.tool_input).matchAll(HEADER)].map((m) => m[1].trim());
  return [...new Set(named.filter(Boolean).map((p) => path.resolve(base, p)))];
}

/** Absolute paths under `root` a Write (any provider's path key) or apply_patch names. */
export function writtenFiles(input, root) {
  if (input?.tool_name !== 'Write') {
    // Patch paths are physical; re-spell them under `root`, which may name the project via a symlink.
    const real = baseDir(root);
    const inside = (p) => p.startsWith(real + path.sep);
    return patchTargets(input).map((p) => (inside(p) ? path.join(root, path.relative(real, p)) : p));
  }
  const toolInput = input.tool_input ?? {};
  const key = ['file_path', 'path', 'target_file', 'target_path'].find((k) => toolInput[k]?.trim?.());
  return key ? [path.resolve(root, toolInput[key].trim())] : [];
}

/** Claude names the project root; Codex runs the hook from the session cwd, maybe a subdirectory. */
export function projectRoot() {
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  const run = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 5000 });
  return (run.status === 0 && run.stdout.trim()) || process.cwd();
}

/** `git rev-parse` output lines for `dir`, or [] when it is not inside a git work tree. */
function revParse(dir, ...args) {
  const run = spawnSync('git', ['-C', dir, 'rev-parse', ...args], { encoding: 'utf8', timeout: 5000 });
  return run.status === 0 ? run.stdout.split('\n') : [];
}

/**
 * The checkout to act on: the project's directory inside the linked worktree holding the payload cwd,
 * spelled as the cwd spells it. The same checkout, an unrelated repository or no cwd keeps projectRoot().
 */
export function workspaceRoot(input) {
  const project = projectRoot();
  if (!input?.cwd?.trim?.()) return project;
  const at = ['--path-format=absolute', '--show-toplevel', '--git-common-dir'];
  const [cdup, top, common] = revParse(input.cwd, '--show-cdup', ...at);
  const [projectTop, projectCommon] = revParse(project, ...at);
  if (!common || common !== projectCommon || top === projectTop) return project;
  return path.join(path.resolve(input.cwd, cdup), path.relative(projectTop, baseDir(project)));
}

/** The checkouts an edit may land in: the payload cwd's worktree first, then the project root. */
export function hookRoots(input) {
  return [...new Set([workspaceRoot(input), projectRoot()].map((root) => path.resolve(root)))];
}

/** The first of `roots` holding `file`, or undefined. */
export function rootOf(roots, file) {
  return roots.find((root) => {
    const rel = path.relative(root, file);
    return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  });
}

function main() {
  let input = null;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  const lines = process.argv.includes('--payloads')
    ? patchTargets(input).map((file_path) =>
        JSON.stringify({ ...input, tool_input: { file_path } }),
      )
    : patchTargets(input);
  if (lines.length) process.stdout.write(`${lines.join('\n')}\n`);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) main();
