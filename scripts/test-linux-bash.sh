#!/usr/bin/env bash
# Runs the given vitest files under Linux bash 5, the shell CI uses, so bash >= 4-only tests that
# skip on macOS's bash 3.2 can be executed locally. Usage: bun run test:linux-bash <test file>...
set -euo pipefail

IMAGE=node:24.21.0-bookworm
BUN_VERSION=${BUN_VERSION:-1.3.1}

if [[ $# -eq 0 ]]; then
  echo 'usage: bun run test:linux-bash <test file>... (the whole suite is not supported here)' >&2
  exit 2
fi
if ! docker info >/dev/null 2>&1; then
  echo 'test:linux-bash: Docker is not running. Start it (macOS: open -a Docker) and re-run.' >&2
  exit 1
fi

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# Per-checkout volume: node_modules needs Linux native binaries and must not mix branches.
volume="devkit-linux-nm-$(basename "$root")"
# The checkout is mounted at /work, so a path under it is forwarded relative to it.
files=("${@#"$root"/}")

# Setup runs as root; the tests run as the host uid, because root passes permission-denied cases.
exec docker run --rm -i \
  -v "$root:/work" -v "$volume:/work/node_modules" -w /work \
  -e BUN_VERSION="$BUN_VERSION" -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  "$IMAGE" bash -c '
    set -euo pipefail
    bun_dir=/work/node_modules/.linux-bun
    if [[ "$("$bun_dir/bin/bun" --version 2>/dev/null)" != "$BUN_VERSION" ]]; then
      curl -fsSL https://bun.sh/install | BUN_INSTALL=$bun_dir bash -s "bun-v$BUN_VERSION" >/dev/null
    fi
    chown -R "$HOST_UID:$HOST_GID" /work/node_modules
    export HOME=/tmp/home PATH="$bun_dir/bin:$PATH"
    exec setpriv --reuid="$HOST_UID" --regid="$HOST_GID" --clear-groups bash -c "
      set -euo pipefail
      mkdir -p \$HOME
      git -C \$HOME config --global user.name devkit-test
      git -C \$HOME config --global user.email devkit-test@example.invalid
      git -C \$HOME config --global safe.directory \"*\"
      HUSKY=0 bun install --frozen-lockfile >/dev/null
      bun run test:run \"\$@\"
    " test-linux-bash "$@"
  ' test-linux-bash "${files[@]}"
