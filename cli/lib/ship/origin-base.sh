#!/usr/bin/env bash
# What can legally be a PR base here, and what to say when nothing can.
#
# Why a file of its own: three callers need the same answer at three different moments — the
# self-checkout remedy (before any network), ship's pre-push base refusal, and the post-push
# PR-create failure — and before sc-2261 each of them guessed separately. The recovery hint printed
# after a failed `gh pr create` re-proposed the very base that had just failed, which is how an agent
# following it verbatim retried into the same error.
#
# ERREXIT: every command substitution here is OR-guarded. The callers run under `set -euo pipefail`,
# where a bare `X=$(git ...)` propagates git's exit status — and `symbolic-ref` on an absent
# refs/remotes/origin/HEAD exits 128, which would kill the refusal these functions exist to print.

# ship_shell_quote <string>
# POSIX single-quoting for a value that is about to be printed INSIDE a copyable command. Wrapping in
# quotes is not enough on its own: git permits an apostrophe in a ref name (`release/o'neil`), which
# would close the quote and leave the rest unrunnable — and leaving names bare is worse still, since
# `$`, backticks and parentheses are legal too and a remote-supplied name would then execute as the
# operator. Each embedded quote becomes '\'' , the only construction that survives both.
ship_shell_quote() {
  printf "'%s'\n" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

# ship_truthy <value>
# devkit's GUARD_*/DEVKIT_* flag truthiness, in shell. Mirrors envBool/envFlag in
# gate-engine/config.mts: empty, "0", "false" or "no" (any case, surrounding whitespace ignored) is
# OFF; anything else is ON.
#
# Worth a function rather than a `[ -n "$X" ]` at each site. Every other devkit surface reads
# GUARD_X=0 as OFF, so a bare non-empty test lets an operator or CI profile that exports a flag as
# "0" — meaning disabled — silently DISABLE the gate instead. A guard that disappears when someone
# spells "off" the way the rest of the tool spells it is worse than no guard, because the run still
# looks guarded.
ship_truthy() {
  local v=${1:-}
  v=${v#"${v%%[![:space:]]*}"}
  v=${v%"${v##*[![:space:]]}"}
  case "$(printf '%s' "$v" | tr '[:upper:]' '[:lower:]')" in
    '' | 0 | false | no) return 1 ;;
    *) return 0 ;;
  esac
}

