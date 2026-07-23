/**
 * Self-host mode — devkit dogfooding ITSELF via `devkit init`.
 *
 * The problem: a plain `devkit init` treats the repo as a CONSUMER of the published package —
 * it adds `@norvalbv/devkit` as a self-dependency (a package can't depend on itself) and emits a
 * hook that runs `bunx guard-*` → the compiled `dist/*.mjs` in node_modules (the last-published
 * build, not the working tree). Both are wrong for the package itself.
 *
 * Self-host is a third install mode (beside `standalone`/`overlay`), auto-selected when the repo's
 * own package.json name is `@norvalbv/devkit`. It adds NO self-dep and generates a SOURCE-mode
 * hook by taking the ordinary generated hook and rewriting each `bunx guard-<x>` to
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
import { defaultSelection, RECOMMENDED_GUARD_IDS, type Selection } from '../components.mts';
import { readJson } from '../fs-helpers.mts';
import { buildCommitMsgBlock, installCommitMsgHook } from './commit-msg-block.mts';
import { markEnd } from './husky.mts';
import {
  buildFullHook,
  buildGuardBlock,
  extractGuardBlock,
  replaceGuardBlock,
} from './husky-block.mts';

// devkit's own structure-lint command (package.json `lint:structure` = `eslint cli gate-engine`)
// and its hard biome-lint gate (`lint` = `biome check .`). The hard-lint is folded into the
// deterministic orchestrator via `--extra` (any non-zero blocks); both run via real devDeps
// (eslint/biome), so toSelfHost leaves them untouched. Together with the advisory fallow fragment
// below, the self-host hook preserves every gate the pre-self-host hand hook ran AND adds review + dup/clone.
export const SELF_HOST_STRUCTURE_CMD = 'bun run lint:structure';
export const SELF_HOST_EXTRAS: Array<{ label: string; cmd: string }> = [
  { label: 'lint', cmd: 'bun run lint' },
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

// The hook-builder's view of the self-host selection (Selection + the two hook-only fields the
// generator reads). structureCmd/extras are constant for self-host — seeded here, never persisted.
type SelfHostHookInput = Selection & {
  structureCmd?: string;
  extras?: Array<{ label: string; cmd: string }>;
};

// Matches the `bunx guard-<x>` bins the generator emits. `guard-qavis-advisory` (double hyphen) is
// covered by `[a-z-]+`. `bunx biome` has no `guard-` prefix → correctly left alone.
const BUNX_GUARD_RE = /\bbunx (guard-[a-z-]+)\b/g;
// The `./dist/<...>.mjs` → `<...>.mts` transform pieces (hoisted — useTopLevelRegex).
const DIST_PREFIX_RE = /^\.\/dist\//;
const MJS_EXT_RE = /\.mjs$/;

/** True when `cwd` IS the devkit package itself (the only repo self-host mode applies to). */
export function isDevkitRepo(cwd: string): boolean {
  const pkg = readJson(join(cwd, 'package.json')) as { name?: string } | null;
  return pkg?.name === '@norvalbv/devkit';
}

/**
 * Resolve a `guard-*` bin name to its SOURCE `.mts` path, relative to the repo root — the form the
 * committed hook's `node <path>` invocation resolves against at commit time. Derived from the repo's
 * OWN package.json `bin` map (`./dist/gate-engine/review/cli.mjs` → `gate-engine/review/cli.mts`),
 * so a new gate's bin is picked up with no extra wiring. Reads `cwd`'s package.json (the authoritative
 * bin map), never a globally-installed devkit's.
 */
export function sourceBinFor(cwd: string, binName: string): string {
  const pkg = readJson(join(cwd, 'package.json')) as { bin?: Record<string, string> } | null;
  const distPath = pkg?.bin?.[binName];
  if (!distPath) throw new Error(`self-host: no bin "${binName}" in ${join(cwd, 'package.json')}`);
  return distPath.replace(DIST_PREFIX_RE, '').replace(MJS_EXT_RE, '.mts');
}

