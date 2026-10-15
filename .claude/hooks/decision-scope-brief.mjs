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
 * `permissionDecision`. Claude Code's docs currently disagree about whether PreToolUse honours
 * `additionalContext` (the hooks reference shows it; the SDK reference calls it PostToolUse-only), so
 * this is written to be correct either way: if the platform surfaces it, the agent gets the ruling; if
 * it ignores it, the hook is a silent no-op. What it must never do is block an edit or return
 * `permissionDecision: "allow"` — the latter would auto-approve every write and quietly strip the
 * user's permission prompts, which is a far worse outcome than a missed hint.
 *
 * Repetition is the other way an advisory dies: a brief re-shown on all thirty edits to one file is
 * noise an agent learns to skip. Each (session, file) is briefed at most once.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const MUTATING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
const PATH_KEYS = ['file_path', 'path', 'target_file', 'target_path'];
/** Keep a brief short enough to be read: the ruling is the payload, the rest is a pointer. */
const RULING_CHARS = 320;
const MAX_AXES = 3;

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

function filePathOf(input) {
  const ti = input?.tool_input ?? {};
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

/** The ONLY output channel. Advisory by construction: additionalContext, never permissionDecision. */
function emit(text) {
  process.stdout.write(
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } })}\n`,
  );
}

function main() {
  const input = readInput();
  if (!input || !MUTATING_TOOLS.has(input.tool_name)) return;
  const file = filePathOf(input);
  if (!file) return;

  const root = workspaceRoot(input);
  const rel = path.isAbsolute(file) ? path.relative(root, file) : file;
  // Outside the project (or above it) is not ours to brief on.
  if (!rel || rel.startsWith('..')) return;

  const tool = input.tool_name;
  const stamp = stampPath(input.session_id, root, rel);
  const briefedAt = claimedAt(stamp);
  if (briefedAt !== null) {
    // Briefed already, so no retrieval. Only the first return to the file is recorded, with its age.
    const bin = claimed(`${stamp}.again`) ? null : resolveBin(root);
    if (bin) {
      const secs = Math.max(0, Math.round((Date.now() - briefedAt) / 1000));
      spawnSync(bin, ['scoped-targets', '--files', rel, '--brief-again', `${tool},${secs}`], {
        cwd: root,
        stdio: 'ignore',
        timeout: 10_000,
      });
    }
    return;
  }

  const bin = resolveBin(root);
  if (!bin) return;

  const spec = `${tool},${MAX_AXES},${RULING_CHARS}`;
  const run = spawnSync(bin, ['scoped-targets', '--files', rel, '--brief', spec], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
  });
  // CAUSE-AGNOSTIC. Anything other than "exit 0 carrying a JSON array" means retrieval DID NOT RUN:
  // a spawn timeout (status null), a non-zero exit, empty stdout from a command whose every path
  // writes JSON, or output that does not parse to an array. Only an EMPTY array is the quiet case —
  // that is retrieval running and answering "nothing governs". These were one branch and they are
  // not one fact: staying silent for an outage reads to an agent as a clean bill of health, which is
  // the failure this hook exists to prevent.
  let axes = null;
  if (run.status === 0 && run.stdout?.trim()) {
    try {
      const parsed = JSON.parse(run.stdout);
      if (Array.isArray(parsed)) axes = parsed;
    } catch {
      // axes stays null — malformed output is an outage, not an answer.
    }
  }
  if (axes === null) {
    // A sentinel key, never a relative path: the notice fires once per session WITHOUT burning this
    // file's brief slot, so the first governed edit after the tool is fixed is still briefed.
    if (claimed(stampPath(input.session_id, root, '\u0000retrieval-unavailable'))) return;
    emit(
      `Decision retrieval DID NOT RUN for \`${rel}\` — \`guard-decisions scoped-targets\` failed, so ` +
        `this edit is UNBRIEFED, not ungoverned. Do not read the absence of a brief as "nothing rules ` +
        `here". Check by hand before deciding: list the decisions directory (guard.config.json → ` +
        `\`decisionsDir\`, default \`docs/decisions/\`) and grep it for \`**Scope:**\` globs covering this ` +
        `path. Diagnose with \`guard-decisions scoped-targets --files ${rel}\`.`,
    );
    return;
  }
  if (axes.length === 0) return; // nothing governs this file — stay quiet

  if (claimed(stamp)) return;

  const lines = axes.slice(0, MAX_AXES).map((a) => {
    const ruling = String(a.ruling ?? '').trim();
    const clipped = ruling.length > RULING_CHARS ? `${ruling.slice(0, RULING_CHARS)}…` : ruling;
    return `- **${a.slug}** — ${clipped}`;
  });
  const more =
    axes.length > MAX_AXES
      ? `\n(${axes.length - MAX_AXES} more — \`guard-decisions scoped-targets --files ${rel}\`)`
      : '';

  const brief =
    `Decision records already govern \`${rel}\`. These are settled rulings, not suggestions — ` +
    `follow them, or re-open the axis deliberately via \`guard-decisions add <slug> --target … ` +
    `--evidence-change "<what shifted>"\`. Full text: \`guard-decisions show <slug>\`.\n\n` +
    `${lines.join('\n')}${more}`;

  emit(brief);
}

try {
  main();
} catch {
  // An advisory must never be the reason an edit fails.
}
