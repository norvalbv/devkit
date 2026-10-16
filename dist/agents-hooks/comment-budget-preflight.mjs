#!/usr/bin/env node
/**
 * PostToolUse advisory: what guard-comments will block at commit, read from the file just written.
 * Never blocks and never auto-approves: additionalContext only, and every failure is silent.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const MUTATING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
const CHECKED_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts']);
/** Keeps the advisory far below Claude Code's 10,000-character context limit, past which it is cut. */
const MAX_ITEMS = 10;

/** One spelling of a path, so a symlinked project dir still contains the files written under it. */
function real(target) {
  try {
    return realpathSync(target);
  } catch {
    const parent = path.dirname(target);
    return parent === target ? target : path.join(real(parent), path.basename(target));
  }
}

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

/** The nearest directory holding guard.config.json, else the project root: the gate's own cwd. */
function packageDirOf(file, root) {
  for (let dir = path.dirname(file); dir.startsWith(root); dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, 'guard.config.json'))) return dir;
    if (dir === root) break;
  }
  return root;
}

function resolveBin(dirs) {
  for (const dir of dirs) {
    const local = path.join(dir, 'node_modules', '.bin', 'guard-comments');
    if (existsSync(local)) return local;
  }
  const which = spawnSync('command', ['-v', 'guard-comments'], { encoding: 'utf8', shell: true });
  return which.stdout?.trim() || null;
}

const STAMP_DIR = path.join(tmpdir(), 'devkit-comment-preflight');
const stampOf = (sessionId, key) =>
  path.join(STAMP_DIR, `${String(sessionId || 'unknown').replace(/[^\w-]/g, '')}-${key}`);

/** True when this hook claims `stamp` first. The 'wx' create is atomic across hooks. */
function claim(stamp) {
  try {
    mkdirSync(STAMP_DIR, { recursive: true });
    writeFileSync(stamp, '', { flag: 'wx' });
    return true;
  } catch (error) {
    return error?.code !== 'EEXIST';
  }
}

function check(bin, cwd, file) {
  const run = spawnSync(bin, ['check', path.relative(cwd, file)], {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (run.status !== 0) return null;
  try {
    const parsed = JSON.parse(run.stdout);
    return Array.isArray(parsed?.items) ? parsed : null;
  } catch {
    return null;
  }
}

function main() {
  const input = readInput();
  if (!input || !MUTATING_TOOLS.has(input.tool_name)) return;
  const raw = String(input.tool_input?.file_path ?? '');
  if (!CHECKED_EXTENSIONS.has(path.extname(raw).toLowerCase())) return;
  const root = real(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const file = real(path.resolve(root, raw));
  const rel = path.relative(root, file);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return;

  const cwd = packageDirOf(file, root);
  const bin = resolveBin([cwd, root]);
  const result = bin && check(bin, cwd, file);
  if (!result) return;
  const unseen = result.items.filter((item) => !existsSync(stampOf(input.session_id, item.key)));
  const fresh = [];
  for (const item of unseen) {
    if (fresh.length === MAX_ITEMS) break;
    if (claim(stampOf(input.session_id, item.key))) fresh.push(item);
  }
  if (fresh.length === 0) return;
  const more = unseen.length - fresh.length;
  const text = [
    `guard-comments will block the commit on ${result.items.length} comment(s) in the file just written:`,
    ...fresh.map((item) => `  • ${item.line}`),
    ...(more > 0
      ? [`  … ${more} more, shown after the next edit or listed by the commit gate.`]
      : []),
    '',
    result.remedy,
  ].join('\n');
  process.stdout.write(
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } })}\n`,
  );
}

main();
