#!/usr/bin/env node
/**
 * Pre-edit BRIEF: surface the rulings that already govern a file, before an agent writes to it.
 *
 * The decision log was enforcement-only. `check-alignment` catches a contradiction once staged, and
 * `decision-stop-check` nudges you to RECORD one at turn end — both after the work is done. Nothing
 * told an agent "this area is already settled" while it could still act on that. So an agent could
 * re-solve a decided problem from the code alone and only learn at commit, if the ruling happened to
 * carry a Scope glob matching the staged files.
 *
 * MATCHES ON SCOPE GLOBS, NOT TEXT SIMILARITY. This is the whole reason it can exist. Free-text
 * retrieval cannot tell "governed" from "ungoverned": measured on this repo's own corpus, the lexical
 * top-1 score tracks QUERY LENGTH (r=0.908), so every short-but-governed probe scored below every
 * long-but-ungoverned one — a threshold there buys "only long prompts", not precision. A Scope glob is
 * a statement the ruling's author made about which files it governs, so matching it needs no
 * threshold, no model, and no network. 33 of 34 axes in this repo declare one.
 *
 * ADVISORY, AND FAIL-SAFE BY CONSTRUCTION. It emits `additionalContext` and deliberately NO
 * `permissionDecision`. Claude Code places PreToolUse and PostToolUse `additionalContext` next to the
 * tool result, so either way the agent reads the ruling right after its write. What it must never do
 * is block an edit or return `permissionDecision: "allow"` — the latter would auto-approve every
 * write and quietly strip the user's permission prompts, which is a far worse outcome than a missed
 * hint.
 *
 * BASH WRITES (Claude, PostToolUse). A Bash call names no file, so its writes come from git status
 * (`bashWrites`). They share the Edit path's per-(session, file) stamp, so a file is briefed once
 * whichever channel wrote it; an ungoverned file is marked, so it costs one retrieval per session.
 *
 * Repetition is the other way an advisory dies: a brief re-shown on all thirty edits to one file is
 * noise an agent learns to skip. Each (session, file) is briefed at most once.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bashWrites, patchTargets } from './edit-targets-lib.mjs';

const MUTATING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'apply_patch']);
// Claude and Cursor send `file_path`; the wider set costs nothing and covers a provider that does not.
const PATH_KEYS = ['file_path', 'path', 'target_file', 'target_path'];
/** The ruling is the payload: a clause cut from view goes unkept, so only outlier rulings are cut. */
const RULING_CHARS = 2000;
const MAX_AXES = 3;
/** Claude Code swaps a longer additionalContext for a file path and a short preview. */
const MAX_BRIEF_CHARS = 10_000;
const TIMEOUT_MS = 10_000;
const STDERR_CHARS = 200;
/** One retrieval spawn per file, so a large Codex patch or Bash call is briefed on its first few. */
const MAX_FILES = 5;
/** Set by the first outage, so one call under load costs a single spawn timeout, not one per file. */
let retrievalDown = false;

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

/** The tool input as an object: Cursor documents some tools' `tool_input` as a JSON params string. */
function toolInputOf(input) {
  try {
    return JSON.parse(input?.tool_input);
  } catch {
    return input?.tool_input;
  }
}

function filePathOf(input) {
  const ti = toolInputOf(input) ?? {};
  for (const k of PATH_KEYS) if (typeof ti[k] === 'string' && ti[k].trim()) return ti[k];
  return null;
}

/** The consumer's own guard-decisions, then a PATH one. Absent ⇒ this repo does not use the guard. */
function resolveBin(root) {
  const local = path.join(root, 'node_modules', '.bin', 'guard-decisions');
  if (existsSync(local)) return local;
  const which = spawnSync('command', ['-v', 'guard-decisions'], { encoding: 'utf8', shell: true });
  const found = which.stdout?.trim();
  return found || null;
}

/** `git rev-parse` output lines for `dir`, or [] when it is not inside a git work tree. */
function revParse(dir, ...args) {
  const run = spawnSync('git', ['-C', dir, 'rev-parse', ...args], { encoding: 'utf8' });
  return run.status === 0 ? run.stdout.split('\n') : [];
}

/**
 * The checkout to brief on. The payload cwd follows the agent into a linked worktree while
 * CLAUDE_PROJECT_DIR stays put; a cwd in the same checkout or an unrelated repository keeps the root.
 */
