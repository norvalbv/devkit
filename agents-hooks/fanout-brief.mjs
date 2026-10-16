#!/usr/bin/env node
/**
 * Pre-write advisory: a Write creating a new file would push its folder past the fan-out cap.
 * It relays `guard-fanout preflight` verbatim, before a gated ship round discovers the same block.
 *
 * Advisory and fail-safe: `additionalContext`, never a `permissionDecision`; any failure is silence.
 * Preflight reads the tracked index only, so the folder's untracked siblings are named explicitly.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PATH_KEYS = ['file_path', 'path', 'target_file', 'target_path'];
const TIMEOUT_MS = 10_000;

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

function filePathOf(input) {
  const ti = input?.tool_input ?? {};
  // `.trim?.()` is absent on every non-string, so only a non-empty string path survives.
  for (const k of PATH_KEYS) if (ti[k]?.trim?.()) return ti[k];
  return null;
}

/** The consumer's own guard-fanout, then a PATH one. Absent ⇒ this repo does not use the guard. */
function resolveBin(root) {
  const local = path.join(root, 'node_modules', '.bin', 'guard-fanout');
  if (existsSync(local)) return local;
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
  const id = Buffer.from(`${root}\x00${dir}`).toString('base64url').slice(-64);
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

function main() {
  const input = readInput();
  if (input?.tool_name !== 'Write') return;
  const file = filePathOf(input);
  if (!file) return;

  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const abs = path.resolve(root, file);
  const rel = path.relative(root, abs).split(path.sep).join('/');
  if (!rel || rel.startsWith('..') || existsSync(abs)) return;

  const bin = resolveBin(root);
  if (!bin) return;
  const dir = path.posix.dirname(rel);
  const siblings = untrackedSiblings(root, dir).filter((sibling) => sibling !== rel);
  const run = spawnSync(bin, ['preflight', '--', rel, ...siblings], {
    cwd: root,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
  });
  if (run.status !== 1 || !run.stdout?.trim()) return;
  if (claimed(input.session_id, root, dir)) return;

  const text =
    `Writing \`${rel}\` will block your commit at guard-fanout — place it in a subfolder instead.\n\n` +
    run.stdout.trim();
  process.stdout.write(
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } })}\n`,
  );
}

try {
  main();
} catch {
  // An advisory must never be the reason a write fails.
}
