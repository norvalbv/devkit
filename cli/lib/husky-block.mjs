/**
 * Assemble the `# devkit-guards` pre-commit block from a component selection, and
 * surgically remove individual pieces (a single guard, the biome-format step, the whole
 * block) without disturbing the consumer's own hook lines outside the markers.
 *
 * The block is COMPOSED from fragments rather than copied from a static template so that
 * `devkit init` can emit exactly the selected guards + the biome step, and the removal
 * path can drop one guard while leaving the rest. Each fragment is delimited by per-piece
 * `# devkit:<id>` / `# /devkit:<id>` sentinels so removal is an exact slice, never a
 * brittle regex against shell prose.
 */

import { markEnd, markStart } from './husky.mjs';

// One guard fragment: an echo banner + the bunx call + its exit-code check, wrapped in
// sentinels. Keyed by guard id (GUARD_IDS in components.mjs).
const GUARD_FRAGMENTS = {
  size: `# devkit:guard-size
echo "📏 Size-debt ratchet..."
bunx guard-size gate
src=$?
if [ "$src" -eq 1 ]; then
    echo "   Re-freeze after a deliberate audit: bunx guard-size freeze"
    exit 1
fi
# src 0 = ok / shrank, src 2 = baseline missing (fail-open) → continue.
# /devkit:guard-size`,
  fanout: `# devkit:guard-fanout
echo "🗂  Folder fan-out ratchet..."
bunx guard-fanout gate
frc=$?
if [ "$frc" -eq 1 ]; then
    echo "   Re-freeze after a deliberate audit: bunx guard-fanout freeze"
    exit 1
fi
# frc 0 = ok / shrank, frc 2 = baseline missing (fail-open) → continue.
# /devkit:guard-fanout`,
  dup: `# devkit:guard-dup
echo "🔁 Duplication gate (semantic)..."
bunx guard-dup scan --new --changed --gate
drc=$?
if [ "$drc" -eq 1 ]; then
    echo "   New duplication. Refactor it, or run the approval command the gate printed above."
    exit 1
fi
# drc 0 = clean, drc 2 = could-not-run (fail-open) → continue.
# /devkit:guard-dup`,
  clone: `# devkit:guard-clone
echo "🔁 Clone gate (verbatim)..."
bunx guard-clone scan --changed --gate
crc=$?
if [ "$crc" -eq 1 ]; then
    echo "   New verbatim clone. Refactor it, or run the approval command the gate printed above."
    exit 1
fi
# crc 0 = clean, crc 2 = could-not-run (fail-open) → continue.
# /devkit:guard-clone`,
  decisions: `# devkit:guard-decisions
echo "🧭 Decision-log gate..."
bunx guard-decisions detect --gate
ddrc=$?
if [ "$ddrc" -eq 1 ]; then
    echo "   Record the decision target, or bypass a non-decision: GUARD_NO_LOG=1 git commit ..."
    exit 1
fi
# ddrc 0 = clean / staged / routine / bypassed, ddrc 2 = fail-open → continue.
# /devkit:guard-decisions`,
};

// The biome format-staged-files step (only when the `biome` component is selected).
const BIOME_FRAGMENT = `# devkit:biome-format
# Format staged files with biome, then re-stage exactly those (scoped — never a blanket
# \`git add -u\`, which would sweep unrelated working-tree changes into the commit). Only
# re-add files with NO unstaged edits, so partially-staged files commit exactly as staged.
STAGED_FMT=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\\.(tsx?|jsx?|css|json|jsonc|mjs)$' || true)
if [ -n "$STAGED_FMT" ]; then
    UNSTAGED_FMT_FILE=$(mktemp)
    git diff --name-only | sort -u >"$UNSTAGED_FMT_FILE"
    FMT_SAFE=$(printf '%s\\n' "$STAGED_FMT" | grep -Fxvf "$UNSTAGED_FMT_FILE" || true)
    rm -f "$UNSTAGED_FMT_FILE"
    if [ -n "$FMT_SAFE" ]; then
        echo "🎨 Formatting staged files..."
        echo "$FMT_SAFE" | xargs bunx biome format --write 2>/dev/null || true
        echo "$FMT_SAFE" | xargs git add
    fi
fi
# /devkit:biome-format`;

