#!/bin/sh
# devkit generic pre-commit hook (POSIX sh). Runs the portable gate-engine set on every
# commit. NO frink-only gates (no positioning / coverage / fallow / reviewer-markers /
# _shared-mirror / skills-content) — those belong to a specific consumer, not the generic
# stack. Exit-code contract mirrors devkit's gates: 1 = block, 2 = fail-open (continue).
#
# When `devkit init` runs against a repo that ALREADY has a .husky/pre-commit, the block
# between the two `# devkit-guards` markers is what gets inserted/refreshed — everything
# outside the markers is the consumer's own hook and is never touched.

# GUI git clients launch with a minimal PATH that omits user bin dirs, so `bun`/`bunx`
# can go missing → the hook fails. Prepend the standard user install locations.
for dir in "$HOME/.bun/bin" "$HOME/.local/bin"; do
    [ -d "$dir" ] && case ":$PATH:" in *":$dir:"*) ;; *) PATH="$dir:$PATH" ;; esac
done
export PATH

# >>> devkit-guards >>>
# Format staged files with biome, then re-stage exactly those (scoped — never a blanket
# `git add -u`, which would sweep unrelated working-tree changes into the commit). Only
# re-add files with NO unstaged edits, so partially-staged files commit exactly as staged.
STAGED_FMT=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.(tsx?|jsx?|css|json|jsonc|mjs)$' || true)
if [ -n "$STAGED_FMT" ]; then
    UNSTAGED_FMT_FILE=$(mktemp)
    git diff --name-only | sort -u >"$UNSTAGED_FMT_FILE"
    FMT_SAFE=$(printf '%s\n' "$STAGED_FMT" | grep -Fxvf "$UNSTAGED_FMT_FILE" || true)
    rm -f "$UNSTAGED_FMT_FILE"
    if [ -n "$FMT_SAFE" ]; then
        echo "🎨 Formatting staged files..."
        echo "$FMT_SAFE" | xargs bunx biome format --write 2>/dev/null || true
        echo "$FMT_SAFE" | xargs git add
    fi
fi

# Structure lint (folder-structure + max-lines). OFF for the generic stack — uncomment
# after `devkit init --stack <electron|next|…>` wires an eslint structure preset.
# bunx eslint src  # uncomment after `devkit init --stack <x>`

# Size-debt ratchet: NEW `eslint-disable max-lines` directives may only shrink the count.
echo "📏 Size-debt ratchet..."
bunx guard-size gate
src=$?
if [ "$src" -eq 1 ]; then
    echo "   Re-freeze after a deliberate audit: bunx guard-size freeze"
    exit 1
fi
# src 0 = ok / shrank, src 2 = baseline missing (fail-open) → continue.

# Folder fan-out ratchet: no dir may exceed the cap (default 12) impl files at any depth.
echo "🗂  Folder fan-out ratchet..."
bunx guard-fanout gate
frc=$?
if [ "$frc" -eq 1 ]; then
    echo "   Re-freeze after a deliberate audit: bunx guard-fanout freeze"
    exit 1
fi
# frc 0 = ok / shrank, frc 2 = baseline missing (fail-open) → continue.

# Duplication gate (semantic, scoped to this commit's staged files). Fails OPEN (exit 2)
# when no search-code index is configured — a consumer without GUARD_INDEX_PATH still
# gets the clone + ratchet gates.
echo "🔁 Duplication gate (semantic)..."
bunx guard-dup scan --new --changed --gate
drc=$?
if [ "$drc" -eq 1 ]; then
    echo "   New duplication. Refactor it, or run the approval command the gate printed above."
    exit 1
fi
# drc 0 = clean, drc 2 = could-not-run (fail-open) → continue.

# Clone gate (verbatim copy-paste / jscpd, scoped to this commit). Fails OPEN (exit 2)
# when jscpd is missing or errored — never bricks a commit.
echo "🔁 Clone gate (verbatim)..."
bunx guard-clone scan --changed --gate
crc=$?
if [ "$crc" -eq 1 ]; then
    echo "   New verbatim clone. Refactor it, or run the approval command the gate printed above."
    exit 1
fi
# crc 0 = clean, crc 2 = could-not-run (fail-open) → continue.

# Decision-log gate: blocks when the staged diff SMELLS like an architectural decision
# and the gate's own judge didn't rule it routine. Bypass a genuine non-decision with
# GUARD_NO_LOG=1. Exit 1 blocks, 0 = clean / decision staged / judged routine, 2 = fail-open.
echo "🧭 Decision-log gate..."
bunx guard-decisions detect --gate
ddrc=$?
if [ "$ddrc" -eq 1 ]; then
    echo "   Record the decision target, or bypass a non-decision: GUARD_NO_LOG=1 git commit ..."
    exit 1
fi
# ddrc 0 = clean / staged / routine / bypassed, ddrc 2 = fail-open → continue.
# <<< devkit-guards <<<

exit 0