# ship_origin_default_branch <repo>
# Origin's default branch, resolved LOCALLY (no network). Echoes nothing when it cannot be known.
ship_origin_default_branch() {
  local repo=$1 target= cand
  target=$(git -C "$repo" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null) || target=
  # Two ways this symref lies, and both must be rejected before it is trusted. It can legally target
  # ANOTHER remote -- refs/remotes/upstream/main on a fork -- which is not an origin branch at all;
  # and it is LOCAL with nothing pruning it, so after origin's default is renamed or deleted it keeps
  # naming a ref that is gone. Neither is an error to report: fall through to the tiers below.
  case "$target" in
    origin/*) git -C "$repo" show-ref --verify -q "refs/remotes/$target" || target= ;;
    *) target= ;;
  esac
  if [ -z "$target" ]; then
    for cand in main master; do
      if git -C "$repo" show-ref --verify -q "refs/remotes/origin/$cand"; then target="origin/$cand"; break; fi
    done
  fi
  [ -z "$target" ] || printf '%s\n' "${target#origin/}"
}

# ship_origin_ancestor_branch <repo> [head] [for-each-ref filters...]
# The NEAREST branch on origin that <head> sits on top of, as `<oid> <name>`. Echoes nothing — and
# returns 1 — when no ref under refs/remotes/origin is an ancestor of it. Extra filters narrow the
# candidates (ship_base_contains_branch_point passes --no-merged/--contains). `head` defaults to HEAD;
# a caller that has already PINNED the commit it is reasoning about must pass that oid, because a
# shared checkout's HEAD moves under it and the two answers would then describe different lines.
#
# Split out of ship_origin_base_candidate for sc-2357. That function answers "a branch this checkout
# could switch to and then ship against", which has a second tier: when nothing is an ancestor it
# falls through to origin's DEFAULT. That fall-through is the right answer to its question and the
# wrong answer to this one — a default branch the work does not sit on has no branch point, so a
# caller reasoning about ancestry would be handed a commit HEAD was never built on. Callers that need
# "what is this work actually built on" must be able to get NO answer, which is what this tier does.
#
# LOCAL ONLY, deliberately: no ls-remote proof. The oid is for an ancestry decision, not for printing,
# and ship's base check consults it on every --base run where the happy path must cost no network.
# Every caller that goes on to PRINT the name proves it with ship_origin_branch_exists first.
ship_origin_ancestor_branch() {
  local repo=$1 head=${2:-HEAD} ref
  # NEAREST ancestor, not the first one the scan meets. for-each-ref is lexicographic, and `main` is
  # normally an ancestor of `release` — so taking the first match would answer `main` for work cut
  # from `release` and retarget the PR at a branch it does not belong on. Distance is the number of
  # commits HEAD carries beyond the candidate; the smallest wins, and a tie keeps the
  # lexicographically first for determinism.
  local best= best_n= best_oid= n oid
  # objectname comes out of the SAME enumeration as the refname, and every check below is made
  # against that oid rather than re-reading the ref. A concurrent fetch can still move the ref, but it
  # can no longer make ancestry, distance and identity describe three different commits.
  #
  # `--merged HEAD` does the ancestry filtering inside the ONE enumeration git already runs, replacing
  # a `merge-base --is-ancestor` spawn per origin ref. That cost is why base-drift/resolve-base.mts
  # declined to port this scan, and why sc-2357 could not afford it on ship's hot path until now: a
  # repo with a thousand origin refs paid a thousand processes to learn what one for-each-ref knows.
  # rev-list then runs only over the ancestors, which is normally a handful.
  #
  # `--merged=<oid>`, attached, never `--merged <oid>`: the option's argument is documented optional,
  # so the detached spelling reads as a REF PATTERN in some parsers and silently leaves the filter on
  # live HEAD — which in a shared checkout is the wrong line, and fails open without a word. (Measured
  # identical on git 2.50.1; the attached form is unambiguous under every reading.)
  while IFS= read -r ref; do
    [ -n "$ref" ] || continue
    oid=${ref%% *}
    ref=${ref#* }
    [ -n "$oid" ] && [ -n "$ref" ] || continue
    [ "$ref" != "refs/remotes/origin/HEAD" ] || continue
    n=$(git -C "$repo" rev-list --count "$oid..$head" 2>/dev/null) || continue
    [ -n "$n" ] || continue
    if [ -z "$best_n" ] || [ "$n" -lt "$best_n" ]; then
      best_n=$n
      best=${ref#refs/remotes/origin/}
      best_oid=$oid
    fi
  done < <(git -C "$repo" for-each-ref "--merged=$head" "${@:3}" --format='%(objectname) %(refname)' refs/remotes/origin 2>/dev/null)
  [ -n "$best" ] || return 1
  # A ref name cannot contain a space, so one space separates the two fields unambiguously.
  printf '%s %s\n' "$best_oid" "$best"
}

# ship_suggested_base_memo <repo> [head]
# ship_suggested_base resolved ONCE per pinned head for this ship process; the answer lands in the
# global SHIP_SUGGESTED_ANSWER. A refusal can print its remedy up to three times (the preflight, the
# hook-dir block, the resume refusal) plus ship_suggest_base's advisory, and re-resolving each time
# would let a push to origin between them print two different --base values in one refusal. Each
# reuse is still re-proven against origin before it is printed. MUST be called outside `$(...)`, or
# the memo dies with the subshell.
ship_suggested_base_memo() {
  local head=${2-HEAD} kind name oid ok=0
  if [ "${SHIP_SUGGESTED_MEMO_SET-}" = 1 ] && [ "${SHIP_SUGGESTED_MEMO_HEAD-}" = "$head" ]; then
    # Reused, so re-proven NOW against origin, pinned to the oid it was first proven at. A base that
    # fails is withdrawn for the rest of this refusal: later prints say "choose the base yourself"
    # rather than switch to a second, different base.
    [ -n "${SHIP_SUGGESTED_PROVEN-}" ] || return 0
    read -r kind name oid <<EOF
$SHIP_SUGGESTED_PROVEN
EOF
    case "$kind" in
      default) ship_origin_default_still "$1" "$name" "$oid" && ok=1 ;;
      # A guess stands only while origin's HEAD is STILL unreadable: once origin names a default, the
      # cached ladder answer would be announced as a default origin no longer has.
      guess) [ -z "$(ship_origin_head_branch "$1")" ] && ship_origin_branch_exists "$1" "$name" "$oid" && ok=1 ;;
      *) ship_origin_branch_exists "$1" "$name" "$oid" && ok=1 ;;
    esac
    [ "$ok" = 1 ] || { SHIP_SUGGESTED_PROVEN=; SHIP_SUGGESTED_ANSWER=; }
    return 0
  fi
  SHIP_SUGGESTED_PROVEN=$(ship_suggested_base_proven "$1" "$head") || SHIP_SUGGESTED_PROVEN=
  SHIP_SUGGESTED_ANSWER=
  if [ -n "$SHIP_SUGGESTED_PROVEN" ]; then
    SHIP_SUGGESTED_ANSWER=${SHIP_SUGGESTED_PROVEN% *}
    case "$SHIP_SUGGESTED_ANSWER" in guess\ *) SHIP_SUGGESTED_ANSWER="default ${SHIP_SUGGESTED_ANSWER#guess }" ;; esac
  fi
  SHIP_SUGGESTED_MEMO_HEAD=$head
  SHIP_SUGGESTED_MEMO_SET=1
}

# ship_origin_base_candidate <repo> [head]
# A branch on origin that this checkout could switch to AND then ship against — the bare name, or
# nothing. A thin view over ship_suggested_base, so the rename remedy and ship's base advisory can never
# name different bases (sc-3409: they once printed '0.0.8' and 'main' two lines apart). Echoes nothing
# when no base can be proven, because the caller must then print a placeholder: naming a branch that
# does not exist is the failure mode this whole file exists to end.
ship_origin_base_candidate() {
  local answer=
  # `-` not `:-`: an explicitly EMPTY pin is cannot-tell and must reach the resolver as such.
  answer=$(ship_suggested_base "$1" "${2-HEAD}") || answer=
  [ -z "$answer" ] || printf '%s\n' "${answer#* }"
}

# ship_suggested_base <repo> [head]
# The PR base to SUGGEST for <head>, as `ancestor <name>` or `default <name>`; nothing (exit 1) when no
# branch on origin can be proven. The kind picks the printed sentence: an ancestor is never announced
# as the repository's default (sc-2357). Order: the nearest origin ancestor of <head>, unless origin's
# default, as it is on origin NOW, contains that ancestor's tip (sc-3409: an advanced main drops out of
# --merged and leaves a stale release branch as "nearest"); then the ancestor; then the default.
# Every name is proven on origin first. Why the rule lives here and not in ship_origin_ancestor_branch,
# and its accepted cost, are the 2026-10-01 Target in docs/decisions/ship-base-must-contain-branch-point.md.
# An EMPTY head is cannot-tell: the ancestor tier is skipped rather than re-reading live HEAD.
ship_suggested_base() {
  local answer=
  answer=$(ship_suggested_base_proven "$1" "${2-HEAD}") || return 1
  answer=${answer% *}
  # A local-ladder guess is still announced as origin's default, as it always was.
  case "$answer" in guess\ *) answer="default ${answer#guess }" ;; esac
  printf '%s\n' "$answer"
}

# ship_suggested_base_proven <repo> [head]
# ship_suggested_base with the oid each answer was proven at: `ancestor|default|guess <name> <oid>`.
# `guess` is the local main/master ladder's answer (origin's HEAD unreadable, nothing an ancestor).
ship_suggested_base_proven() {
  local repo=$1 head=${2-HEAD} nearest= cand= cand_oid= def= def_remote= contains= verdict= def_oid=
  if [ -n "$head" ]; then
    nearest=$(ship_origin_ancestor_branch "$repo" "$head") || nearest=
  fi
  if [ -n "$nearest" ]; then
    cand_oid=${nearest%% *}
    cand=${nearest#* }
  fi
  # Origin's own HEAD over the network first; the local symref/main/master ladder when that fails.
  def=$(ship_origin_head_branch "$repo") || def=
  def_remote=$def
  [ -n "$def" ] || def=$(ship_origin_default_branch "$repo") || def=

  # Only a default ORIGIN named may outrank an ancestor; the local ladder is a cache and stays a
  # last-resort guess below.
  if [ -n "$cand" ] && [ -n "$def_remote" ]; then
    verdict=$(ship_origin_default_contains "$repo" "$def" "$cand_oid")
    contains=${verdict%% *}
    def_oid=${verdict#* }
    # Re-proven pinned to the oid containment was judged against, immediately before it is printed.
    # A default that moved in between is never suggested by ANY tier below: its new tip is unjudged.
    if [ "$contains" = yes ] && ship_origin_default_still "$repo" "$def" "$def_oid"; then
      printf 'default %s %s\n' "$def" "$def_oid"
      return 0
    fi
    [ "$contains" != yes ] || contains=moved
    # The default IS the ancestor but was moved off this work's line: naming it is no remedy.
    [ "$cand" != "$def" ] || [ "$contains" = unknown ] || return 1
  fi
  # Pinned to the oid ancestry was decided against: existence alone would survive a force-push that
  # moved the branch off the history <head> was shown to sit on.
  if [ -n "$cand" ] && ship_origin_branch_exists "$repo" "$cand" "$cand_oid"; then
    printf 'ancestor %s %s\n' "$cand" "$cand_oid"
    return 0
  fi
  [ "$contains" != moved ] || return 1
  # No usable ancestor. When there WAS a candidate (it just could not be proven), only a default
  # origin names right now -- re-proven in one advertisement, and not the candidate's own line, whose
  # tip is exactly what failed -- may stand in; a cached name never does. Named as origin's default,
  # never as what the work sits on (sc-2261: never go silent while a tier can still answer).
  if [ -n "$cand" ]; then
    # Containment was judged here, so the default carries an oid ("no <oid>"); it is re-proven pinned
    # to it. "unknown" carries none, and a default nobody could read is not offered.
    if [ -n "$def_remote" ] && [ "$cand" != "$def" ] && [ "$contains" = no ] \
      && ship_origin_default_still "$repo" "$def" "$def_oid"; then
      printf 'default %s %s\n' "$def" "$def_oid"
      return 0
    fi
    return 1
  fi
  if [ -n "$def_remote" ]; then
    # Nothing was judged (no candidate), so there is no oid to pin: it must still be origin's HEAD.
    def_oid=$(ship_origin_branch_oid "$repo" "$def") || return 1
    ship_origin_default_still "$repo" "$def" "$def_oid" || return 1
    printf 'default %s %s\n' "$def" "$def_oid"
    return 0
  fi
  # Nothing on origin is an ancestor and origin's HEAD cannot be read (a `git init` + `remote add`
  # repo): the local ladder's guess, proven to exist, is the last honest answer.
  if [ -n "$def" ] && def_oid=$(ship_origin_branch_oid "$repo" "$def"); then
    printf 'guess %s %s\n' "$def" "$def_oid"
    return 0
  fi
  return 1
}

# ship_origin_branch_oid <repo> <branch>
# The oid origin advertises for refs/heads/<branch> right now; nothing (exit 1) when it has none.
ship_origin_branch_oid() {
  local line=
  line=$(git -C "$1" ls-remote --exit-code --heads origin "refs/heads/$2" 2>/dev/null) || return 1
  line=${line%%[[:space:]]*}
  [ -n "$line" ] || return 1
  printf '%s\n' "$line"
}

# ship_origin_default_still <repo> <default> <oid>
# Is <default> STILL origin's default, AND still at <oid>? Both read from ONE ls-remote advertisement,
# so a HEAD repointed or a default force-pushed since it was judged cannot pass. A failed read is "no".
# Matched in-shell, never piped into `grep -q`: under pipefail its early exit SIGPIPEs the writer.
ship_origin_default_still() {
  local repo=$1 def=$2 oid=$3 out= nl=$'\n' tab=$'\t'
  out=$(git -C "$repo" ls-remote --symref origin HEAD "refs/heads/$def" 2>/dev/null) || return 1
  case "$nl$out$nl" in *"${nl}ref: refs/heads/$def${tab}HEAD$nl"*) ;; *) return 1 ;; esac
  case "$nl$out$nl" in *"$nl$oid${tab}refs/heads/$def$nl"*) return 0 ;; *) return 1 ;; esac
}

# ship_origin_default_contains <repo> <default> <oid>
# Does origin's default, AS IT IS ON ORIGIN NOW, contain <oid>? Echoes `yes <default-oid>`,
# `no <default-oid>` or `unknown` — the oid so the caller can re-prove the answer pinned to it.
# Judged only against the commit ls-remote names, never refs/remotes/origin/<default>: that cache
# misses a force-push made from another clone, and "contains" against it is a stale fact. A commit
# not yet here is fetched by name with --refmap= (no ref is written) and --no-write-fetch-head, so a
# shared checkout's refs are untouched. Anything that fails — origin gone, old git, shallow — is unknown.
ship_origin_default_contains() {
  local repo=$1 def=$2 oid=$3 line= def_oid= rc=0
  line=$(git -C "$repo" ls-remote --exit-code --heads origin "refs/heads/$def" 2>/dev/null) || line=
  def_oid=${line%%[[:space:]]*}
  if [ -z "$def_oid" ]; then echo unknown; return 0; fi
  if ! git -C "$repo" cat-file -e "$def_oid^{commit}" 2>/dev/null; then
    git -C "$repo" fetch -q --no-tags --no-write-fetch-head --refmap= origin "refs/heads/$def" \
      >/dev/null 2>&1 || true
    git -C "$repo" cat-file -e "$def_oid^{commit}" 2>/dev/null || { echo unknown; return 0; }
  fi
  git -C "$repo" merge-base --is-ancestor "$oid" "$def_oid" >/dev/null 2>&1 || rc=$?
  case "$rc" in
    0) echo "yes $def_oid" ;;
    1) echo "no $def_oid" ;;
    *) echo unknown ;;
  esac
}

# ship_origin_branch_exists <repo> <branch> [expected-oid]
# Does origin have this BRANCH right now, and — when an oid is given — is it still the commit the
# caller reasoned about? Fully qualified so a tag cannot answer for a branch. Strict about the exit
# code: ls-remote returns non-zero for "absent" (2) AND for auth/network trouble, so only 0 is proof
# of presence; anything else means "cannot say", which must read as absent, because advertising an
# unverified branch is the failure being prevented.
#
# The oid check is what makes an ancestry answer trustworthy. Ancestry is decided against the LOCAL
# remote-tracking ref, which is a cache; a force-push between that decision and this probe leaves the
# branch existing but no longer the commit HEAD was shown to sit on top of, and an existence-only
# check would then recommend an unrelated PR base.
ship_origin_branch_exists() {
  local repo=$1 br=$2 want=${3:-} line rc
  [ -n "$br" ] || return 1
  line=$(git -C "$repo" ls-remote --exit-code --heads origin "refs/heads/$br" 2>/dev/null)
  rc=$?
  [ "$rc" -eq 0 ] || return 1
  [ -n "$want" ] || return 0
  case "$line" in "$want"*) return 0 ;; *) return 1 ;; esac
}

# ship_origin_head_branch [repo]
# Origin's default branch straight from the REMOTE. Preferred over the local refs/remotes/origin/HEAD
# whenever the network is already in hand: that local symref is absent in every `git init` + `git
# remote add` repo, and stale in a clone whose default branch was renamed. Echoes nothing on failure.
#
# Takes the repo like its siblings rather than reading the caller's cwd. ship_suggest_base is handed
# a repo path, so a cwd-bound `origin` here answers about a DIFFERENT repository whenever the two
# differ — recommending one checkout's default branch as another's base.
ship_origin_head_branch() {
  local repo=${1:-.} line=
  line=$(git -C "$repo" ls-remote --symref origin HEAD 2>/dev/null | sed -n 's#^ref: refs/heads/\([^[:space:]]*\)[[:space:]]*HEAD$#\1#p') || line=
  [ -z "$line" ] || printf '%s\n' "$line"
}

. "$(dirname "${BASH_SOURCE[0]}")/base-ancestry/branch-point.sh"
# ship_suggest_base <owner/repo> [repo-path] [pinned-head]
# One advisory line naming a base that DOES exist on origin. Never names the base that just failed:
# repeating it is what turned a recoverable ship into a loop. Prints the honest "you must choose"
# line when neither tier can answer, rather than inventing a name.
#
# `<owner/repo>` is a GitHub slug for the message, not a path; `[repo-path]` is the checkout the
# ancestry tier reads, defaulting to the caller's cwd.
#
# ANCESTRY FIRST (sc-2357). This hint is printed to a checkout whose branch is not on origin — every
# provisioned worktree scratch branch — so it is the sentence that chooses the --base an agent then
# passes. Answering origin's DEFAULT there is how a worktree cut from a release line gets told to
# ship into main: the base is then unrelated to the work, ship's gate worktree is cut from another
# line, and the resulting size/clone/structure failures are about neither the change nor the base.
# ship_origin_ancestor_branch answers what the work is actually built on, and the two tiers say
# DIFFERENT sentences on purpose — a candidate must never be announced as the repository's default.
ship_suggest_base() {
  local repo=$1 root=${2:-.} head=${3:-} answer=
  # An EMPTY pin is cannot-tell, and the ancestor tier is skipped rather than re-reading live HEAD.
  # Falling back would name a branch derived from a commit this run never reasoned about — in a
  # shared checkout, a sibling's — which is the unusable remedy this whole file exists to end. The
  # default tier does not depend on HEAD, so the caller still gets a name.
  ship_suggested_base_memo "$root" "$head"
  answer=$SHIP_SUGGESTED_ANSWER
  case "$answer" in
    # The copyable half goes through the quoter; the prose half stays readable.
    ancestor\ *) echo "  the branch this work sits on top of is '${answer#* }' — pass --base $(ship_shell_quote "${answer#* }") if that is the intended target." ;;
    default\ *) echo "  origin's default branch is '${answer#* }' — pass --base $(ship_shell_quote "${answer#* }") if that is the intended target." ;;
    *) echo "  no branch on origin could be resolved as a base${repo:+ for $repo}; choose the base yourself and pass --base <branch>." ;;
  esac
}

# Bound remote git: the shared supervisor terminates the whole git/helper process group on expiry.
bounded_remote_git() {
  # .mts in source, built .mjs in an installed consumer (the gate-config-paths dual-ext idiom).
  local dir supervisor out status
  dir="$(dirname "${BASH_SOURCE[0]}")/review/process"
  supervisor="$dir/gate-supervisor.mts"
  [ -f "$supervisor" ] || supervisor="$dir/gate-supervisor.mjs"
  # A silent 124 is a stall a fresh connection clears; output means git answered, so never re-run it.
  for _ in 1 2; do
    status=0
    # -c: a detached auto-gc/maintenance inherits the supervisor's ownership token and is reaped as a
    # leaked tree, turning a finished fetch into 124 (sc-3761). Remote git never needs maintenance.
    out=$(node "$supervisor" "${DEVKIT_REMOTE_TIMEOUT_SECONDS:-60}" -- git -c gc.auto=0 -c maintenance.auto=false "$@") || status=$?
    [ "$status" -eq 124 ] && [ -z "$out" ] || break
  done
  [ -z "$out" ] || printf '%s\n' "$out"
  return "$status"
}

# usage: ship_pin_origin_base_failed <message> <git-cmd> <status> <errfile>
# Name a failed remote step with git's own reason, so a lock or timeout never reads as a missing branch.
ship_pin_origin_base_failed() {
  if [ "$3" -eq 124 ]; then
    echo "$1 ($2 exit 124: no clean finish within the ${DEVKIT_REMOTE_TIMEOUT_SECONDS:-60}s bound) — machine load or network; re-run ship, or raise DEVKIT_REMOTE_TIMEOUT_SECONDS" >&2
  else
    echo "$1 ($2 exit $3)" >&2
  fi
  sed 's/^/  /' "$4" >&2
}

# usage: ship_pin_origin_base <root> <ref> <label> [absent-msg] — print origin's <ref> oid. The fetch
# writes no ref, so a sibling fetch holding refs/remotes/origin/<ref>.lock cannot fail it.
ship_pin_origin_base() {
  local root=$1 base_ref=$2 label=$3 advert err pinned="" attempt=0 status oid ref extra lines
  local absent=${4:-"--base: no branch origin/$2 (a PR base must be a remote branch — not a sha or a tag)"}
  local candidate_oid candidate_ref candidate_extra
  advert=$(mktemp "${TMPDIR:-/tmp}/ship-base-advertisement.XXXXXX") || return 1
  err=$(mktemp "${TMPDIR:-/tmp}/ship-base-pin-err.XXXXXX") || { rm -f "$advert"; return 1; }
  # A force-update between ls-remote and fetch can make the advertised object unavailable; retry once.
  while [ "$attempt" -lt 2 ] && [ -z "$pinned" ]; do
    attempt=$((attempt + 1))
    status=0
    bounded_remote_git -C "$root" ls-remote --exit-code --heads origin "refs/heads/$base_ref" > "$advert" 2>"$err" || status=$?
    case "$status" in
      0) ;;
      2) rm -f "$advert" "$err"
         echo "$absent" >&2
         return 1 ;;
      *) ship_pin_origin_base_failed "$label: could not verify origin/$base_ref" ls-remote "$status" "$err"
         rm -f "$advert" "$err"
         return 1 ;;
    esac
    oid="" ref="" extra="" lines=0
    while read -r candidate_oid candidate_ref candidate_extra; do
      lines=$((lines + 1))
      oid=$candidate_oid ref=$candidate_ref extra=$candidate_extra
    done < "$advert"
    if [ "$lines" -ne 1 ] || [ "$ref" != "refs/heads/$base_ref" ] || [ -n "$extra" ]; then
      rm -f "$advert" "$err"
      echo "$label: origin/$base_ref returned an invalid advertised identity; refusing to guess" >&2
      return 1
    fi
    status=0
    bounded_remote_git -C "$root" fetch -q --no-tags --no-write-fetch-head --refmap= origin "refs/heads/$base_ref" 2>"$err" || status=$?
    if [ "$status" -ne 0 ]; then
      ship_pin_origin_base_failed "$label: could not fetch the advertised origin/$base_ref commit" fetch "$status" "$err"
      rm -f "$advert" "$err"
      return 1
    fi
    if git -C "$root" cat-file -e "$oid^{commit}" 2>/dev/null; then pinned=$oid; fi
  done
  rm -f "$advert" "$err"
  [ -n "$pinned" ] || {
    echo "$label: origin/$base_ref moved incompatibly during both pin attempts; retry" >&2
    return 1
  }
  printf '%s\n' "$pinned"
}