// The commented structure-lint placeholder (generic / no structure preset). A structure
// stack flips this to the live `bunx eslint src` line via enableStructureLint().
const STRUCTURE_PLACEHOLDER = `# Structure lint (folder-structure + max-lines). OFF for this stack — uncomment after a
# structure preset is wired.
# bunx eslint src  # uncomment after \`devkit init --stack <x>\``;

// The shebang + PATH preamble that precedes the marker block when devkit writes a fresh hook.
const HOOK_PREAMBLE = `#!/bin/sh
# devkit generic pre-commit hook (POSIX sh). Runs the selected gate-engine set on every
# commit. The block between the two \`# devkit-guards\` markers is devkit-owned and is the
# only region init / removal touches — everything outside it is the consumer's own hook.

# GUI git clients launch with a minimal PATH that omits user bin dirs, so \`bun\`/\`bunx\`
# can go missing → the hook fails. Prepend the standard user install locations.
for dir in "$HOME/.bun/bin" "$HOME/.local/bin"; do
    [ -d "$dir" ] && case ":$PATH:" in *":$dir:"*) ;; *) PATH="$dir:$PATH" ;; esac
done
export PATH
`;

// The commit-msg variant of the preamble. git invokes a commit-msg hook with the path to the
// commit-message file as `$1`; devkit-managed commit-msg gates forward that path to their gate.
const COMMIT_MSG_PREAMBLE = `#!/bin/sh
# devkit generic commit-msg hook (POSIX sh). git passes the commit-message file as \`$1\`. The
# block between the two \`# devkit-guards\` markers is devkit-owned (init / removal only touch that
# region); everything outside it is the consumer's own hook. Each gate receives "$1" so it can read
# the message — these are warn-by-default advisory gates (a thin caller on a judge), not hard blocks.

for dir in "$HOME/.bun/bin" "$HOME/.local/bin"; do
    [ -d "$dir" ] && case ":$PATH:" in *":$dir:"*) ;; *) PATH="$dir:$PATH" ;; esac
done
export PATH
`;

/**
 * Build the `# devkit-guards` marker block (inclusive of markers) from a selection.
 * Order: biome format → structure placeholder → guards in GUARD_FRAGMENTS order.
 *
 * `pkgRel` (monorepo): when set, the markers are package-scoped and the gates run inside a
 * `( cd "<pkgRel>" … ) || exit 1` subshell so the hook (at the git root) governs that package.
 * biome's staged-file format is REPO-WIDE → emitted only at the root (pkgRel ''), never inside
 * a package subshell (where `git add` paths would resolve wrong).
 *
 * @param {{biome?:boolean, guards?:string[]}} selection
 * @param {string} [pkgRel] package path relative to the git root ('' = root install)
 * @returns {string}
 */
export function buildGuardBlock(selection, pkgRel = '') {
  const pieces = [];
  if (!pkgRel && selection.biome) pieces.push(BIOME_FRAGMENT);
  pieces.push(STRUCTURE_PLACEHOLDER);
  for (const id of Object.keys(GUARD_FRAGMENTS)) {
    if (selection.guards?.includes(id)) pieces.push(GUARD_FRAGMENTS[id]);
  }
  const body = pieces.join('\n\n');
  const start = markStart(pkgRel);
  const end = markEnd(pkgRel);
  if (!pkgRel) return `${start}\n${body}\n${end}`;
  // Run the package's gates from its own dir. An inner `exit 1` exits the SUBSHELL; the
  // `) || exit 1` then propagates that failure to the hook (a bare subshell would swallow it).
  return `${start}\n( cd "${pkgRel}" || exit 1\n\n${body}\n) || exit 1\n${end}`;
}

/** A full fresh hook (preamble + assembled block + trailing exit 0) for a repo with no hook. */
export function buildFullHook(selection, pkgRel = '') {
  return `${HOOK_PREAMBLE}\n${buildGuardBlock(selection, pkgRel)}\n\nexit 0\n`;
}

// Standalone (no-package) gate args, in run order. The bin is global (devkit installed with
// `bun add -g`); the block fail-opens per gate so a repo whose committer doesn't have devkit is
// never blocked — exactly fallow's `command -v fallow || exit 0`.
const STANDALONE_GATES = {
  size: ['guard-size', 'gate'],
  fanout: ['guard-fanout', 'gate'],
  dup: ['guard-dup', 'scan', '--new', '--changed', '--gate'],
  clone: ['guard-clone', 'scan', '--changed', '--gate'],
  decisions: ['guard-decisions', 'detect', '--gate'],
};

