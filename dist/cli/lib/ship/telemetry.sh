#!/usr/bin/env bash

# JSON string escaping for shell-built telemetry records. Telemetry fields cannot contain control
# characters, so escaping backslash and double quote is sufficient for these bounded path/id fields.
devkit_json_escape() {
  local value=${1//\\/\\\\}
  printf '%s' "${value//\"/\\\"}"
}
