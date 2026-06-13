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

import { MARK_END, MARK_START } from './husky.mjs';

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
 * @param {{biome?:boolean, guards?:string[]}} selection
 * @returns {string}
 */
export function buildGuardBlock(selection) {
  const pieces = [];
  if (selection.biome) pieces.push(BIOME_FRAGMENT);
  pieces.push(STRUCTURE_PLACEHOLDER);
  for (const id of Object.keys(GUARD_FRAGMENTS)) {
    if (selection.guards?.includes(id)) pieces.push(GUARD_FRAGMENTS[id]);
  }
  return `${MARK_START}\n${pieces.join('\n\n')}\n${MARK_END}`;
}

/** A full fresh hook (preamble + assembled block + trailing exit 0) for a repo with no hook. */
export function buildFullHook(selection) {
  return `${HOOK_PREAMBLE}\n${buildGuardBlock(selection)}\n\nexit 0\n`;
}

/** Slice the marker block (inclusive) out of a hook; returns null if no block present. */
export function extractGuardBlock(hookContent) {
  const start = hookContent.indexOf(MARK_START);
  const end = hookContent.indexOf(MARK_END);
  if (start === -1 || end === -1) return null;
  return hookContent.slice(start, end + MARK_END.length);
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

/** Replace (or insert) the marker block in an existing hook with `newBlock`. */
export function replaceGuardBlock(hookContent, newBlock) {
  const start = hookContent.indexOf(MARK_START);
  const end = hookContent.indexOf(MARK_END);
  if (start === -1 || end === -1) {
    const sep = hookContent.endsWith('\n') ? '\n' : '\n\n';
    return `${hookContent}${sep}${newBlock}\n`;
  }
  return hookContent.slice(0, start) + newBlock + hookContent.slice(end + MARK_END.length);
}

/**
 * Remove the entire devkit-guards block (markers inclusive) from a hook, collapsing the
 * blank lines that surrounded it. Returns { content, removed }.
 */
export function removeGuardBlock(hookContent) {
  const start = hookContent.indexOf(MARK_START);
  const end = hookContent.indexOf(MARK_END);
  if (start === -1 || end === -1) return { content: hookContent, removed: false };
  const afterEnd = end + MARK_END.length;
  let from = start;
  let to = afterEnd;
  if (hookContent.slice(start - 2, start) === '\n\n') from = start - 1;
  if (hookContent.slice(to, to + 1) === '\n') to += 1;
  return { content: hookContent.slice(0, from) + hookContent.slice(to), removed: true };
}

export { GUARD_FRAGMENTS, STRUCTURE_PLACEHOLDER };