function workspaceRoot(input) {
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (!input?.cwd?.trim?.()) return root;
  const at = ['--path-format=absolute', '--show-toplevel', '--git-common-dir'];
  const [cdup, top, common] = revParse(input.cwd, '--show-cdup', ...at);
  const [rootTop, rootCommon] = revParse(root, ...at);
  return common && top !== rootTop && common === rootCommon ? path.resolve(input.cwd, cdup) : root;
}

/** One brief per (session, file): the stamp marking that `key` was briefed in this session. */
function stampPath(sessionId, root, key) {
  const id = Buffer.from(`${root}\x00${key}`).toString('base64url').slice(-64);
  return path.join(
    tmpdir(),
    'devkit-decision-brief',
    `${String(sessionId || 'unknown').replace(/[^\w-]/g, '')}-${id}`,
  );
}

/** When `stamp` was claimed, else null. Any read error counts as unbriefed, so the brief still runs. */
function claimedAt(stamp) {
  try {
    return statSync(stamp).mtimeMs;
  } catch {
    return null;
  }
}

/** True when `stamp` was already claimed. Best-effort: a failure here must never cost the edit. */
function claimed(stamp) {
  try {
    mkdirSync(path.dirname(stamp), { recursive: true });
    // Atomic claim: 'wx' fails EEXIST when the stamp exists, so two concurrent hooks in one session
    // cannot both observe it absent and both emit. An existsSync probe first would be a TOCTOU.
    writeFileSync(stamp, '', { flag: 'wx' });
    return false;
  } catch (error) {
    // EEXIST IS the answer — someone already briefed. Anything else stays best-effort.
    return error?.code === 'EEXIST';
  }
}

