#!/usr/bin/env node
/**
 * Pre-write advisory: a Write or Codex apply_patch creating new files would push a folder past the
 * fan-out cap. It relays `guard-fanout preflight` verbatim, before a gated ship round blocks on it.
 *
 * Advisory and fail-safe: `additionalContext`, never a `permissionDecision`; any failure is silence.
 * Preflight reads the tracked index only, so the folder's untracked siblings are named explicitly.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hookRoots, rootOf, writtenFiles } from './edit-targets-lib.mjs';

const TIMEOUT_MS = 10_000;

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

/** The consumer's own guard-fanout, then a PATH one. Absent ⇒ this repo does not use the guard. */
function resolveBin(dirs) {
  const local = dirs.map((dir) => path.join(dir, 'node_modules', '.bin', 'guard-fanout')).find(existsSync);
  if (local) return local;
  const which = spawnSync('command', ['-v', 'guard-fanout'], { encoding: 'utf8', shell: true });
  return which.stdout?.trim() || null;
}

/** Untracked files sitting directly in `dir` — the gate counts direct children only. */
function untrackedSiblings(root, dir) {
  // -z: without it git quotes and escapes non-ASCII names, so they would match no folder.
  const args = ['ls-files', '-z', '--others', '--exclude-standard', '--', `${dir}/`];
  const run = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: TIMEOUT_MS });
  if (run.status !== 0) return [];
  return run.stdout.split('\0').filter((file) => file && path.posix.dirname(file) === dir);
}

/** One advisory per (session, folder). Claimed atomically ('wx') and only once it is emitted. */
function claimed(sessionId, root, dir) {
  const id = createHash('sha256').update(`${root}\x00${dir}`).digest('hex');
  const session = String(sessionId || 'unknown').replace(/[^\w-]/g, '');
  const stamp = path.join(tmpdir(), 'devkit-fanout-brief', `${session}-${id}`);
  try {
    mkdirSync(path.dirname(stamp), { recursive: true });
    writeFileSync(stamp, '', { flag: 'wx' });
    return false;
  } catch (error) {
    return error?.code === 'EEXIST';
  }
}

/** The new files of this call, grouped by checkout and folder, relative to it and posix-spelled. */
function newFilesByFolder(input, roots) {
  const byFolder = new Map();
  for (const abs of writtenFiles(input, roots[0])) {
    const root = rootOf(roots, abs);
    const rel = root && path.relative(root, abs).split(path.sep).join('/');
    if (!rel || existsSync(abs)) continue;
    const dir = path.posix.dirname(rel);
    const group = byFolder.get(`${root}\0${dir}`) ?? { root, dir, rels: [] };
    group.rels.push(rel);
    byFolder.set(`${root}\0${dir}`, group);
  }
  return [...byFolder.values()];
}

/** One preflight per folder: the call's new files there count together with its untracked ones. */
function folderAdvisory(bin, root, dir, rels) {
  const siblings = untrackedSiblings(root, dir).filter((sibling) => !rels.includes(sibling));
  const run = spawnSync(bin, ['preflight', '--', ...rels, ...siblings], {
    cwd: root,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
  });
  if (run.status !== 1 || !run.stdout?.trim()) return null;
  const named = rels.map((rel) => `\`${rel}\``).join(', ');
  const place = rels.length === 1 ? 'place it' : 'place them';
  return `Writing ${named} will block your commit at guard-fanout — ${place} in a subfolder instead.\n\n${run.stdout.trim()}`;
}

function main() {
  const input = readInput();
  const roots = hookRoots(input);
  const groups = newFilesByFolder(input, roots);
  if (groups.length === 0) return;
  const bin = resolveBin(roots);
  if (!bin) return;
  const texts = [];
  for (const { root, dir, rels } of groups) {
    const text = folderAdvisory(bin, root, dir, rels);
    if (text && !claimed(input.session_id, root, dir)) texts.push(text);
  }
  if (texts.length === 0) return;
  const additionalContext = texts.join('\n\n');
  process.stdout.write(
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext } })}\n`,
  );
}

try {
  main();
} catch {
  // An advisory must never be the reason a write fails.
}
