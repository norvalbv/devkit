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
