#!/usr/bin/env bash

# JSON string escaping for shell-built telemetry records. Telemetry fields cannot contain control
# characters, so escaping backslash and double quote is sufficient for these bounded path/id fields.
devkit_json_escape() {
  local value=${1//\\/\\\\}
  printf '%s' "${value//\"/\\\"}"
}

# Resolve the version from the devkit package that owns this script. Source mode reaches the root
# package.json; packaged mode reaches dist/package.json. Walk instead of baking in either depth.
devkit_telemetry_version() {
  local directory manifest version
  directory=$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd) || {
    printf '%s' '<0.47.2'
    return
  }
  while [ "$directory" != / ]; do
    manifest="$directory/package.json"
    if [ -f "$manifest" ]; then
      version=$(node -e '
        const fs = require("node:fs");
        const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        if (manifest.name === "@norvalbv/devkit" && typeof manifest.version === "string") {
          process.stdout.write(manifest.version.trim());
        }
      ' "$manifest" 2>/dev/null || true)
      if [ -n "$version" ]; then
        printf '%s' "$version"
        return
      fi
    fi
    directory=${directory%/*}
    [ -n "$directory" ] || directory=/
  done
  printf '%s' '<0.47.2'
}

# Parity with run-context.mts parentSessionId(): same env vars + predicate, key omitted otherwise.
# Explicit character lists (not ranges or classes) keep the match locale-independent.
devkit_parent_session_json() {
  local id=${CLAUDE_CODE_SESSION_ID:-${CODEX_THREAD_ID-}}
  local alnum=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789
  case $id in ''|[!$alnum]*|*[!$alnum._-]*) return 0 ;; esac
  [ "${#id}" -le 128 ] || return 0
  printf ',"parent_session_id":"%s"' "$id"
}

# The ship caller's checkout as a `,"root":"…"` fragment. Omitted when a control character would
# invalidate the row, or past 400 bytes: bash splits an append longer than 1024 across two writes.
devkit_ship_root_json() {
  local LC_ALL=C root
  case $1 in ''|*[[:cntrl:]]*) return 0 ;; esac
  root=$(devkit_json_escape "$1")
  [ "${#root}" -le 400 ] || return 0
  printf ',"root":"%s"' "$root"
}

export DEVKIT_TELEMETRY_VERSION="$(devkit_telemetry_version)"
