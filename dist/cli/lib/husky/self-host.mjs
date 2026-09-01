/**
 * Self-host mode — devkit dogfooding ITSELF via `devkit init`.
 *
 * The problem: a plain `devkit init` treats the repo as a CONSUMER of the published package —
 * it adds `@norvalbv/devkit` as a self-dependency (a package can't depend on itself) and emits a
 * hook that runs the package-local `guard-*` bins → compiled `dist/*.mjs` in node_modules (the last-published
 * build, not the working tree). Both are wrong for the package itself.
 *
 * Self-host is a third install mode (beside `standalone`/`overlay`), auto-selected when the repo's
 * own package.json name is `@norvalbv/devkit`. It adds NO self-dep and generates a SOURCE-mode
 * hook by taking the ordinary generated hook and rewriting each package-local `guard-<x>` to
 * `node gate-engine/<x>.mts`. Only four bins ever appear in the hook (`guard-deterministic`,
 * `guard-decisions`, `guard-review`, `guard-qavis-advisory`) — dup/clone/size/fanout/structure run
 * INSIDE the source-launched `guard-deterministic`, which resolves its own sub-gates by `SELF_EXT`
 * (gate-engine/deterministic/run.mts) → everything runs from source, nothing leaks to dist.
 *
 * The rewrite is a mechanical transform of the SAME generator's output, so a new gate (→ a new
 * `bin` entry, already mandatory) is picked up for free, `devkit upgrade` regenerates the hook, and
 * the parity test (cli/__tests__/self-host.test.mts) makes drift impossible.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultSelection, RECOMMENDED_GUARD_IDS } from '../components.mjs';
import { readJson } from '../fs-helpers.mjs';
import { markEnd } from './husky.mjs';
import { buildFullHook, buildGuardBlock, extractGuardBlock, PACKAGE_BIN_DIR_FRAGMENT, REVIEW_DETERMINISTIC_FINALIZER, replaceGuardBlock, } from './husky-block.mjs';
// devkit's own structure-lint command (package.json `lint:structure` = `eslint cli gate-engine`)
// and its hard Biome lint/assist gate (`lint` disables Biome's formatter explicitly — Biome exits 0 when
// every diagnostic is warn-severity, so without that flag the gate PRINTS its findings into the log
// and passes the commit anyway). The hard-lint is folded into the deterministic orchestrator via
// `--extra` (any non-zero blocks); both run via real devDeps
// (eslint/biome). Formatting is the one self-host-only rewrite beyond guard bins: Devkit has proven
// its pinned Oxfmt output over its own authored scope, while consumer hooks stay on Biome until each
// consumer completes the same parity exercise. Together with the advisory fallow fragment
// below, the self-host hook preserves every gate the pre-self-host hand hook ran AND adds review + dup/clone.
export const SELF_HOST_STRUCTURE_CMD = 'bun run lint:structure';
export const SELF_HOST_EXTRAS = [
    { label: 'lint', cmd: 'bun run lint' },
    // sc-2198. Both are pure content comparisons — no spawn, no tmp dir, no model call — and both
    // already ran, in the 11-minute pre-push suite, which is where they caught a generator edit that
    // had been sitting on main for five hours. Running them here makes the author who breaks parity
    // the one who pays, instead of the next person to push. Two labels, not one: runDeterministic
    // attributes gate_result per label, so a merged label makes a blocked commit unattributable.
    // Self-host only: a consumer generates their hook from THEIR devkit version, so comparing it
    // against this generator is meaningless, and `guard-decisions integrity` already ships as a bin
    // for consumers who want the whole-corpus check.
    { label: 'hook-parity', cmd: 'node cli/lib/husky/hook-parity.mts --gate' },
    { label: 'decisions-integrity', cmd: 'node gate-engine/decisions/cli.mts integrity --staged' },
    { label: 'benchmarks', cmd: 'bun run benchmarks:check -- --mode staged' },
];
// The hand hook ended with an ADVISORY fallow audit (dead-code / duplication / complexity on the
// changed set; command-v-guarded so it no-ops without fallow, `|| true` so it never blocks). The
// package generator emits no fallow fragment and `fallow: false` keeps fallow an opt-in COMPONENT
// (no installer / no wireFallowGate), so this preserves JUST the advisory line — injected as the last
// fragment INSIDE the devkit-guards block (a sentinel'd fragment). Inside, not a trailing tail: an
// out-of-block line gets mis-absorbed into the preamble by replaceGuardBlock's findPreambleEnd on a
// re-run (splitting the comment from its command), and being in-block means the parity/doctor check
// covers it too.
const FALLOW_FRAGMENT = `# devkit:fallow-advisory
# fallow audit — dead-code / duplication / complexity on the changed set; advisory, never blocks.
if [ "\${DEVKIT_RUN_MODE:-}" = "review" ]; then
    __dk_review_baseline_gate fallow || true
else
    # Pin ships to their exact worktree base (DK-5); plain commits retain Fallow's base discovery.
    FALLOW_BASE_ARGS=""
    [ -n "\${DEVKIT_SHIP_BASE_SHA:-}" ] && FALLOW_BASE_ARGS="--base $DEVKIT_SHIP_BASE_SHA"
    # __dk_no_git_env: fallow's audit base-snapshot is itself a git worktree, and it has clobbered a
    # ship worktree before (see commit-with-gate-capture.sh's worktree_head_clobbered banner).
    command -v fallow >/dev/null 2>&1 && __dk_no_git_env fallow audit $FALLOW_BASE_ARGS || true
fi
# /devkit:fallow-advisory`;
// Devkit owns this source-only check and its self-host hook. Consumer hooks never receive the
// fragment, and review-mode replays skip it because they do not represent a pending commit.
const SKILL_PROJECTION_FRAGMENT = `# devkit:self-host-skill-projection-advisory
# Warn when canonical Devkit skills drift from a recorded provider surface or packaged dist.
if [ "\${DEVKIT_RUN_MODE:-}" != "review" ]; then
    __dk_skill_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
    if [ -n "$__dk_skill_root" ]; then
        node "$__dk_skill_root/cli/lib/husky/skill-projection-integrity.mts" --root "$__dk_skill_root" || true
    fi
fi
# /devkit:self-host-skill-projection-advisory`;
// Matches the package-local `guard-<x>` bins the generator emits. `guard-qavis-advisory` (double hyphen) is
// covered by `[a-z-]+`. The formatter has its own exact rewrite below so consumer output is not
// affected by the self-host-only Oxfmt adoption.
const PACKAGE_GUARD_RE = /"\$__dk_package_bin_dir\/(guard-[a-z-]+)"/g;
const PACKAGE_BIOME_FORMAT_RE = /"\$__dk_package_bin_dir\/biome" format --write\b/g;
const BIOME_FORMAT_COMMENT_RE = /Format staged files with biome/g;
const BIOME_FORMAT_EXTENSIONS = '\\.(tsx?|jsx?|css|json|jsonc|mjs)$';
const BIOME_FORMAT_FILTER = `grep -E '${BIOME_FORMAT_EXTENSIONS}'`;
const SELF_HOST_OXFMT_BEST_EFFORT = 'node_modules/.bin/oxfmt --threads 1 --write 2>/dev/null || true';
const SELF_HOST_OXFMT_HARD = 'node_modules/.bin/oxfmt --threads 1 --write || exit 1';
// Keep the staged hook on the same authored-file boundary as package.json's format scripts. A
// broad extension-only filter would let Oxfmt rewrite evidence, fixtures, vendored sources, or
// generated output that the adopted 558-file parity experiment never selected.
const SELF_HOST_FORMAT_FILTER = "grep -E '^((cli|gate-engine)/.*\\.(tsx?|jsx?|css|jsonc?|mjs|mts)|(tsconfig|biome)/.*\\.jsonc?|skills/.*\\.mjs|templates/.*\\.mjs|\\.co-occurrence-allowlist\\.json|\\.fallowrc\\.jsonc|\\.oxfmtrc\\.json|biome\\.jsonc|eslint\\.config\\.mjs|guard\\.config(\\.example)?\\.json|package\\.json|search-code\\.config\\.json|tsconfig(\\.build)?\\.json|vitest(\\.e2e)?\\.config\\.mjs|vitest\\.setup\\.mjs)$'";
// The `./dist/<...>.mjs` → `<...>.mts` transform pieces (hoisted — useTopLevelRegex).
const DIST_PREFIX_RE = /^\.\/dist\//;
const MJS_EXT_RE = /\.mjs$/;
/** True when `cwd` IS the devkit package itself (the only repo self-host mode applies to). */
export function isDevkitRepo(cwd) {
    const pkg = readJson(join(cwd, 'package.json'));
    return pkg?.name === '@norvalbv/devkit';
}
/**
 * Resolve a `guard-*` bin name to its SOURCE `.mts` path, relative to the repo root — the form the
 * committed hook's `node <path>` invocation resolves against at commit time. Derived from the repo's
 * OWN package.json `bin` map (`./dist/gate-engine/review/cli.mjs` → `gate-engine/review/cli.mts`),
 * so a new gate's bin is picked up with no extra wiring. Reads `cwd`'s package.json (the authoritative
 * bin map), never a globally-installed devkit's.
 */
