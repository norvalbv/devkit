/** The format-staged-files step: Oxfmt where an Oxfmt config exists, from devkit or the repo. */

/** A formatter the pre-commit step can run: `bin` under the mode's bin dir, then `stepArgs`. */
export interface StepFormatter {
  tool: string;
  bin: string;
  /** Non-empty: an empty list would render `if ; then`. */
  configProbes: readonly [string, ...string[]];
  stepArgs: string;
  /** Formats stdin as the named path; the step appends that path directly after this. */
  stdinArgs: string;
}

// Exactly the names Oxfmt discovers; the Oxc lifecycle manages the same set.
export const OXFMT_CONFIGS: [string, ...string[]] = [
  '.oxfmtrc.json',
  '.oxfmtrc.jsonc',
  'oxfmt.config.ts',
  'oxfmt.config.mts',
];

export const OXFMT_WRITE_ARGS = '--no-error-on-unmatched-pattern --write';
export const OXFMT_CHECK_ARGS = '--no-error-on-unmatched-pattern --check';
const SCRIPT_GLOB = "'**/*.{ts,tsx,js,jsx,mts,cts,mjs,css,json,jsonc}'";

// The consumer formatter, stated once: the package-mode step and package.json scripts render from it.
// devkit writes this config, so devkit's pinned Oxfmt runs it: no devDependency, no hoisted bin.
export const CONSUMER_FORMATTER = {
  tool: 'oxfmt',
  bin: 'devkit',
  configProbes: OXFMT_CONFIGS,
  stepArgs: `oxc fmt ${OXFMT_WRITE_ARGS}`,
  stdinArgs: 'oxc fmt --stdin-filepath=',
  scripts: {
    lint: `devkit oxc fmt --check --no-error-on-unmatched-pattern ${SCRIPT_GLOB} && devkit oxc lint`,
    format: `devkit oxc fmt --no-error-on-unmatched-pattern ${SCRIPT_GLOB}`,
  },
} as const satisfies StepFormatter & { scripts: { lint: string; format: string } };
export type ConsumerFormatter = typeof CONSUMER_FORMATTER;

/** Overlay: the repo owns its formatter, so its own pinned Oxfmt runs its own config. */
export const OXFMT_STEP: StepFormatter = {
  tool: 'oxfmt',
  bin: 'oxfmt',
  configProbes: OXFMT_CONFIGS,
  stepArgs: OXFMT_WRITE_ARGS,
  stdinArgs: '--stdin-filepath=',
};

// The three constants toSelfHost re-points (tool setup, failure policy, scope) are interpolated
// below, so its search strings are the emitted bytes by construction, not a hand-copied duplicate.

/** The step's handles on one formatter: path mode over NUL-delimited paths, and stdin as one path. */
function renderToolRunners(f: StepFormatter, bin: string): string {
  return `        FMT_TOOL=${f.tool}; FMT_BIN=${bin}; FMT_FIX_ARGS='${f.stepArgs}'
        __dk_fmt_run() { xargs -0 ${bin} ${f.stepArgs}; }
        __dk_fmt_stdin() { ${bin} ${f.stdinArgs}"$1"; }`;
}

/** The first formatter whose config exists wins; a missing binary stands down rather than fail. */
export function renderToolChain(fs: StepFormatter[], binDir: string): string {
  const arms = fs.map((f) => {
    const bin = `"${binDir}/${f.bin}"`;
    return `if ${f.configProbes.map((p) => `[ -f ${p} ]`).join(' || ')}; then
        if [ ! -x ${bin} ]; then
            echo "🎨 Found the ${f.tool} config but ${binDir}/${f.bin} is missing — install this repo's dependencies; staged files left as authored."
            return 0
        fi
${renderToolRunners(f, bin)}`;
  });
  const probes = fs.flatMap((f) => f.configProbes).join(' / ');
  return `    ${arms.join('\n    el')}
    else
        echo "🎨 No formatter config here (${probes}) — staged files left as authored."
        return 0
    fi`;
}

/** The exact lines each agent hook must carry for the consumer formatter: its config gate, binary
 *  check, invocation and fix hint — whole lines, rendered here and compared verbatim by the gate. */
export interface AgentHookLines {
  'agents-hooks/format-after-edit.sh': string[];
  'agents-hooks/lint-check.sh': string[];
}

/** Trails every rendered line, so whoever edits one in a hook sees the lock on the line itself. */
export const AGENT_HOOK_MARKER =
  '# devkit: must equal renderAgentHookLines (cli/lib/husky/format-fragment.mts)';

