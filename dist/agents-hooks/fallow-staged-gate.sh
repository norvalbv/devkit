#!/usr/bin/env bash
set -euo pipefail

# Fallow commit gate, scoped to the STAGED SET.
#
# devkit decides SCOPE; fallow does detection and attribution ([[fallow-gate-owned-by-fallow]]).
# The whole mechanism is: capture `git diff --cached`, hand it to `fallow audit --diff-stdin`, read
# fallow's own verdict. No re-scoping of fallow's findings — that reimplementation was deleted.
#
# WHY NOT fallow's own agent hook: it resolves its base as the merge-base against the branch
# upstream or the remote default. Measured on fallow 3.6.0 with agent A staging a clean file while
# agent B has unstaged debt in the same tree: bare `fallow audit`, `FALLOW_AUDIT_BASE=HEAD` and
# `--base HEAD` ALL attribute agent B's work as introduced and block agent A; only `--diff-stdin`
# scopes correctly. A ref range cannot express the index, so no configuration achieves this.
#
# NAMED `fallow-staged-gate.sh`, never `fallow-gate.sh`: the latter is fallow's own generated
# script, which `fallow hooks install` overwrites on every run. A same-named devkit file would be
# silently replaced.
#
# Exit 0 = allow, exit 2 = block (Claude Code's PreToolUse block signal).
# Fail-OPEN on non-commit shell commands, malformed hook input, tooling absence (no fallow, no node,
# no config, fallow too old), oversized staged diffs, and unreadable audit output; fail-CLOSED only
# on a real verdict for a `git commit`. Scoping here is essential: a failing staged set must never
# block the `git reset` / `git restore --staged` commands that can make it recoverable.

ROOT="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$ROOT" ]; then
  ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
fi
cd "$ROOT" 2>/dev/null || exit 0

# Self-skip when the consumer has not adopted fallow.
if [ ! -f .fallowrc.jsonc ] && [ ! -f .fallowrc.json ]; then
  exit 0
fi
command -v node >/dev/null 2>&1 || exit 0

# Claude/Codex provide the shell command as tool_input.command; Cursor's beforeShellExecution hook
# provides command at the top level. Run only for a real `git ... commit` invocation: git must begin
# an unquoted shell command segment, global git flags are allowed, and commit must be the first
# non-flag positional. Prose such as `echo git commit` or `echo "; git commit"` therefore stays
# inert. Missing/malformed/unterminated input fails OPEN.
#
# Deliberately NOT matched, all fail OPEN: env-assignment prefixes (`FOO=1 git commit`) and wrapper
# binaries (`env`/`sudo`/`nohup`/`bash -c`). Those commits reach fallow's own git hook instead, so
# the gate under-fires rather than stranding an agent. Every classification error must land on that
# side — see [[fallow-gate-owned-by-fallow]].
SCOPE="$(
  node -e '
const fs = require("node:fs");
let payload;
try { payload = JSON.parse(fs.readFileSync(0, "utf8")); } catch { process.exit(0); }
const command = payload?.tool_input?.command ?? payload?.command;
if (typeof command !== "string") process.exit(0);
const segments = [];
let segment = "";
let quote = "";
let escaped = false;
for (const ch of command) {
  if (escaped) { segment += " "; escaped = false; continue; }
  if (quote) {
    if (ch === quote) quote = "";
    else if (ch === "\\" && quote === "\"") escaped = true;
    segment += " ";
    continue;
  }
  if (ch === "\"" || ch === "\x27") { quote = ch; segment += " "; continue; }
  if (ch === "\\") { escaped = true; segment += " "; continue; }
  if (";&|()\x60\n".includes(ch)) { segments.push(segment); segment = ""; continue; }
  segment += ch;
}
if (quote || escaped) process.exit(0);
segments.push(segment);
const ws = "[\\x20\\t\\r\\n\\f\\v]";
const nonWs = "[^\\x20\\t\\r\\n\\f\\v]";
const flag = `-${nonWs}+`;
const arg = `[^-]${nonWs}*`;
// Only these global flags take a SEPARATE following value; every other flag stands alone. Pairing
// any flag with an optional argument let `--no-pager` swallow the subcommand, so a later literal
// `commit` token landed in subcommand position and blocked read-only queries (sc-1417). The
// `--flag=value` spellings fall through to the standalone branch, which is why they are absent
// here. Mis-classifying either way only ever consumes one extra token and fails OPEN.
const valued =
  "(-C|-c|--git-dir|--work-tree|--namespace|--super-prefix|--attr-source|--config-env|--exec-path)";
const unit = `(${valued}${ws}+${arg}${ws}+|${flag}${ws}+)`;
const gitPrefix = `^${ws}*(command${ws}+)?(${nonWs}*/)?git${ws}+(${unit})*`;
// These top-level actions exit before Git dispatches a subcommand, even if "commit" follows.
const action = new RegExp(
  `${gitPrefix}(-v|--version|-h|--help|--exec-path|--html-path|--man-path|--info-path|--list-cmds=${nonWs}+)(${ws}|$)`,
);
const commit = new RegExp(`${gitPrefix}commit(${ws}|$)`);
if (segments.some((candidate) => !action.test(candidate) && commit.test(candidate))) {
  process.stdout.write("COMMIT");
}
'
)" || exit 0
[ "$SCOPE" = "COMMIT" ] || exit 0

command -v fallow >/dev/null 2>&1 || {
  echo "fallow-staged-gate: fallow not on PATH, skipping." >&2
  exit 0
}