export function sourceBinFor(cwd, binName) {
    const pkg = readJson(join(cwd, 'package.json'));
    const distPath = pkg?.bin?.[binName];
    if (!distPath)
        throw new Error(`self-host: no bin "${binName}" in ${join(cwd, 'package.json')}`);
    return distPath.replace(DIST_PREFIX_RE, '').replace(MJS_EXT_RE, '.mts');
}
/** Rewrite generated consumer commands to Devkit's self-host source/pinned-runtime equivalents. */
export function toSelfHost(hookText, cwd) {
    return (hookText
        .replace(`${PACKAGE_BIN_DIR_FRAGMENT}\n\n`, '')
        .replace(PACKAGE_GUARD_RE, (_m, bin) => `node ${sourceBinFor(cwd, bin)}`)
        .replace(PACKAGE_BIOME_FORMAT_RE, 'node_modules/.bin/oxfmt --threads 1 --write')
        .replace(BIOME_FORMAT_COMMENT_RE, 'Format staged files with Oxfmt')
        // Formatting is a hard self-host responsibility now that Biome lint runs with formatting off.
        // Generic consumer hooks retain their existing best-effort Biome behavior.
        .replace(SELF_HOST_OXFMT_BEST_EFFORT, SELF_HOST_OXFMT_HARD)
        // A replacement callback keeps the regex's terminal `$'` literal; replacement strings treat
        // `$'` as the special token for the unmatched suffix.
        .replace(BIOME_FORMAT_FILTER, () => SELF_HOST_FORMAT_FILTER));
}
/**
 * The canonical devkit-dogfood selection: every recommended component + guard, PLUS `review` (the
 * in-chain reviewer fleet — the whole point of self-host is that devkit gates its own commits with
 * its own reviewers). structureCmd/extras are added at hook-build time (constants above), not here.
 */