// fail-open helper: run a gate only if its global bin is on PATH (skip silently otherwise), and
// block the commit ONLY on exit 1 (a real violation). Exit 2 means the gate couldn't run
// (e.g. no search-code index) → fail-open, same as the package-mode fragments.
const DK_GATE_HELPER =
  '__dk_gate() { command -v "$1" >/dev/null 2>&1 || return 0; "$@"; if [ $? -eq 1 ]; then exit 1; fi; }';

/**
 * Build the standalone (no-package) `# devkit-guards` block — global `guard-*` bins, fail-open,
 * NO `bunx`/node_modules. Structure-lint + biome-format are omitted (they need project-local
 * tooling; standalone covers the pure-node ratchet guards). pkgRel cd-wraps for a monorepo.
 *
 * @param {{guards?:string[]}} selection
 * @param {string} [pkgRel]
 * @returns {string}
 */
export function buildStandaloneBlock(selection, pkgRel = '') {
  const pieces = [
    '# devkit standalone gates — global CLI, fail-open (skipped if devkit is not installed).',
    DK_GATE_HELPER,
  ];
  for (const id of Object.keys(STANDALONE_GATES)) {
    if (selection.guards?.includes(id)) pieces.push(`__dk_gate ${STANDALONE_GATES[id].join(' ')}`);
  }
  const body = pieces.join('\n');
  const start = markStart(pkgRel);
  const end = markEnd(pkgRel);
  if (!pkgRel) return `${start}\n${body}\n${end}`;
  return `${start}\n( cd "${pkgRel}" || exit 1\n${body}\n) || exit 1\n${end}`;
}

/** A full fresh STANDALONE hook (preamble + standalone block + exit 0). */
export function buildStandaloneHook(selection, pkgRel = '') {
  return `${HOOK_PREAMBLE}\n${buildStandaloneBlock(selection, pkgRel)}\n\nexit 0\n`;
}

// ── commit-msg hook support ─────────────────────────────────────────────────────────────────
// The pre-commit machinery above governs `.husky/pre-commit`; a parallel set here governs
// `.husky/commit-msg`. The marker scheme (markStart/markEnd, per-fragment sentinels) is hook-file
// agnostic — each hook lives in its OWN file, so the same markers slice cleanly in either. A
// commit-msg gate is a thin caller that judges the MESSAGE (passed as "$1"); these are warn-by-
// default advisory gates (e.g. a sentry-advisory judge), so each fragment is fail-open: it only
// blocks on a deliberate hard-mode exit 1, never on the gate being absent or unable to run.
//
// COMMIT_MSG_FRAGMENTS is empty by default — devkit ships the MECHANISM, not a consumer's gate
// data. A caller (a frink-style thin wrapper, or the integrator) registers a fragment via
// `commitMsgFragment(id, gateLine)` whose `gateLine` receives the message path as "$1".

const COMMIT_MSG_FRAGMENTS = {};

/**
 * Register a commit-msg gate fragment. `gateLine` is the shell that runs the gate (it may use
 * "$1", the commit-message file path). Wrapped in per-id sentinels so removal is an exact slice.
 *
 * @param {string} id fragment id (sentinel key)
 * @param {string} gateLine the gate invocation (fail-open by contract; "$1" = message file)
 * @param {string} [banner] optional echo banner printed before the gate
 */
export function commitMsgFragment(id, gateLine, banner) {
  const head = banner ? `echo "${banner}"\n` : '';
  COMMIT_MSG_FRAGMENTS[id] = `# devkit:${id}\n${head}${gateLine}\n# /devkit:${id}`;
  return COMMIT_MSG_FRAGMENTS[id];
}

/**
 * Build the commit-msg `# devkit-guards` marker block from a selection of registered commit-msg
 * fragment ids. Mirrors buildGuardBlock's monorepo cd-wrapping. Returns the markers + body only
 * (no preamble), so it can be spliced into an existing commit-msg hook via replaceGuardBlock.
 *
 * @param {{commitMsg?:string[]}} selection ids of registered commit-msg fragments to include
 * @param {string} [pkgRel]
 * @returns {string}
 */