# Version floor. An UNKNOWN FLAG and a genuine config error both exit 2 — indistinguishable — so a
# binary predating --diff-stdin would hard-block every commit. Probe the version and fail OPEN.
FLOOR="${FALLOW_STAGED_GATE_MIN_VERSION:-3.6.0}"
VERSION_RAW="$(fallow --version 2>/dev/null || true)"
VERSION="${VERSION_RAW#fallow }"
VERSION="${VERSION%% *}"
if [ -n "$FLOOR" ] && [ -n "$VERSION" ]; then
  LOWER="$(printf '%s\n%s\n' "$FLOOR" "$VERSION" | sort -V | head -n1)"
  if [ "$LOWER" != "$FLOOR" ]; then
    echo "fallow-staged-gate: fallow $VERSION is below $FLOOR (no --diff-stdin) — skipping, upgrade to gate on staged scope." >&2
    exit 0
  fi
fi

# The staged set, captured WITH git's environment intact: inside a devkit ship the exported
# GIT_DIR/GIT_INDEX_FILE point at the ship worktree's index, and that is precisely the index being
# committed. Flags mirror gate-engine/review/baseline-gate.mts so binary blobs, renames and a
# monorepo subdir all resolve the same way there and here.
DIFF_FILE="$(mktemp)"
FALLOW_OUT="$(mktemp)"
cleanup() { rm -f "$DIFF_FILE" "$FALLOW_OUT"; }
trap cleanup EXIT
git diff --cached --binary --full-index --find-renames --relative >"$DIFF_FILE" 2>/dev/null || true

if [ ! -s "$DIFF_FILE" ]; then
  # Nothing staged: a `git push`, or a deletion-only / pure-rename / binary-only commit. fallow
  # would return pass anyway, after paying for a full audit — say so rather than imply a clean audit.
  echo "fallow-staged-gate: no staged added lines to audit — skipping." >&2
  exit 0
fi

# fallow 3.7.0+ reads at most 10 MiB from --diff-stdin. Above that cap it silently disables
# diff filtering under --quiet and falls back to whole-project attribution — exactly the
# cross-agent over-blocking this staged wrapper exists to prevent. Match the vendor's byte cap and
# fail OPEN rather than hand fallow a payload it will not scope. An unavailable/invalid byte count
# also fails open: without a proven scoped input, there is no safe blockable verdict.
FALLOW_DIFF_STDIN_MAX_BYTES=10485760
DIFF_BYTES="$(wc -c <"$DIFF_FILE" 2>/dev/null | tr -d '[:space:]' || true)"
case "$DIFF_BYTES" in
  '' | *[!0-9]*)
    echo "fallow-staged-gate: could not size the staged diff — skipping (fail-open)." >&2
    exit 0
    ;;
esac
if [ "$DIFF_BYTES" -gt "$FALLOW_DIFF_STDIN_MAX_BYTES" ]; then
  echo "fallow-staged-gate: staged diff is $DIFF_BYTES bytes (cap $FALLOW_DIFF_STDIN_MAX_BYTES) — skipping; fallow would disable staged filtering." >&2
  exit 0
fi

# fallow runs WITHOUT git's environment: its base snapshot is itself a git worktree, and it has
# clobbered a ship worktree's HEAD before (the same reason husky-block.mts wraps it in
# __dk_no_git_env). The diff is already captured, so scrubbing here costs nothing.
env -u GIT_ALTERNATE_OBJECT_DIRECTORIES -u GIT_CONFIG -u GIT_CONFIG_PARAMETERS \
    -u GIT_CONFIG_COUNT -u GIT_OBJECT_DIRECTORY -u GIT_DIR -u GIT_WORK_TREE \
    -u GIT_IMPLICIT_WORK_TREE -u GIT_GRAFT_FILE -u GIT_INDEX_FILE -u GIT_NO_REPLACE_OBJECTS \
    -u GIT_REPLACE_REF_BASE -u GIT_PREFIX -u GIT_SHALLOW_FILE -u GIT_COMMON_DIR \
    -u GIT_GLOB_PATHSPECS -u GIT_NOGLOB_PATHSPECS -u GIT_LITERAL_PATHSPECS -u GIT_ICASE_PATHSPECS \
    fallow audit --diff-stdin --format json --quiet <"$DIFF_FILE" >"$FALLOW_OUT" 2>/dev/null || true

# Gate policy — the one judgement devkit owns. `verdict` alone is NOT a faithful "blockable" signal:
# a duplication-only staged set returns warn (and --gate all does not change that, measured), so an
# introduced clone group would sail through. Both fields below are fallow's own numbers; devkit
# only decides that duplication blocks here.
VERDICT_LINE="$(node -e '
try {
  const a = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const dupes = Number(a?.attribution?.duplication_introduced ?? 0);
  const block = a?.verdict === "fail" || dupes > 0;
  process.stdout.write(`${block ? "BLOCK" : "ALLOW"} ${a?.verdict ?? "unknown"} ${dupes}`);
} catch (e) { process.stdout.write("UNREADABLE"); }
' "$FALLOW_OUT" 2>/dev/null || echo UNREADABLE)"

if [ "$VERDICT_LINE" = "UNREADABLE" ]; then
  echo "fallow-staged-gate: could not read fallow's audit output — skipping (fail-open)." >&2
  exit 0
fi

set -- $VERDICT_LINE
if [ "$1" = "BLOCK" ]; then
  echo "fallow-staged-gate: blocked — the STAGED diff introduces findings (verdict=$2, introduced duplication=$3)." >&2
  # sc-1192's lesson: never block with only a code. Show fallow's own explanation, bounded so a
  # PreToolUse hook cannot flood the agent's context.
  env -u GIT_DIR -u GIT_INDEX_FILE -u GIT_WORK_TREE -u GIT_COMMON_DIR -u GIT_PREFIX \
    fallow audit --diff-stdin --quiet <"$DIFF_FILE" 2>&1 | head -40 >&2 || true
  exit 2
fi

exit 0
