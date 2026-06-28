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
# set -e-safe: husky runs hooks under \`sh -e\`, so a bare \`bunx … gate\` returning its
# fail-open code (2) would abort the whole hook before this check. \`|| src=$?\` neutralises
# set -e (the call is now a tested command) AND captures the code.
src=0
bunx guard-size gate || src=$?
if [ "$src" -eq 1 ]; then
    echo "   Re-freeze after a deliberate audit: bunx guard-size freeze"
    exit 1
elif [ "$src" -ne 0 ] && [ "$src" -ne 2 ]; then
    echo "   guard-size: unexpected exit $src — blocking the commit."
    exit 1
fi
# src 0 = ok / shrank, src 2 = baseline missing (fail-open) → continue; any other code blocks.
# /devkit:guard-size`,
  fanout: `# devkit:guard-fanout
echo "🗂  Folder fan-out ratchet..."
frc=0
bunx guard-fanout gate || frc=$?
if [ "$frc" -eq 1 ]; then
    echo "   Re-freeze after a deliberate audit: bunx guard-fanout freeze"
    exit 1
elif [ "$frc" -ne 0 ] && [ "$frc" -ne 2 ]; then
    echo "   guard-fanout: unexpected exit $frc — blocking the commit."
    exit 1
fi
# frc 0 = ok / shrank, frc 2 = baseline missing (fail-open) → continue; any other code blocks.
# /devkit:guard-fanout`,
  dup: `# devkit:guard-dup
echo "🔁 Duplication gate (semantic)..."
drc=0
bunx guard-dup scan --new --changed --gate || drc=$?
if [ "$drc" -eq 1 ]; then
    echo "   New duplication. Refactor it, or run the approval command the gate printed above."
    exit 1
elif [ "$drc" -ne 0 ] && [ "$drc" -ne 2 ]; then
    echo "   guard-dup: unexpected exit $drc — blocking the commit."
    exit 1
fi
# drc 0 = clean, drc 2 = could-not-run (fail-open) → continue; any other code blocks.
# /devkit:guard-dup`,
  clone: `# devkit:guard-clone
echo "🔁 Clone gate (verbatim)..."
crc=0
bunx guard-clone scan --changed --gate || crc=$?
if [ "$crc" -eq 1 ]; then
    echo "   New verbatim clone. Refactor it, or run the approval command the gate printed above."
    exit 1
elif [ "$crc" -ne 0 ] && [ "$crc" -ne 2 ]; then
    echo "   guard-clone: unexpected exit $crc — blocking the commit."
    exit 1
fi
# crc 0 = clean, crc 2 = could-not-run (fail-open) → continue; any other code blocks.
# /devkit:guard-clone`,
  decisions: `# devkit:guard-decisions
echo "🧭 Decision-log gate..."
ddrc=0
bunx guard-decisions detect --gate || ddrc=$?
if [ "$ddrc" -eq 1 ]; then
    echo "   Record the decision target, or bypass a non-decision: GUARD_NO_LOG=1 git commit ..."
    exit 1
elif [ "$ddrc" -ne 0 ] && [ "$ddrc" -ne 2 ]; then
    echo "   guard-decisions: unexpected exit $ddrc — blocking the commit."
    exit 1
fi
# ddrc 0 = clean / staged / routine / bypassed, ddrc 2 = fail-open → continue; any other code blocks.
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

// The PATH-setup snippet (GUI git clients launch with a minimal PATH that omits user bin dirs, so
// `bun`/`bunx` go missing). devkit's gates need it to have run BEFORE them — it's part of a fresh hook's
// preamble, and is INJECTED just ahead of an inserted block when an existing hook has no PATH setup.
const PATH_SETUP = `# GUI git clients launch with a minimal PATH that omits user bin dirs, so \`bun\`/\`bunx\`
# can go missing → the hook fails. Prepend the standard user install locations.
for dir in "$HOME/.bun/bin" "$HOME/.local/bin"; do
    [ -d "$dir" ] && case ":$PATH:" in *":$dir:"*) ;; *) PATH="$dir:$PATH" ;; esac