const marked = (lines: string[]): string[] => lines.map((l) => `${l} ${AGENT_HOOK_MARKER}`);

/** The agent hooks run the repo's own Oxfmt bin: devkit's hoisted pin in package mode, the repo's
 *  own in overlay. Standalone has none there, so the hooks skip and the commit step formats. */
export function renderAgentHookLines(f: StepFormatter = OXFMT_STEP): AgentHookLines {
  const bin = `./node_modules/.bin/${f.bin}`;
  const gate = `{ ${f.configProbes.map((p) => `[ -f "${p}" ]`).join(' || ')}; } && [ -x "${bin}" ]`;
  return {
    'agents-hooks/format-after-edit.sh': marked([
      `if [[ "$file_path" =~ ${FORMAT_EXTENSIONS} ]] && ${gate}; then`,
      `  "${bin}" ${OXFMT_WRITE_ARGS} "$file_path" >/dev/null 2>&1 || true`,
    ]),
    'agents-hooks/lint-check.sh': marked([
      `if ${gate}; then`,
      `    lint_output=$("${bin}" ${OXFMT_CHECK_ARGS} "\${oxfmt_files[@]}" 2>&1)`,
      `      echo "Run '${bin} --write <file>' to auto-fix." >&2`,
    ]),
  };
}

/**
 * Extension-only: devkit cannot know a consumer's authored-file boundary, and NOT derived from
 * `sourceExtensions`, whose edits would then each be a hook-drift event. self-host swaps in a scope.
 */
export const FORMAT_EXTENSIONS = '\\.(tsx?|jsx?|mts|cts|mjs|cjs|css|jsonc?)$';
export const FORMAT_EXTENSION_FILTER = `grep -E '${FORMAT_EXTENSIONS}'`;

/**
 * Consumer policy: REPORT, never block — the bin dir belongs to the consumer, so a hoisting quirk
 * must not become a commit outage. self-host replaces this whole branch with a hard `exit 1`.
 */

// Defined ONCE so self-host's single replace converts every caller. Args: status, what, status label;
// the path branch labels xargs's status, which collapses 1-125, so it is not the tool's exit code.
export const FORMAT_FAILURE_REPORT = `__dk_fmt_failed() {
    if [ "$1" -eq 127 ]; then
        echo "🎨 $FMT_TOOL is missing or cannot start at $FMT_BIN — $2 left UNFORMATTED. Install this repo's dependencies; this commit continues."
    else
        echo "🎨 $FMT_TOOL failed over $2 ($3 $1) — some may be UNFORMATTED; its diagnostics are above. This commit continues."
    fi
}`;