export function buildCommitMsgBlock(selection, pkgRel = '') {
  const pieces = [];
  for (const id of selection.commitMsg ?? []) {
    if (COMMIT_MSG_FRAGMENTS[id]) pieces.push(COMMIT_MSG_FRAGMENTS[id]);
  }
  const body = pieces.join('\n\n');
  const start = markStart(pkgRel);
  const end = markEnd(pkgRel);
  if (!pkgRel) return `${start}\n${body}\n${end}`;
  // The commit-msg path "$1" is absolute (or git-root-relative) — forward it into the subshell.
  return `${start}\n( cd "${pkgRel}" || exit 1\n\n${body}\n) || exit 1\n${end}`;
}

/** A full fresh commit-msg hook (commit-msg preamble + assembled block + exit 0). */
export function buildCommitMsgHook(selection, pkgRel = '') {
  return `${COMMIT_MSG_PREAMBLE}\n${buildCommitMsgBlock(selection, pkgRel)}\n\nexit 0\n`;
}

export { COMMIT_MSG_FRAGMENTS, COMMIT_MSG_PREAMBLE };

// The eslint/biome overlay steps — run the LOCAL devkit configs (which extend the repo's) over
// STAGED files only (so new changes are checked without flooding on the team's existing code,
// which can't be grandfathered invisibly). Each step is fail-open: only fires if the local
// config + the repo's own binary are present.
// `--relative` makes `git diff` emit paths relative to the CURRENT dir, so this works whether
// the hook runs at the repo root or cd'd into a monorepo package (eslint/biome + their configs
// are then resolved package-locally).
const OVERLAY_LINT_STEPS = `# devkit lint overlay — STAGED files only, against configs that EXTEND the repo's (git-ignored).
DK_TS=$(git diff --cached --name-only --relative --diff-filter=ACM | grep -E '\\.(tsx?|jsx?)$' || true)
if [ -n "$DK_TS" ] && [ -f eslint.config.devkit.mjs ] && [ -x node_modules/.bin/eslint ]; then
    echo "🧱 devkit eslint overlay (staged)..."
    echo "$DK_TS" | xargs node_modules/.bin/eslint -c eslint.config.devkit.mjs || exit 1
fi
DK_FMT=$(git diff --cached --name-only --relative --diff-filter=ACM | grep -E '\\.(tsx?|jsx?|css|jsonc?)$' || true)
if [ -n "$DK_FMT" ] && [ -f biome.devkit.jsonc ] && [ -x node_modules/.bin/biome ]; then
    echo "🎨 devkit biome overlay (staged)..."
    echo "$DK_FMT" | xargs node_modules/.bin/biome check --config-path biome.devkit.jsonc || exit 1
fi`;

/**
 * Build the OVERLAY hook — a complete, self-contained file devkit fully owns (written to a
 * git-ignored local hooks dir at the GIT ROOT; `core.hooksPath` points at it). It runs devkit's
 * gates + lint overlay (cd'd into the package for a monorepo), then `exec`s the repo's OWN
 * committed hook unchanged (so its exit propagates).
 *
 * @param {{guards?:string[]}} selection
 * @param {string} [chainTarget] the repo's existing hook to chain to (git-root-relative)
 * @param {string} [pkgRel] package dir (monorepo) to cd into before the gates ('' = repo root)
 * @returns {string}
 */
export function buildOverlayHook(selection, chainTarget = '.husky/pre-commit', pkgRel = '') {
  const gates = [DK_GATE_HELPER];
  for (const id of Object.keys(STANDALONE_GATES)) {
    if (selection.guards?.includes(id)) gates.push(`__dk_gate ${STANDALONE_GATES[id].join(' ')}`);
  }
  const inner = `${gates.join('\n')}\n\n${OVERLAY_LINT_STEPS}`;
  const scoped = pkgRel ? `( cd ${JSON.stringify(pkgRel)} || exit 1\n${inner}\n) || exit 1` : inner;
  return `${HOOK_PREAMBLE}
# devkit OVERLAY (LOCAL, git-ignored). Runs devkit's gates + lint overlay on this commit, then
# the repo's OWN committed hook UNCHANGED. Invisible to the team — nothing here is committed.
${scoped}

# Chain to the repo's own pre-commit (exec → its exit code becomes the hook's).
[ -f ${JSON.stringify(chainTarget)} ] && exec sh ${JSON.stringify(chainTarget)} "$@"
exit 0
`;
}

