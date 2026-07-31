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

export DEVKIT_TELEMETRY_VERSION="$(devkit_telemetry_version)"