/** Why retrieval did not run, so a broken install reads differently from a timeout under load. */
function outageCause(run, bin) {
  let cause = 'no JSON array on stdout';
  if (run.error?.code === 'ETIMEDOUT') cause = `timed out after ${TIMEOUT_MS / 1000}s`;
  else if (run.signal) cause = `killed by ${run.signal}`;
  else if (run.error) cause = run.error.code ?? run.error.message;
  else if (run.status !== 0) cause = `exit ${run.status}`;
  const lines = String(run.stderr ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const stderr = lines.slice(0, 2).join(' ');
  const clipped = stderr.length > STDERR_CHARS ? `${stderr.slice(0, STDERR_CHARS)}…` : stderr;
  return `${cause}${clipped ? ` — ${clipped}` : ''} (ran \`${bin}\`)`;
}

/** The ONLY output channel, written once per run. Advisory: additionalContext, never permissionDecision. */
function emit(texts, hookEventName = 'PreToolUse') {
  const brief = texts.filter(Boolean).join('\n\n');
  if (!brief) return;
  const text = brief.length > MAX_BRIEF_CHARS ? `${brief.slice(0, MAX_BRIEF_CHARS - 1)}…` : brief;
  process.stdout.write(
    `${JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: text } })}\n`,
  );
}

function main() {
  const input = readInput();
  const bash = input?.tool_name === 'Bash';
  if (!input || (!bash && !MUTATING_TOOLS.has(input.tool_name))) return;
  const root = workspaceRoot(input);
  const file = bash ? null : filePathOf(input);
  const candidates = bash ? unbriefedBashWrites(input, root) : patchTargets(input);
  const texts = [];
  for (const f of file ? [file] : candidates.slice(0, MAX_FILES)) {
    // A brief past the cap is never read, so its file stays unstamped for a later write.
    if (retrievalDown || texts.join('\n\n').length >= MAX_BRIEF_CHARS) break;
    texts.push(briefFor(input, root, f));
  }
  emit(texts, bash ? 'PostToolUse' : 'PreToolUse');
}

/** The Bash call's writes not yet briefed or found ungoverned this session; returns go unrecorded. */
function unbriefedBashWrites(input, root) {
  return bashWrites(input, root).filter((rel) => {
    const stamp = stampPath(input.session_id, root, rel);
    return claimedAt(stamp) === null && claimedAt(`${stamp}.none`) === null;
  });
}

/** Briefed already, so no retrieval. Only the first return to the file is recorded, with its age. */
function recordReturn(root, rel, tool, stamp, briefedAt) {
  const bin = claimed(`${stamp}.again`) ? null : resolveBin(root);
  if (!bin) return;
  const secs = Math.max(0, Math.round((Date.now() - briefedAt) / 1000));
  spawnSync(bin, ['scoped-targets', '--files', rel, '--brief-again', `${tool},${secs}`], {
    cwd: root,
    stdio: 'ignore',
    timeout: TIMEOUT_MS,
  });
}

/** The retrieved axes, or null when the run's output is not a JSON array (an outage, not an answer). */
function axesFrom(run) {
  if (run.status !== 0 || !run.stdout?.trim()) return null;
  try {
    const parsed = JSON.parse(run.stdout);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The brief or retrieval-outage notice for one file, or null when there is nothing to say. */
function briefFor(input, root, file) {
  const rel = path.isAbsolute(file) ? path.relative(root, file) : file;
  // Outside the project (or above it) is not ours to brief on.
  if (!rel || rel.startsWith('..')) return null;

  const tool = input.tool_name;
  const stamp = stampPath(input.session_id, root, rel);
  const briefedAt = claimedAt(stamp);
  if (briefedAt !== null) {
    recordReturn(root, rel, tool, stamp, briefedAt);
    return null;
  }

  const bin = resolveBin(root);
  if (!bin) return null;

  const spec = `${tool},${MAX_AXES},${RULING_CHARS}`;
  const run = spawnSync(bin, ['scoped-targets', '--files', rel, '--brief', spec], {
    cwd: root,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
  });
  // CAUSE-AGNOSTIC. Anything other than "exit 0 carrying a JSON array" means retrieval DID NOT RUN:
  // a spawn timeout (status null), a non-zero exit, empty stdout from a command whose every path
  // writes JSON, or output that does not parse to an array. Only an EMPTY array is the quiet case —
  // that is retrieval running and answering "nothing governs". These were one branch and they are
  // not one fact: staying silent for an outage reads to an agent as a clean bill of health, which is
  // the failure this hook exists to prevent.
  const axes = axesFrom(run);
  if (axes === null) {
    retrievalDown = true;
    // A sentinel key, never a relative path: the notice fires once per session WITHOUT burning this
    // file's brief slot, so the first governed edit after the tool is fixed is still briefed.
    if (claimed(stampPath(input.session_id, root, '\u0000retrieval-unavailable'))) return null;
    return (
      `Decision retrieval DID NOT RUN for \`${rel}\` — \`guard-decisions scoped-targets\` failed, so ` +
        `this edit is UNBRIEFED, not ungoverned. Do not read the absence of a brief as "nothing rules ` +
        `here". Re-run \`guard-decisions scoped-targets --files ${rel}\` before deciding: it is what ` +
        `evaluates Scope globs, and a text search for the path cannot match globs such as \`dir/**\`. ` +
        `A later edit to this file re-checks, but a repeat failure this session is not announced ` +
        `again, so silence then is not a clean answer. Cause: ${outageCause(run, bin)}.`
    );
  }
  if (axes.length === 0) {
    if (tool === 'Bash') claimed(`${stamp}.none`); // a Bash call re-touching it skips the retrieval
    return null; // nothing governs this file — stay quiet
  }

  if (claimed(stamp)) return null;

  const lines = axes.slice(0, MAX_AXES).map((a) => {
    const ruling = String(a.ruling ?? '').trim();
    const clipped = ruling.length > RULING_CHARS ? `${ruling.slice(0, RULING_CHARS)}…` : ruling;
    return `- **${a.slug}** — ${clipped}`;
  });
  const more =
    axes.length > MAX_AXES
      ? `\n(${axes.length - MAX_AXES} more — \`guard-decisions scoped-targets --files ${rel}\`)`
      : '';

  return (
    `Decision records already govern \`${rel}\`. These are settled rulings, not suggestions — ` +
    `follow them, or re-open the axis deliberately via \`guard-decisions add <slug> --target … ` +
    `--evidence-change "<what shifted>"\`. Full text: \`guard-decisions show <slug>\`.\n\n` +
    `${lines.join('\n')}${more}`
  );
}

try {
  main();
} catch {
  // An advisory must never be the reason an edit fails.
}
