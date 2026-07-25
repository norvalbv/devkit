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
# Exit 0 = allow, exit 2 = block (Claude Code's PreToolUse block signal, and a code husky can test).
# Fail-OPEN on tooling absence (no fallow, no node, no config, fallow too old); fail-CLOSED only on
# a fallow run that actually produced a verdict.

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
