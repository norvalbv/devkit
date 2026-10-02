/** Opt-in ~/.config/husky/init.sh block that runs the overlay's pre-commit and commit-msg gates once
 * husky reclaims core.hooksPath. Rationale: docs/decisions/overlay-self-heal.md. */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { LOCAL_HOOKS, OVERLAY_HOME_SH } from './husky/overlay/overlay-home.mts';

const MARK_START = '# >>> devkit overlay global pre-commit gate >>>';
const MARK_END = '# <<< devkit overlay global pre-commit gate <<<';
const TRAILING_NEWLINES = /\n+$/; // hoisted (perf: never recompile per install/remove)
// The overlay hook whose presence marks a checkout as overlaid.
const OVERLAY_HOOK_REL = `${LOCAL_HOOKS}/pre-commit`;

// Inert outside an overlaid repo, under HUSKY=0 and for other hooks; shell only, as husky sources it in
// every husky repo. The overlay hook runs gates-only, and its failing exit aborts the commit.
const BLOCK = `${MARK_START}
# devkit overlay: run the overlay pre-commit and commit-msg gates on a plain git commit too (husky
# reclaims core.hooksPath on every install, unwiring the per-clone .devkit/hooks pointer). Sourced by
# husky's _/h BEFORE the repo's own committed hook, which husky still runs afterwards. A guarded
# NO-OP outside an overlaid repo (package-mode + non-devkit repos have no .devkit/hooks). Honors
# HUSKY=0. Repo root resolved via git so worktrees / submodules / git -C still gate the right tree.
if [ "\${HUSKY:-}" != "0" ] && { [ "\${0##*/}" = "pre-commit" ] || [ "\${0##*/}" = "commit-msg" ]; }; then
  __dk_root=$(git rev-parse --show-toplevel 2>/dev/null) || __dk_root=
  # A linked worktree has no overlay of its own until its first gated commit links one (sc-4157).
  [ -x "$__dk_root/${OVERLAY_HOOK_REL}" ] || __dk_root=$(${OVERLAY_HOME_SH})
  if [ -n "$__dk_root" ] && [ -x "$__dk_root/${LOCAL_HOOKS}/\${0##*/}" ]; then
    DEVKIT_VIA_HUSKY_INIT=1 sh "$__dk_root/${LOCAL_HOOKS}/\${0##*/}" "$@" || exit $?
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

/**
 * True iff the global init.sh carries this devkit's block VERBATIM.
 *
 * `globalHookInstalled` (MARK_START alone) stays doctor's advisory signal — a start marker is
 * enough to say "you opted in". `devkit review` needs a stronger claim, because this shim is the
 * ONLY thing keeping an overlay repo gated once husky reclaims core.hooksPath.
 *
 * Exact-match rather than grepping for the hook path between the markers: any substring test is
 * satisfied by text that never executes, and `# .devkit/hooks/pre-commit` inside the block would
 * pass one while husky runs nothing. Byte-equality against the generator is the same standard
 * `reviewHookDrift` already applies to the pre-commit block, and it needs no shell parsing at all.
 *
 * A block this devkit did not generate (an older release's wording, a hand edit) therefore reads as
 * NOT wired. That is deliberate and fail-closed: devkit can only vouch for a block whose behaviour
 * it knows. `installGlobalHook` is strip-then-reinsert, so re-running
 * `devkit init --overlay --global-commit-gate` restores the exact block.
 */
export function globalHookWired() {
  const file = globalInitPath();
  try {
    return existsSync(file) && readFileSync(file, 'utf8').includes(BLOCK);
  } catch {
    return false;
  }
}

// Slice the devkit block (markers inclusive) out of `content`, collapsing the blank-line join that
// preceded it (and one trailing newline). Returns the remainder (possibly ''). Never touches text
// outside the markers, so a hand-written init.sh survives.
function stripBlock(content: string): string {
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