/** Rewrite every `bunx guard-<x>` in a generated hook to `node <source .mts>`. */
export function toSelfHost(hookText: string, cwd: string): string {
  return hookText.replace(BUNX_GUARD_RE, (_m, bin: string) => `node ${sourceBinFor(cwd, bin)}`);
}

/**
 * The canonical devkit-dogfood selection: every recommended component + guard, PLUS `review` (the
 * in-chain reviewer fleet — the whole point of self-host is that devkit gates its own commits with
 * its own reviewers). structureCmd/extras are added at hook-build time (constants above), not here.
 */
export function selfHostSelection(): Selection {
  return { ...defaultSelection(), guards: [...RECOMMENDED_GUARD_IDS, 'review'] };
}

// Inject the fallow fragment as the last member of the devkit-guards block (just before its end
// marker), in both the block-only and full-hook forms so they stay consistent.
function withFallow(text: string, pkgRel: string): string {
  const end = markEnd(pkgRel);
  return text.replace(`\n${end}`, `\n\n${FALLOW_FRAGMENT}\n${end}`);
}

/** The self-host guard BLOCK (markers inclusive) — the shared source of truth for install, doctor, and the parity test. */
export function buildSelfHostBlock(sel: SelfHostHookInput, pkgRel: string, cwd: string): string {
  return withFallow(toSelfHost(buildGuardBlock(sel, pkgRel), cwd), pkgRel);
}

/** A full fresh self-host hook (preamble + rewritten block incl. the advisory fallow fragment + exit 0). */
export function buildSelfHostHook(sel: SelfHostHookInput, pkgRel: string, cwd: string): string {
  return withFallow(toSelfHost(buildFullHook(sel, pkgRel), cwd), pkgRel);
}

/** The source-mode commit-message block, generated by the shared completeness/sentry builder. */
export function buildSelfHostCommitMsgBlock(
  sel: Selection,
  pkgRel: string,
  cwd: string,
): string | null {
  const block = buildCommitMsgBlock(sel, pkgRel);
  return block === null ? null : toSelfHost(block, cwd);
}

/** Install the shared commit-message judges with self-host source-path rewrites. */
export function installSelfHostCommitMsgHook(
  gitRoot: string,
  pkgRel: string,
  sel: Selection,
  dryRun: boolean,
  cwd: string,
) {
  installCommitMsgHook(gitRoot, pkgRel, sel, {
    dryRun,
    rewrite: (text) => toSelfHost(text, cwd),
  });
}

/**
 * Write/refresh the self-host `.husky/pre-commit`. Fresh (or a MARKER-LESS hand-authored hook — the
 * pre-self-host canonical file, which devkit fully owns) → whole-file overwrite with the generated
 * source hook. Only splice-in-place when our `# devkit-guards` markers already exist (idempotent
 * re-run / `devkit upgrade`). The marker-less whole-file replace is what prevents the double-gating
 * trap: `replaceGuardBlock` on a marker-less hook would INSERT a second block above the surviving
 * hand lines. `cwd` (the repo root) feeds the bin→source resolution.
 */
export function installSelfHostHook(
  gitRoot: string,
  pkgRel: string,
  sel: Selection,
  dryRun: boolean,
  cwd: string,
) {
  const hookSel: SelfHostHookInput = {
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
      console.log(
        `  [dry-run] write .husky/pre-commit (self-host, source gates)${exists ? ' — replacing marker-less hand hook' : ''}`,
      );
      return;
    }
    mkdirSync(join(gitRoot, '.husky'), { recursive: true });
    writeFileSync(hookPath, buildSelfHostHook(hookSel, pkgRel, cwd));
    chmodSync(hookPath, 0o755);
    console.log(
      `  ✓ ${exists ? 'replaced' : 'created'} .husky/pre-commit (self-host, source gates)`,
    );
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

/** Install both self-host hook phases; keep init's size-capped orchestration thin. */
export function installSelfHostHooks(
  gitRoot: string,
  pkgRel: string,
  sel: Selection,
  dryRun: boolean,
  cwd: string,
) {
  installSelfHostHook(gitRoot, pkgRel, sel, dryRun, cwd);
  installSelfHostCommitMsgHook(gitRoot, pkgRel, sel, dryRun, cwd);
}