/**
 * Build a PASS-THROUGH wrapper for a non-pre-commit hook. Overriding `core.hooksPath` makes git
 * run ONLY our hooks dir, so EVERY hook the repo already had (pre-push, commit-msg, …) needs a
 * wrapper here or it silently stops. This just runs the repo's own hook unchanged.
 *
 * @param {string} chainScript the repo's existing hook script (git-root-relative)
 * @returns {string}
 */
export function buildPassthroughHook(chainScript) {
  return `${HOOK_PREAMBLE}
# devkit overlay pass-through — git now runs this dir, so we forward to the repo's own hook
# unchanged (devkit adds nothing to it).
[ -f ${JSON.stringify(chainScript)} ] && exec sh ${JSON.stringify(chainScript)} "$@"
exit 0
`;
}

/** Slice the (package-scoped) marker block (inclusive) out of a hook; null if absent. */
export function extractGuardBlock(hookContent, pkgRel = '') {
  const s = markStart(pkgRel);
  const e = markEnd(pkgRel);
  const start = hookContent.indexOf(s);
  const end = hookContent.indexOf(e);
  if (start === -1 || end === -1) return null;
  return hookContent.slice(start, end + e.length);
}

/**
 * Remove a single per-id fragment (`# devkit:<id>` … `# /devkit:<id>`) from a hook,
 * trimming the blank line that joined it. Returns { content, removed }.
 *
 * @param {string} hookContent
 * @param {string} id one of GUARD_FRAGMENTS keys or 'biome-format'
 */
export function removeFragment(hookContent, id) {
  const open = `# devkit:${id}`;
  const close = `# /devkit:${id}`;
  const start = hookContent.indexOf(open);
  const end = hookContent.indexOf(close);
  if (start === -1 || end === -1) return { content: hookContent, removed: false };
  const afterClose = end + close.length;
  // Eat one leading blank-line separator if present (the `\n\n` join), else one trailing.
  let from = start;
  let to = afterClose;
  if (hookContent.slice(start - 2, start) === '\n\n') from = start - 1;
  else if (hookContent.slice(afterClose, afterClose + 2) === '\n\n') to = afterClose + 1;
  return { content: hookContent.slice(0, from) + hookContent.slice(to), removed: true };
}

/** Is a given guard id currently present (by sentinel) in the hook? */
export function hasFragment(hookContent, id) {
  return hookContent.includes(`# devkit:${id}`);
}

/**
 * Replace (or insert/append) the package-scoped marker block in an existing hook. A new
 * package's block is appended, leaving any other packages' blocks + the consumer's lines intact.
 */
export function replaceGuardBlock(hookContent, newBlock, pkgRel = '') {
  const s = markStart(pkgRel);
  const e = markEnd(pkgRel);
  const start = hookContent.indexOf(s);
  const end = hookContent.indexOf(e);
  if (start === -1 || end === -1) {
    // Append before a trailing `exit 0` if present, else at the end.
    const exitIdx = hookContent.lastIndexOf('\nexit 0');
    if (exitIdx !== -1) {
      return `${hookContent.slice(0, exitIdx)}\n\n${newBlock}${hookContent.slice(exitIdx)}`;
    }
    const sep = hookContent.endsWith('\n') ? '\n' : '\n\n';
    return `${hookContent}${sep}${newBlock}\n`;
  }
  return hookContent.slice(0, start) + newBlock + hookContent.slice(end + e.length);
}

/**
 * Remove the (package-scoped) devkit-guards block (markers inclusive) from a hook, collapsing
 * the blank lines that surrounded it. Returns { content, removed }.
 */
export function removeGuardBlock(hookContent, pkgRel = '') {
  const s = markStart(pkgRel);
  const e = markEnd(pkgRel);
  const start = hookContent.indexOf(s);
  const end = hookContent.indexOf(e);
  if (start === -1 || end === -1) return { content: hookContent, removed: false };
  const afterEnd = end + e.length;
  let from = start;
  let to = afterEnd;
  if (hookContent.slice(start - 2, start) === '\n\n') from = start - 1;
  if (hookContent.slice(to, to + 1) === '\n') to += 1;
  return { content: hookContent.slice(0, from) + hookContent.slice(to), removed: true };
}

export { GUARD_FRAGMENTS, STRUCTURE_PLACEHOLDER };
