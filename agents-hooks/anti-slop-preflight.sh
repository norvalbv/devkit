#!/bin/bash
# PostToolUse hook (Edit|Write|MultiEdit, and Bash; Cursor: afterFileEdit) — the anti-slop
# authoring-time check. Runs `devkit anti-slop check <files>` on the file(s) just written, so a policy
# violation (e.g. no-module-mocking in a new test) surfaces after the FIRST offending write instead of
# at commit, when a whole suite may already be built on it. The check is path-scoped and forgives
# baselined debt, so only NEW findings in these files can block.
#
# --bash-writes (the Bash registration): a Bash call names no file, so its writes are the dirty files
# (staged, unstaged, untracked) whose mtime falls in that call's window: duration_ms plus 2 s for
# coarse mtimes. A payload without duration_ms (an older harness) gets no Bash check. The workspace is the payload cwd's
# git toplevel (it follows a worktree), then CLAUDE_PROJECT_DIR; the first root holding a file bounds it.
#
# Blocks (exit 2 + stderr) ONLY on the check's own `anti-slop: FAIL —` verdict. Node exits 1 on an
# uncaught throw too (capability not installed, an older devkit without the verb), and that must
# never read as a finding. Everything else fails open.
#
# Portable (W-3): the devkit bin resolves from the package's or project's node_modules, then PATH
# (overlay's global install) — never bunx/npx, which would fetch from the network. Bash 3.2-safe.

input=$(cat)

command -v node &>/dev/null || { echo '{}'; exit 0; }
# Absolute hook dir BEFORE any cd — a relative $0 would dangle after the chdir.
HOOK_DIR=$(cd "$(dirname "$0")" 2>/dev/null && pwd)
project="${CLAUDE_PROJECT_DIR:-$HOOK_DIR/../..}"

# Node resolves file_path/path at any payload level (or a Bash call's writes), realpaths it, and finds
# the nearest anti-slop install in the workspace. Output: `<package dir>\t<package-relative path>` lines.
bash_writes=0
[ "$1" = "--bash-writes" ] && bash_writes=1
targets=$(printf '%s' "$input" | ANTI_SLOP_PROJECT="$project" ANTI_SLOP_BASH_WRITES="$bash_writes" node -e '
const { execFileSync } = require("node:child_process");
const { existsSync, realpathSync, statSync } = require("node:fs");
const { dirname, join, relative, sep } = require("node:path");
const startedAt = Date.now();
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
const git = (dir, args) =>
  execFileSync("git", ["-c", "core.fsmonitor=false", "-C", dir, ...args], { encoding: "utf8", env: gitEnv, maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
const toplevel = (dir) => { try { return realpathSync(git(dir, ["rev-parse", "--show-toplevel"]).trim()); } catch { return null; } };
// Porcelain -z with --no-renames: one `XY path` record per entry; unmerged (U*, *U, AA, DD) skipped.
const bashWrites = (root, durationMs) =>
  git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"])
    .split("\0")
    .filter((record) => record.length > 3 && !/U|AA|DD/.test(record.slice(0, 2)))
    .map((record) => join(root, record.slice(3)))
    .filter((path) => existsSync(path) && statSync(path).mtimeMs >= startedAt - durationMs - 2000);
let raw = "";
process.stdin.on("data", (chunk) => (raw += chunk)).on("end", () => {
  try {
    const payload = JSON.parse(raw);
    const workspace = typeof payload?.cwd === "string" ? toplevel(payload.cwd) : null;
    const project = realpathSync(process.env.ANTI_SLOP_PROJECT);
    const roots = [workspace, project].filter(Boolean);
    const holders = [payload, payload?.tool_input, ...(Array.isArray(payload?.tool_input?.edits) ? payload.tool_input.edits : [])];
    const named = holders.flatMap((h) => [h?.file_path, h?.path]).filter((p) => typeof p === "string" && p !== "");
    // Porcelain paths are relative to the repo toplevel, which a subdirectory project is not.
    const bashRoot = workspace ?? toplevel(project);
    if (process.env.ANTI_SLOP_BASH_WRITES === "1" && bashRoot && Number.isFinite(payload?.duration_ms)) named.push(...bashWrites(bashRoot, payload.duration_ms));
    const lines = new Set();
    for (const path of new Set(named)) {
      if (!/\.(?:[cm]?[jt]s|[jt]sx)$/.test(path) || !existsSync(path) || !statSync(path).isFile()) continue;
      const real = realpathSync(path);
      const root = roots.find((candidate) => real.startsWith(candidate + sep));
      if (!root || /[\t\n]/.test(real)) continue;
      for (let dir = dirname(real); dir.startsWith(root); dir = dirname(dir)) {
        if (existsSync(join(dir, ".devkit", "anti-slop", "manifest.json"))) {
          lines.add(`${dir}\t${relative(dir, real)}`);
          break;
        }
        if (dir === root) break;
      }
    }
    process.stdout.write([...lines].join("\n"));
  } catch {}
});' 2>/dev/null)
[ -n "$targets" ] || { echo '{}'; exit 0; }

project_real=$(cd "$project" 2>/dev/null && pwd -P) || { echo '{}'; exit 0; }
failed=""
packages=$(printf '%s\n' "$targets" | cut -f1 | sort -u)
while IFS= read -r pkg; do
  rel_paths=()
  while IFS="$(printf '\t')" read -r dir rel; do
    [ "$dir" = "$pkg" ] && rel_paths+=("$rel")
  done <<EOF_TARGETS
$targets
EOF_TARGETS
  if [ -x "$pkg/node_modules/.bin/devkit" ]; then
    devkit_bin="$pkg/node_modules/.bin/devkit"
  elif [ -x "$project_real/node_modules/.bin/devkit" ]; then
    devkit_bin="$project_real/node_modules/.bin/devkit"
  elif command -v devkit &>/dev/null; then
    devkit_bin=devkit
  else
    continue
  fi
  # 2>&1: the ERROR lines naming file and rule go to stdout, and exit 2 shows the agent only stderr.
  output=$(cd "$pkg" && "$devkit_bin" anti-slop check -- "${rel_paths[@]}" </dev/null 2>&1)
  status=$?
  # The verdict is a whole line the check itself prints; a crash quoting a path must not match.
  if [ "$status" -eq 1 ] && printf '%s\n' "$output" | grep -qE '^anti-slop: FAIL — '; then
    failed="${failed}${output}"$'\n'
  fi
done <<EOF_PACKAGES
$packages
EOF_PACKAGES

if [ -n "$failed" ]; then
  echo "anti-slop preflight: new policy findings in the file(s) just written — fix them before writing more code on this pattern:" >&2
  echo "" >&2
  printf '%s' "$failed" >&2
  exit 2
fi

echo '{}'
exit 0
