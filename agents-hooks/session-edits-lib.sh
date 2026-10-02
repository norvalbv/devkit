#!/bin/bash
# Sourced library — per-session edits ledger shared by the agents-hooks scripts.
#
# WHY: the Stop hooks (lint-check, knip-check, decision-stop-check) must only report errors
# for files THIS session edited — in a shared checkout, a session that merely replied to the
# user otherwise gets blocked at stop by a parallel session's in-flight breakage.
# format-after-edit.sh WRITES the ledger on every Edit/Write/MultiEdit; the Stop hooks READ
# it and filter their tool output down to ledger files. The commit/ship gate chain stays
# repo-wide — this scoping applies to in-flight chats only.
#
# Callers source this best-effort and FAIL-OPEN when it is absent (`sync-hooks --only` can
# install a hook without this lib): `declare -F session_edits_file &>/dev/null || exit 0`.
# Pure bash + awk, bash-3.2 compatible (no mapfile). Only js_eval reaches a JS runtime.

# Echo the ledger path for the session in the hook payload ($1 = raw stdin JSON).
# Caller must already be cd'd to the repo root — REPO_KEY is keyed on `pwd -P`, matching
# decision-stop-check's snooze-file scheme (ephemeral session data lives in $TMPDIR; real
# session_ids are globally-unique, and the repo key stops the 'unknown' fallback crossing repos).
session_edits_file() {
  local sid repo_key
  sid=$(echo "$1" | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
  repo_key=$(pwd -P | cksum | cut -d' ' -f1)
  echo "${TMPDIR:-/tmp}/devkit-session-edits/${repo_key}-${sid:-unknown}"
}

# Echo a CLEAN copy (mktemp path; caller rm's it) of the raw ledger at $1: deduped, blanks
# stripped, still-existing files only. Echoes nothing when no files remain. Blank-stripping is
# load-bearing: an empty pattern line would match EVERY output line and reintroduce exactly
# the repo-wide reporting this scoping removes.
clean_session_ledger() {
  [ -f "$1" ] || return 0
  local tmp f
  tmp=$(mktemp "${TMPDIR:-/tmp}/devkit-session-ledger.XXXXXX") || return 0
  while IFS= read -r f; do
    [ -n "$f" ] && [ -f "$f" ] && printf '%s\n' "$f" >> "$tmp"
  done < <(sort -u "$1")
  if [ -s "$tmp" ]; then echo "$tmp"; else rm -f "$tmp"; fi
}

# Filter tool output (stdin) to the blocks belonging to session-edited files ($1 = a CLEAN
# ledger from clean_session_ledger). Block-aware, not line-grep: eslint's stylish formatter
# puts the path on a HEADER line with the error rows indented below it — plain grep would
# keep the header and drop every error row. Rules:
#   - normalize a line by stripping a leading repo prefix (logical or physical pwd) or ./
#   - a NON-indented line containing a ledger path with boundary chars on both sides
#     (so a.mts never matches a.mts.bak) opens a matched block and prints
#   - indented lines print only inside a matched block; other non-indented lines close it
# Handles eslint-stylish (header + indented rows), plain tsc (`path(1,2): error …` per line),
# and knip rows (path leading or trailing). Section headers without a path are dropped —
# calling hooks add their own one-line preamble.
# ponytail: '/' is accepted as a before-boundary so absolute mid-line paths match a relative
# ledger entry; a same-suffix path in a nested dir can over-match (over-report, never a miss).
filter_output_to_session_files() {
  awk -v pl="$(pwd)/" -v pp="$(pwd -P)/" '
    function boundary_match(line, p,   i, b, a) {
      i = index(line, p)
      if (i == 0) return 0
      b = (i == 1) ? "" : substr(line, i - 1, 1)
      a = substr(line, i + length(p), 1)
      if (b != "" && b != " " && b != "\t" && b != "(" && b != "\"" && b != "/") return 0
      if (a != "" && a != " " && a != "\t" && a != ":" && a != "(" && a != ")" && a != "\"" && a != ",") return 0
      return 1
    }
    NR == FNR { if ($0 != "") paths[$0] = 1; next }
    {
      norm = $0
      if (index(norm, pl) == 1) norm = substr(norm, length(pl) + 1)
      else if (index(norm, pp) == 1) norm = substr(norm, length(pp) + 1)
      if (index(norm, "./") == 1) norm = substr(norm, 3)
      if ($0 ~ /^[ \t]/) { if (matched) print; next }
      matched = 0
      for (p in paths) if (boundary_match(norm, p)) { matched = 1; break }
      if (matched) print
    }
  ' "$1" -
}

# ---- Package-manager runner (sc-1054) ----------------------------------------------------------
# The Stop hooks run the consumer's OWN npm-scripts, so they must run them with the consumer's own
# package manager — a hard bun requirement silently skipped every npm/pnpm/yarn repo without bun.
# Hooks synced by `sync-hooks --only` can meet an older copy of this lib that predates these
# helpers; each hook defines bun-only fallbacks for that case.

# Evaluate JS ($1) for a package.json probe. bun FIRST, node only when bun is absent: sc-1043 found a
# bare node probe silently skipping a bun-only toolchain. Returns 1 when neither runtime exists.
js_eval() {
  if command -v bun &>/dev/null; then
    bun -e "$1"
  elif command -v node &>/dev/null; then
    node -e "$1"
  else
    return 1
  fi
}

# Echo the consumer's package manager (bun|pnpm|yarn|npm), or nothing when the resolved one is not
# installed — callers fail open rather than run a manager the repo does not use. Order:
# package.json#packageManager (corepack's own signal; a mismatch fails under corepack strict), then
# the lockfile ladder cli/lib/ship/dependency-preflight.mts uses, then bun if present, else npm.
resolve_pm() {
  local pm
  pm=$(js_eval "const p=require('./package.json').packageManager;process.stdout.write(typeof p==='string'?p.split('@')[0]:'')" 2>/dev/null)
  case "$pm" in
    bun | pnpm | yarn | npm) ;;
    *)
      if [ -f bun.lock ] || [ -f bun.lockb ]; then
        pm=bun
      elif [ -f pnpm-lock.yaml ]; then
        pm=pnpm
      elif [ -f yarn.lock ]; then
        pm=yarn
      elif [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then
        pm=npm
      elif command -v bun &>/dev/null; then
        pm=bun
      else
        pm=npm
      fi
      ;;
  esac
  command -v "$pm" &>/dev/null && echo "$pm"
}

# Run npm-script $2 with manager $1. A Stop hook is non-interactive, so a corepack shim must never
# stop to ask before downloading the pinned manager.
pm_run() {
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$1" run "$2"
}
