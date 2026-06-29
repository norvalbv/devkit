/**
 * Opt-in global pre-commit shim for OVERLAY mode.
 *
 * Overlay points `core.hooksPath` at a git-ignored `.devkit/hooks/`, but husky re-claims it to
 * `.husky/_` on every `prepare`/`bun install` (husky/index.js sets it unconditionally), so a plain
 * `git commit` (or a GUI client) runs husky's chain with devkit's gates unwired. The per-clone
 * `git ci` alias only heals a CLI `git ci`.
 *
 * The one seam that SURVIVES the reclaim is husky's own `~/.config/husky/init.sh`, which `.husky/_/h`
 * sources BEFORE running the repo's committed hook. This module writes a single devkit marker block
 * there that runs the overlay's pre-commit GATES (gates-only — `_/h` runs the committed hook itself,
 * so the block must not chain) for any repo devkit has overlaid, and is a guarded NO-OP everywhere
 * else: package-mode and non-devkit repos have no `.devkit/hooks/`.
 *
 * Strictly OPT-IN (`devkit init --overlay --global-commit-gate`) and uninstallable
 * (`devkit clean --global`) so the overlay's per-clone/invisible default is preserved.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const MARK_START = '# >>> devkit overlay global pre-commit gate >>>';
const MARK_END = '# <<< devkit overlay global pre-commit gate <<<';
const TRAILING_NEWLINES = /\n+$/; // hoisted (perf: never recompile per install/remove)

// The devkit block. Guarded so it ONLY acts in an overlaid repo and is otherwise inert:
//   - HUSKY=0 (husky's documented skip-hooks escape hatch) → skip. _/h's own HUSKY=0 exit is at
//     line 14, AFTER it sources init.sh (line 12), so the shim must self-check it here.
//   - only the pre-commit hook ($0 is _/<hook>, basename = hook name — overlay only gates pre-commit).
//   - repo root via `git rev-parse --show-toplevel` (NOT cwd-relative: worktrees/submodules/git -C).
//   - run the overlay hook gates-only via DEVKIT_VIA_HUSKY_INIT=1; its exit (1 on a failed gate)
//     rides the source chain (init.sh -> _/h -> stub) up to git and aborts the commit.
const BLOCK = `${MARK_START}
# devkit overlay: run the overlay pre-commit gates on a plain git commit too (husky reclaims
# core.hooksPath on every install, unwiring the per-clone .devkit/hooks pointer). Sourced by
# husky's _/h BEFORE the repo's own committed hook, which husky still runs afterwards. A guarded
# NO-OP outside an overlaid repo (package-mode + non-devkit repos have no .devkit/hooks). Honors
# HUSKY=0. Repo root resolved via git so worktrees / submodules / git -C still gate the right tree.
if [ "\${HUSKY:-}" != "0" ] && [ "\${0##*/}" = "pre-commit" ]; then
  __dk_root=$(git rev-parse --show-toplevel 2>/dev/null) || __dk_root=
  if [ -n "$__dk_root" ] && [ -x "$__dk_root/.devkit/hooks/pre-commit" ]; then
    DEVKIT_VIA_HUSKY_INIT=1 sh "$__dk_root/.devkit/hooks/pre-commit" "$@" || exit $?
  fi
  unset __dk_root
fi
${MARK_END}`;

/** The husky global init.sh path (XDG-aware), e.g. ~/.config/husky/init.sh. */
export function globalInitPath() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'husky', 'init.sh');
}

/** True iff the devkit block is present in the global init.sh. */
export function globalHookInstalled() {
  const file = globalInitPath();
  try {
    return existsSync(file) && readFileSync(file, 'utf8').includes(MARK_START);
  } catch {
    return false;
  }
}

// Slice the devkit block (markers inclusive) out of `content`, collapsing the blank-line join that
// preceded it (and one trailing newline). Returns the remainder (possibly ''). Never touches text
// outside the markers, so a hand-written init.sh survives.
function stripBlock(content) {
  const start = content.indexOf(MARK_START);
  if (start === -1) return content;
  const end = content.indexOf(MARK_END, start);
  if (end === -1) return content; // start without end → leave the file alone (don't guess)
  let from = start;
  let to = end + MARK_END.length;
  if (content.slice(start - 2, start) === '\n\n') from = start - 1;
  else if (content.slice(start - 1, start) === '\n') from = start - 1;
  if (content.slice(to, to + 1) === '\n') to += 1;
  return content.slice(0, from) + content.slice(to);
}

/**
 * Install (or refresh) the devkit block in the global init.sh — strip-then-reinsert so re-install is
 * byte-stable, and a pre-existing user init.sh keeps its content. Idempotent.
 */
export function installGlobalHook({ dryRun = false } = {}) {
  const file = globalInitPath();
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const base = stripBlock(existing).replace(TRAILING_NEWLINES, '');
  const next = base ? `${base}\n\n${BLOCK}\n` : `${BLOCK}\n`;
  if (dryRun) {
    console.log(`  [dry-run] write devkit global pre-commit gate → ${file}`);
    return;
  }
  if (next === existing) {
    console.log(`  • global pre-commit gate already installed (${file})`);
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, next);
  console.log(`  ✓ global pre-commit gate → ${file}`);
  console.log(
    '    plain `git commit` now runs devkit gates in every OVERLAID repo on this machine;',
  );
  console.log('    a guarded no-op elsewhere. Remove with: devkit clean --global');
}

/**
 * Remove the devkit block from the global init.sh. Strips only devkit's block; if the file is then
 * empty (devkit-only) it is unlinked, otherwise the user's remainder is preserved. No-op if absent.
 */
export function removeGlobalHook({ dryRun = false } = {}) {
  const file = globalInitPath();
  if (!existsSync(file)) return;
  const existing = readFileSync(file, 'utf8');
  if (!existing.includes(MARK_START)) return; // not ours / not present — never touch a foreign file
  if (dryRun) {
    console.log(`  [dry-run] remove devkit global pre-commit gate from ${file}`);
    return;
  }
  const stripped = stripBlock(existing);
  if (stripped.trim() === '') {
    rmSync(file);
    console.log(`  ✓ removed global pre-commit gate (${file})`);
  } else {
    writeFileSync(file, `${stripped.replace(TRAILING_NEWLINES, '')}\n`);
    console.log(`  ✓ removed devkit block from ${file} (kept your init.sh)`);
  }
}
