#!/bin/sh
# devkit overlay pre-commit hook: runs the deterministic gates on the staged change.
if ! command -v guard-deterministic >/dev/null 2>&1; then
  echo "devkit: guard-deterministic is not on PATH; run 'bun install' and commit again." >&2
  exit 1
fi
guard-deterministic --staged