// Index-blob rewrite (the git-format-staged technique): the bytes being committed are formatted
// through stdin and written back to the index, so the working copy and its unstaged edits stay put.
const STAGED_COPY_STEP = `    if [ -n "$FMT_SKIP" ]; then
        FMT_TMP=$(mktemp -d); : >"$FMT_TMP/done"; : >"$FMT_TMP/left"; FMT_STDIN_RC=0
        while IFS= read -r fmt_path; do
            # Literal pathspec and the blob's oid: a \`:path\` revision misreads \`0:a.ts\` as stage 0 of a.ts.
            fmt_entry=$(git --literal-pathspecs ls-files -s -- "$fmt_path" </dev/null)
            fmt_mode=\${fmt_entry%% *}; fmt_oid=\${fmt_entry#* }; fmt_oid=\${fmt_oid%% *}
            case "$fmt_mode" in 100644 | 100755) ;; *) printf '%s\\n' "$fmt_path" >>"$FMT_TMP/left"; continue ;; esac
            # Biome applies its ignore config on stdin only to a path that exists on disk.
            if [ ! -e "$fmt_path" ]; then printf '%s\\n' "$fmt_path" >>"$FMT_TMP/left"; continue; fi
            git cat-file blob "$fmt_oid" >"$FMT_TMP/in" </dev/null
            [ -s "$FMT_TMP/in" ] || continue
            fmt_rc=0; __dk_fmt_stdin "$fmt_path" <"$FMT_TMP/in" >"$FMT_TMP/out" || fmt_rc=$?
            if [ "$fmt_rc" -ne 0 ] || [ ! -s "$FMT_TMP/out" ]; then
                [ "$fmt_rc" -eq 0 ] || FMT_STDIN_RC=$fmt_rc
                printf '%s\\n' "$fmt_path" >>"$FMT_TMP/left"; continue
            fi
            cmp -s "$FMT_TMP/in" "$FMT_TMP/out" && continue
            if fmt_oid=$(git hash-object -w --path="$fmt_path" --stdin <"$FMT_TMP/out") &&
                git update-index --cacheinfo "$fmt_mode,$fmt_oid,$fmt_path" </dev/null; then
                printf '%s\\n' "$fmt_path" >>"$FMT_TMP/done"
            else
                printf '%s\\n' "$fmt_path" >>"$FMT_TMP/left"
            fi
        done <<EOF
$FMT_SKIP
EOF
        if [ -s "$FMT_TMP/done" ]; then
            echo "🎨 $FMT_TOOL formatted the STAGED copy of $(grep -c '' "$FMT_TMP/done") path(s) that also carry unstaged edits; their working copies are untouched (to format those too, run: $FMT_BIN $FMT_FIX_ARGS <path>):"
            sed 's/^/     /' "$FMT_TMP/done"
        fi
        if [ -s "$FMT_TMP/left" ]; then
            echo "🎨 $FMT_TOOL left $(grep -c '' "$FMT_TMP/left") staged path(s) with unstaged edits exactly as staged, possibly UNFORMATTED (deleted from the working tree, or not formattable):"
            sed 's/^/     /' "$FMT_TMP/left"
        fi
        if [ ! -s "$FMT_TMP/done" ] && [ ! -s "$FMT_TMP/left" ]; then
            echo "🎨 $FMT_TOOL: the staged copy of every path that also carries unstaged edits is already formatted."
        fi
        rm -rf "$FMT_TMP"
        [ "$FMT_STDIN_RC" -eq 0 ] || __dk_fmt_failed "$FMT_STDIN_RC" "the staged copies listed above" "exit"
    fi`;

/** The package-mode tool setup, which toSelfHost swaps for devkit's own pinned Oxfmt. */
export const FORMAT_TOOL_SETUP = renderToolChain([CONSUMER_FORMATTER], '$__dk_package_bin_dir');

/** The format step, running `chain`'s first configured formatter from the mode's `binDir`. */
export const formatFragment = (binDir: string, chain: StepFormatter[]) => `# devkit:format
# Format staged files, then re-stage exactly those (scoped — never a blanket \`git add -u\`, which
# would sweep unrelated working-tree changes into the commit). Only re-add files with NO unstaged
# edits; a partially-staged file has only its staged copy formatted, in the index.
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
${renderToolChain(chain, binDir)}
${FORMAT_FAILURE_REPORT}
# -M100%: an edited rename lists as A under its new path; an exact move stays R, skipped so its
# bytes, and the rename the later gates key on, are left untouched.
STAGED_FMT=$(git diff --cached --name-only -z -M100% --diff-filter=ACM | tr '\\0' '\\n' | ${FORMAT_EXTENSION_FILTER} || true)
if [ -z "$STAGED_FMT" ]; then
    echo "🎨 $FMT_TOOL: no staged formattable path — nothing to format."
else
    UNSTAGED_FMT_FILE=$(mktemp)
    git diff --name-only -z | tr '\\0' '\\n' | sort -u >"$UNSTAGED_FMT_FILE"
    FMT_SAFE=$(printf '%s\\n' "$STAGED_FMT" | grep -Fxvf "$UNSTAGED_FMT_FILE" || true)
    FMT_SKIP=$(printf '%s\\n' "$STAGED_FMT" | grep -Fxf "$UNSTAGED_FMT_FILE" || true)
    rm -f "$UNSTAGED_FMT_FILE"
${STAGED_COPY_STEP}
    if [ -n "$FMT_SAFE" ]; then
        FMT_N=$(printf '%s\\n' "$FMT_SAFE" | grep -c '' || true)
        FMT_RC=0
        printf '%s\\n' "$FMT_SAFE" | tr '\\n' '\\0' | __dk_fmt_run || FMT_RC=$?
        [ "$FMT_RC" -eq 0 ] || __dk_fmt_failed "$FMT_RC" "$FMT_N staged file(s)" "xargs exit"
        printf '%s\\n' "$FMT_SAFE" | tr '\\n' '\\0' | xargs -0 git add -f
        if [ "$FMT_RC" -eq 0 ]; then
            echo "🎨 $FMT_TOOL formatted and re-staged $FMT_N staged file(s)."
        fi
    fi
fi
}
__dk_format_staged
# /devkit:format`;