done
export PATH`;

// True when a hook already establishes PATH (so we never inject a duplicate PATH_SETUP).
const HAS_PATH_SETUP_RE = /\$HOME\/\.bun\/bin|export\s+PATH/;

// Preamble-line shapes (top-level → no per-call regex compile). See findPreambleEnd.
const DONE_RE = /^done\b/;
const EXPORT_PATH_RE = /\bexport\s+PATH\b/;
const PATH_ASSIGN_RE = /^PATH=/;
const HOME_BIN_RE = /\$HOME\/\.(bun|local)/;
const LOOP_OPEN_RE = /^(for|while|until)\b/;
const DO_END_RE = /\bdo$/;
const TRAILING_NEWLINES_RE = /\n+$/;
const LEADING_NEWLINES_RE = /^\n+/;

// The shebang + PATH preamble that precedes the marker block when devkit writes a fresh hook.
const HOOK_PREAMBLE = `#!/bin/sh
# devkit generic pre-commit hook (POSIX sh). Runs the selected gate-engine set on every
# commit. The block between the two \`# devkit-guards\` markers is devkit-owned and is the
# only region init / removal touches — everything outside it is the consumer's own hook.

${PATH_SETUP}
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
// Block on exit 1 (real violation) OR any unexpected code (e.g. 127 command-not-found); exit 2 = the
// gate couldn't run (no index/baseline) → fail-open. exit 0 = clean. Only 0/2 continue.
const DK_GATE_HELPER =
  '__dk_gate() { command -v "$1" >/dev/null 2>&1 || return 0; rc=0; "$@" || rc=$?; if [ "$rc" -eq 1 ] || { [ "$rc" -ne 0 ] && [ "$rc" -ne 2 ]; }; then exit 1; fi; }';

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

// The optional fallow gate (overlay). fail-open — only runs if fallow is on PATH; overlay's
// core.hooksPath takeover SHADOWS .git/hooks, so fallow's own installed hook would never fire, and
// chaining the gate inline here is the only way the audit runs. `fallow audit` exits non-zero on
// NEW issues (pre-existing debt is grandfathered by the saved fallow-baselines/).
const FALLOW_OVERLAY_GATE = `# devkit fallow gate (overlay) — fail-open; skipped if fallow isn't installed.
command -v fallow >/dev/null 2>&1 && { fallow audit || exit 1; }`;

/**
 * Build the OVERLAY hook — a complete, self-contained file devkit fully owns (written to a
 * git-ignored local hooks dir at the GIT ROOT; `core.hooksPath` points at it). It runs devkit's
 * gates + lint overlay (cd'd into the package for a monorepo), then `exec`s the repo's OWN
 * committed hook unchanged (so its exit propagates).
 *
 * @param {{guards?:string[]}} selection
 * @param {string} [chainTarget] the repo's existing hook to chain to (git-root-relative)
 * @param {string} [pkgRel] package dir (monorepo) to cd into before the gates ('' = repo root)
 * @param {{fallow?:boolean}} [opts] append the fail-open fallow gate (overlay wires it inline
 *   because core.hooksPath shadows fallow's own .git/hooks hook)
 * @returns {string}
 */
