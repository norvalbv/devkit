/**
 * The biome format-staged-files step, emitted when the `biome` component is selected.
 * Rationale: the 2026-09-03 note in docs/decisions/oxc-toolchain-migration.md.
 */
// The three constants toSelfHost re-points (tool setup, failure policy, scope) are interpolated
// below, so its search strings are the emitted bytes by construction, not a hand-copied duplicate.
/**
 * Run biome only where a biome CONFIG exists, the rule 10bcb1a7 already applied to the agent hooks.
 * Configless biome formats to its own defaults, rewriting bytes a repo's real gate then rejects.
 */
export const FORMAT_TOOL_SETUP = `    if [ ! -f biome.json ] && [ ! -f biome.jsonc ]; then
        echo "🎨 No biome config here (biome.json / biome.jsonc) — staged files left as authored."
        return 0
    fi
    FMT_TOOL=biome; FMT_BIN="$__dk_package_bin_dir/biome"
    __dk_fmt_run() { xargs -0 "$__dk_package_bin_dir/biome" format --write; }`;
/**
 * Extension-only: devkit cannot know a consumer's authored-file boundary, and NOT derived from
 * `sourceExtensions`, whose edits would then each be a hook-drift event. self-host swaps in a scope.
 */
export const FORMAT_EXTENSION_FILTER = "grep -E '\\.(tsx?|jsx?|mts|cts|mjs|css|jsonc?)$'";
/**
 * Consumer policy: REPORT, never block — the bin dir belongs to the consumer, so a hoisting quirk
 * must not become a commit outage. self-host replaces this whole branch with a hard `exit 1`.
 */
// FMT_RC is XARGS's status, not the formatter's (xargs collapses 1-125 into one code of its own),
// so the report points at the tool's diagnostics rather than claiming the number is its exit code.
export const FORMAT_FAILURE_REPORT = `        if [ "$FMT_RC" -eq 127 ]; then
            echo "🎨 $FMT_TOOL is not installed at $FMT_BIN — $FMT_N staged file(s) left UNFORMATTED. Run \\\`devkit doctor --fix\\\`; this commit continues."
        elif [ "$FMT_RC" -ne 0 ]; then
            echo "🎨 $FMT_TOOL failed over $FMT_N staged file(s) (xargs exit $FMT_RC) — some may be UNFORMATTED; its diagnostics are above. This commit continues."
        fi`;
export const FORMAT_FRAGMENT = `# devkit:biome-format
# Format staged files, then re-stage exactly those (scoped — never a blanket \`git add -u\`, which
# would sweep unrelated working-tree changes into the commit). Only re-add files with NO unstaged
# edits, so partially-staged files commit exactly as staged.
#
# EVERY branch reports, and each banner opens with the 🎨 stage anchor ship's log scraper keys on.
# Silence used to be ambiguous: no staged match, a staged set entirely excluded by unstaged edits,
# and a formatter binary that was never on disk all looked identical to a clean format — which is
# how unformatted bytes reached a multi-minute LLM reviewer instead of this sub-second step (sc-2524).
#
# Paths move through this step NUL-delimited (\`-z\` out of git, \`xargs -0\` into the tools) and are
# only ever newline-joined for the two line-oriented set operations in between. Git's default
# output QUOTES any path with a space or a non-ASCII byte ("caf\\303\\251.mts", trailing quote
# included), which the extension filter then fails to match — so such a file was silently never
# formatted. \`echo | xargs\` compounded it by splitting the unquoted form on whitespace, handing the
# formatter two paths that do not exist and making \`git add\` fatal on the pathspec, which \`sh -e\`
# turns into a failed commit. Embedded newlines remain out of scope: nothing here can express them.
#
# Known limit, unchanged: xargs may split a very large FMT_SAFE across several invocations, so
# FMT_RC reflects only the last one.
# A function so the "no formatter here" arm is an early \`return\`, not a branch wrapping the whole
# body — self-host replaces the setup outright, and an unreachable arm must not survive into it.
__dk_format_staged() {
${FORMAT_TOOL_SETUP}
STAGED_FMT=$(git diff --cached --name-only -z --diff-filter=ACM | tr '\\0' '\\n' | ${FORMAT_EXTENSION_FILTER} || true)
if [ -z "$STAGED_FMT" ]; then
    echo "🎨 $FMT_TOOL: no staged formattable path — nothing to format."
else
    UNSTAGED_FMT_FILE=$(mktemp)
    git diff --name-only -z | tr '\\0' '\\n' | sort -u >"$UNSTAGED_FMT_FILE"
    FMT_SAFE=$(printf '%s\\n' "$STAGED_FMT" | grep -Fxvf "$UNSTAGED_FMT_FILE" || true)
    FMT_SKIP=$(printf '%s\\n' "$STAGED_FMT" | grep -Fxf "$UNSTAGED_FMT_FILE" || true)
    rm -f "$UNSTAGED_FMT_FILE"
    # Reported whether the exclusion is TOTAL or PARTIAL. A partial one is the dangerous shape: the
    # success banner counts only what it formatted, so "formatted 3" over a staged set of 5 reads as
    # a clean pass while two unformatted files ride into the commit.
    if [ -n "$FMT_SKIP" ]; then
        echo "🎨 $FMT_TOOL: skipped $(printf '%s\\n' "$FMT_SKIP" | grep -c '') staged path(s) that also carry unstaged edits, because formatting them would commit bytes you never staged:"
        printf '%s\\n' "$FMT_SKIP" | sed 's/^/     /'
    fi
    if [ -z "$FMT_SAFE" ]; then
        echo "🎨 $FMT_TOOL: every eligible path also carries unstaged edits — nothing left to format."
    else
        FMT_N=$(printf '%s\\n' "$FMT_SAFE" | grep -c '' || true)
        FMT_RC=0
        printf '%s\\n' "$FMT_SAFE" | tr '\\n' '\\0' | __dk_fmt_run || FMT_RC=$?
${FORMAT_FAILURE_REPORT}
        printf '%s\\n' "$FMT_SAFE" | tr '\\n' '\\0' | xargs -0 git add -f
        if [ "$FMT_RC" -eq 0 ]; then
            echo "🎨 $FMT_TOOL formatted and re-staged $FMT_N staged file(s)."
        fi
    fi
fi
}
__dk_format_staged
# /devkit:biome-format`;
