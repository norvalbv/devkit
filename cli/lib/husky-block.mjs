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
