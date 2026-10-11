#!/bin/sh
# devkit overlay pre-commit hook: runs the deterministic gates on the staged change.
if ! command -v guard-deterministic >/dev/null 2>&1; then
  echo "devkit: guard-deterministic not installed; skipping gates." >&2
  exit 0
fi
guard-deterministic --staged