export function selfHostSelection(recorded) {
    return {
        ...defaultSelection(),
        // The repo's OWN recorded components survive an upgrade. Without this the fixed selection
        // silently reverted every opt-in the dogfood repo had turned on: `adhd: true` came back as
        // false, which both deleted `.devkit/vendored-skills/i-have-adhd/` (syncAdhdSkill's reclaim
        // branch) and pruned the two hooks the adhd component owns — a component the config still
        // claimed was on. Undefined entries are dropped so an absent key falls through to the default
        // rather than overwriting it with undefined.
        ...definedOnly(recorded),
        // Devkit is the soak environment for the vendored anti-slop policy over core Oxc. Anti-slop
        // stays on even when an older recorded config predates it or explicitly recorded it off.
        antiSlop: true,
        // Guards stay FIXED even so: that is the deliberate part (see upgrade.mts) — a future
        // RECOMMENDED_GUARD_IDS addition must not open an interactive multiselect in the dogfood repo.
        guards: [...RECOMMENDED_GUARD_IDS, 'review'],
    };
}
function definedOnly(recorded) {
    if (!recorded)
        return {};
    return Object.fromEntries(Object.entries(recorded).filter(([key, value]) => key !== 'oxc' && value !== undefined));
}
function withSelfHostFragment(text, pkgRel, fragment) {
    const end = markEnd(pkgRel);
    const anchor = text.includes(REVIEW_DETERMINISTIC_FINALIZER)
        ? REVIEW_DETERMINISTIC_FINALIZER
        : end;
    return text.replace(`\n${anchor}`, `\n\n${fragment}\n\n${anchor}`);
}
function withFallow(text, pkgRel) {
    return withSelfHostFragment(text, pkgRel, FALLOW_FRAGMENT);
}
function withSelfHostAdvisories(text, pkgRel) {
    return withSelfHostFragment(withFallow(text, pkgRel), pkgRel, SKILL_PROJECTION_FRAGMENT);
}
/** The self-host guard BLOCK (markers inclusive) — the shared source of truth for install, doctor, and the parity test. */
export function buildSelfHostBlock(sel, pkgRel, cwd) {
    return withSelfHostAdvisories(toSelfHost(buildGuardBlock(sel, pkgRel), cwd), pkgRel);
}
/** A full fresh self-host hook (preamble + rewritten block incl. self-host advisories + exit 0). */
export function buildSelfHostHook(sel, pkgRel, cwd) {
    return withSelfHostAdvisories(toSelfHost(buildFullHook(sel, pkgRel), cwd), pkgRel);
}
/**
 * Write/refresh the self-host `.husky/pre-commit`. Fresh (or a MARKER-LESS hand-authored hook — the
 * pre-self-host canonical file, which devkit fully owns) → whole-file overwrite with the generated
 * source hook. Only splice-in-place when our `# devkit-guards` markers already exist (idempotent
 * re-run / `devkit upgrade`). The marker-less whole-file replace is what prevents the double-gating
 * trap: `replaceGuardBlock` on a marker-less hook would INSERT a second block above the surviving
 * hand lines. `cwd` (the repo root) feeds the bin→source resolution.
 */
