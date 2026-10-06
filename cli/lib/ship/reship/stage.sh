#!/usr/bin/env bash
# Staging for `devkit ship --pr`. Sourced by reship.sh; reads ROOT WT BR BASE CALLER_HEAD REWRITE PATHS.

# reship_stage_paths <script-dir>
# Rewrite: copy each path's CURRENT content over the pinned PR base, or delete it.
# Append: reship/anchor.mts merges what the PR branch changed since the caller's copy; sets ANCHOR_OUT.
reship_stage_paths() {
  local p ra
  if [ "$REWRITE" -eq 0 ]; then
    ra="$1/reship/anchor.mts"; [ -f "$ra" ] || ra="$1/reship/anchor.mjs"
    ANCHOR_OUT=$(mktemp "${TMPDIR:-/tmp}/reship-anchor.XXXXXX")
    node "$ra" --root "$ROOT" --wt "$WT" --branch "$BR" --tip "$BASE" --head "$CALLER_HEAD" \
      --out "$ANCHOR_OUT" -- "${PATHS[@]}"
    return
  fi
  for p in "${PATHS[@]}"; do
    if [ -e "$ROOT/$p" ]; then
      mkdir -p "$WT/$(dirname "$p")"
      cp -Pp "$ROOT/$p" "$WT/$p"
      # -f: a briefed path can be tracked yet sit under a gitignored dir (a tracked dist/), where a
      # plain `git add` stages it but exits nonzero and set -e would abort the re-push.
      git -C "$WT" add -f -- ":(literal)$p"
    else
      # Literal: a glob-named path that is gone must remove only itself, never the files it matches.
      git -C "$WT" rm -q --ignore-unmatch -- ":(literal)$p" || true
    fi
  done
}

# reship_refresh_anchors <script-dir>
# A no-delta append still re-anchors: a copy that already equals the tip must not leave a stale record.
reship_refresh_anchors() {
  local rmw
  [ "$REWRITE" -eq 0 ] && [ -z "${SHIP_DRY_RUN:-}" ] || return 0
  rmw="$1/reconcile-manifest-write.mts"; [ -f "$rmw" ] || rmw="$1/reconcile-manifest-write.mjs"
  node "$rmw" --root "$ROOT" --git-root "$WT" --branch "$BR" --base-sha "$BASE" --tip-sha "$BASE" \
    --anchors "$ANCHOR_OUT" --merge -- "${PATHS[@]}" \
    || echo "reship: reconcile manifest not updated (non-fatal)" >&2
}