export function buildOverlayHook(
  selection,
  chainTarget = '.husky/pre-commit',
  pkgRel = '',
  { fallow = false } = {},
) {
  const gates = [DK_GATE_HELPER];
  for (const id of Object.keys(STANDALONE_GATES)) {
    if (selection.guards?.includes(id)) gates.push(`__dk_gate ${STANDALONE_GATES[id].join(' ')}`);
  }
  const inner = `${gates.join('\n')}\n\n${OVERLAY_LINT_STEPS}${fallow ? `\n\n${FALLOW_OVERLAY_GATE}` : ''}`;
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
// Reason: parallel marker-block string builders; the shape rhymes but each emits a distinct hook fragment
// fallow-ignore-next-line code-duplication
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
 * Char offset of the END of a hook's leading PREAMBLE — the maximal top run of: the shebang (line 0),
 * blank lines, comment lines, and PATH-setup lines (the `for … do … done` loop, `export PATH`,
 * `$HOME/.bun|.local/bin` lines), stopping at the first SUBSTANTIVE command. The guard block is spliced
 * here (not appended at EOF) so it runs on EVERY commit — a consumer hook below may conditionally
 * early-exit (e.g. a reviewer gate that `exit 0`s when all reviews pass), which would make an appended
 * block unreachable. Whole-file-is-preamble → EOF; no shebang / first line is a command → 0 (very top).
 *
 * @param {string} hookContent
 * @returns {number} insertion offset
 */
export function findPreambleEnd(hookContent) {
  const lines = hookContent.split('\n');
  let consumed = 0;
  let inLoop = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (inLoop > 0) {
      consumed = i + 1;
      if (DONE_RE.test(t)) inLoop--;
      continue;
    }
    // Loop-open FIRST — the PATH for-loop's own line contains `$HOME/.bun` (a preamble shape), so it
    // must be recognised as a loop opener (to track its body via `done`), not a one-off preamble line.
    if (LOOP_OPEN_RE.test(t) && DO_END_RE.test(t)) {
      inLoop++;
      consumed = i + 1;
      continue;
    }
    const isShebang = i === 0 && t.startsWith('#!');
    const isPreambleLine =
      isShebang ||
      t === '' ||
      t.startsWith('#') ||
      EXPORT_PATH_RE.test(t) ||
      PATH_ASSIGN_RE.test(t) ||
      HOME_BIN_RE.test(t);
    if (isPreambleLine) {
      consumed = i + 1;
      continue;
    }
    break; // first substantive command
  }
  if (consumed === 0) return 0;
  if (consumed >= lines.length) return hookContent.length;
  return lines.slice(0, consumed).join('\n').length + 1; // +1 = the newline after the last preamble line
}

/**
 * Insert (or relocate) the package-scoped marker block in a hook so it runs on EVERY commit. ALWAYS
 * removes any existing block first, then re-inserts it right AFTER the preamble (findPreambleEnd) — this
 * RELOCATES a block that a prior devkit version stuck after a terminal `exit` (unreachable). PATH_SETUP
 * is injected just before the block iff the hook establishes no PATH of its own. Idempotent: a
 * correctly-placed block round-trips to the same bytes (so re-running init is a no-op). The consumer's
 * lines outside the block are untouched.
 */
// Reason: parallel marker-block string builders; the shape rhymes but each emits a distinct hook fragment
// fallow-ignore-next-line code-duplication
export function replaceGuardBlock(hookContent, newBlock, pkgRel = '') {
  const { content } = removeGuardBlock(hookContent, pkgRel);
  const idx = findPreambleEnd(content);
  const block = HAS_PATH_SETUP_RE.test(content) ? newBlock : `${PATH_SETUP}\n\n${newBlock}`;
  const before = content.slice(0, idx).replace(TRAILING_NEWLINES_RE, '');
  const after = content.slice(idx).replace(LEADING_NEWLINES_RE, '');
  const joined = [before, block, after].filter((p) => p !== '').join('\n\n');
  return `${joined.replace(TRAILING_NEWLINES_RE, '')}\n`;
}

/**
 * Remove the (package-scoped) devkit-guards block (markers inclusive) from a hook, collapsing
 * the blank lines that surrounded it. Returns { content, removed }.
 */
// Reason: parallel marker-block string builders; the shape rhymes but each emits a distinct hook fragment
// fallow-ignore-next-line code-duplication
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