export function installSelfHostHook(gitRoot, pkgRel, sel, dryRun, cwd) {
    const hookSel = {
        ...sel,
        structureCmd: SELF_HOST_STRUCTURE_CMD,
        extras: SELF_HOST_EXTRAS,
    };
    const hookPath = join(gitRoot, '.husky', 'pre-commit');
    const exists = existsSync(hookPath);
    const current = exists ? readFileSync(hookPath, 'utf8') : '';
    const hasBlock = exists && extractGuardBlock(current, pkgRel) !== null;
    if (!exists || !hasBlock) {
        if (dryRun) {
            console.log(`  [dry-run] write .husky/pre-commit (self-host, source gates)${exists ? ' — replacing marker-less hand hook' : ''}`);
            return;
        }
        mkdirSync(join(gitRoot, '.husky'), { recursive: true });
        writeFileSync(hookPath, buildSelfHostHook(hookSel, pkgRel, cwd));
        chmodSync(hookPath, 0o755);
        console.log(`  ✓ ${exists ? 'replaced' : 'created'} .husky/pre-commit (self-host, source gates)`);
        return;
    }
    const merged = replaceGuardBlock(current, buildSelfHostBlock(hookSel, pkgRel, cwd), pkgRel);
    if (merged === current) {
        console.log('  • .husky/pre-commit already wired (self-host block current)');
        return;
    }
    if (dryRun) {
        console.log('  [dry-run] refresh self-host devkit-guards block in .husky/pre-commit');
        return;
    }
    writeFileSync(hookPath, merged);
    console.log('  ✓ refreshed self-host devkit-guards block in .husky/pre-commit');
}
