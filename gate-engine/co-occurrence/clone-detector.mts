#!/usr/bin/env node
/**
 * clone-detector — copy-paste / sub-chunk / molecule / renamed-helper detector.
 *
 * Wraps jscpd (Rabin-Karp, boundary-free) to catch duplication the embedding
 * matcher (matcher.mjs) misses: blocks duplicated INSIDE a larger symbol
 * (sub-chunk), repeated inline JSX ("molecules") and, via --similarity, helpers renamed —
 * complements, doesn't replace, the semantic matcher.
 *
 * Shells the jscpd CLI (avoids ESM/CJS interop); parses its JSON report. Each
 * clone is keyed by a hash of its file pair and normalised fragment, NOT a line
 * range — so an allowlist approval survives unrelated edits and only re-surfaces
 * when the duplicated code itself changes. --changed blocks only clones absent from HEAD.
 *
 * ── Portability (W-3) ────────────────────────────────────────────────────────
 * Scan roots (--paths default), the allowlist, and the jscpd cwd all resolve
 * against the CONSUMER cwd (process.cwd()) via resolveGuardConfig — never the
 * package dir. --paths / --min-tokens default from config.scanRoots /
 * config.thresholds.minTokens. jscpd resolves JSCPD_BIN env → devkit-own / hoist /
 * consumer .bin → bare `jscpd` on PATH (global install); a missing jscpd fails OPEN (no crash).
 *
 * Usage:
 *   guard-clone scan [--min-tokens 50] [--paths "src/renderer src/main"]
 *   guard-clone json   # machine-readable clones
 *   guard-clone scan --changed --gate
 *       # commit gate: clones touching a staged file (--changed, set via
 *       # MATCHER_CHANGED_FILES or git), not covered by a live allowlist clone.
 *       # exit 1 = new clone → block · 0 = clean · 2 = could-not-run → fail-open.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveFromCwd, resolveGuardConfig } from '../config.mts';
import { exitGate, failLine } from '../deterministic/reason.mts';
import { ALLOWLIST_CLI, loadAllowlist } from './allowlist-io.mts';
import { flagReader } from './argv.mts';
import { loadChangedSet } from './changed-files.mts';
import { isExpired } from './decay.mts';
import { JSCPD_OWN_ROOT, jscpdVersionMismatch, resolveJscpdBin } from './jscpd-bin.mts';

// Resolve config against the consumer cwd (W-3). Scan roots, allowlist, jscpd cwd all key off it.
const cfg = resolveGuardConfig(process.cwd());
const repoRoot = cfg.cwd;
const repoRootReal = realpathSync(repoRoot);
// Allowlist: CO_OCCURRENCE_ALLOWLIST env (fixtures/tests) wins; else config.allowlistPath.
const allowlistPath = process.env.CO_OCCURRENCE_ALLOWLIST ?? resolveFromCwd(cfg, 'allowlistPath');
// Approval-hint CLI on a gate block — default = the engine's own guard-dup-allowlist bin,
// bare (no `bunx`): on a global devkit install it's a PATH sibling of this gate, where
// `bunx <name>` would 404. A consumer can override via GUARD_ALLOWLIST_CLI. The printed
// command double-quotes args; assumes paths/hashes are shell-safe (git-tracked paths + hex).
const CO_SCRIPT = process.env.GUARD_ALLOWLIST_CLI || ALLOWLIST_CLI;

const DEFAULTS = {
  // Token-clone floor + scan roots seed from the resolved config (consumer-tunable);
  // CLI --flags override per run.
  minTokens: cfg.thresholds.minTokens,
  similarity: cfg.thresholds.similarity,
  // cloneRoots, not scanRoots: verbatim-clone scope is often deliberately narrower than the
  // matcher's. Unset, it resolves back to scanRoots (see config.mts).
  paths: cfg.cloneRoots,
  // Test boilerplate duplication is out of scope (dominates clone counts).
  ignore: ['**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/__mocks__/**'],
};

// jscpd auto-detects formats by extension; we keep only source code clones. Must cover the
// module-suffixed extensions (.mts/.cts/.mjs/.cjs — jscpd tokenizes all of them): devkit's own
// scanRoots are pure .mts, so excluding them made this gate report 0 repo-wide (vacuous).
const CODE_EXT = /\.([cm]?[tj]s|[tj]sx)$/;

// jscpd bin resolution lives in the side-effect-free ./jscpd-bin.mts (shared with the prefix-cache
// config-fingerprint, which folds the SAME resolution into the cache key). Read JSCPD_BIN here (not as
// a default inside the resolver) so the resolver stays pure — a caller can express "no env override"
// as `env: undefined` without it silently re-reading process.env.
const JSCPD_BIN = resolveJscpdBin({
  env: process.env.JSCPD_BIN,
  ownRoot: JSCPD_OWN_ROOT,
  repoRoot,
});

/** A line locator in a jscpd clone: either a bare line number or a `{ line }` object. */
type CloneLineLoc = number | { line: number };

/** A normalised clone pair (cross-file by default; same-file when requested). */
export interface Clone {
  fragmentHash: string;
  /** jscpd's kind: `exact` token clone, or `similar` (same-structure functions, `similarity` score). */
  kind: string;
  similarity?: number;
  lines: number;
  tokens: number;
  fileA: string;
  startA: CloneLineLoc;
  endA: CloneLineLoc;
  fileB: string;
  startB: CloneLineLoc;
  endB: CloneLineLoc;
  fragment: string;
}

// The pieces of jscpd's JSON report we read (external-data shape).
interface JscpdFileEntry {
  name: string;
  start: number;
  end: number;
  startLoc?: { line: number };
  endLoc?: { line: number };
}
interface JscpdDuplicate {
  fragment?: string;
  kind: string;
  similarity?: number;
  isNew?: boolean;
  lines: number;
  tokens: number;
  firstFile: JscpdFileEntry;
  secondFile: JscpdFileEntry;
}
interface JscpdReport {
  duplicates?: JscpdDuplicate[];
}

interface DetectClonesOptions {
  minTokens?: number;
  similarity?: number;
  paths?: string[];
  includeSameFile?: boolean;
  /** Keep only clones absent from this git ref (jscpd's `--baseline-from-ref`). */
  baseRef?: string | null;
}

/**
 * Run jscpd over `paths` and return normalised clone pairs.
 * Cross-file only by default — a block repeated WITHIN one file is a local
 * refactor, out of scope for the cross-file reuse story (and the noisiest:
 * near-dup fragments fragment into many overlapping entries). Pass
 * `includeSameFile: true` to also return intra-file clones.
 */
export function detectClones({
  minTokens = DEFAULTS.minTokens,
  similarity = DEFAULTS.similarity,
  paths = DEFAULTS.paths,
  includeSameFile = false,
  baseRef = null,
}: DetectClonesOptions = {}): Clone[] {
  // jscpd only warns on a ratio outside (0, 1] and skips the similarity pass.
  if (!(similarity > 0 && similarity <= 1)) {
    throw new Error(`thresholds.similarity must be in (0, 1], got ${similarity}`);
  }
  const out = mkdtempSync(join(tmpdir(), 'jscpd-'));
  // finally guarantees the temp report dir is removed on every path — jscpd
  // failure, malformed report, or a throw inside the parse/map.
  try {
    try {
      const mismatch = jscpdVersionMismatch(JSCPD_BIN);
      if (mismatch) throw new Error(mismatch);
      execFileSync(
        JSCPD_BIN,
        [
          ...paths,
          '--min-tokens',
          String(minTokens),
          // 3, not jscpd's 5: a copied helper is often 3-4 lines. One run serves both kinds, since
          // splitting them let the ast pass claim a name-only copy as exact and drop it.
          '--min-lines',
          '3',
          `--similarity=${similarity}`,
          '-a',
          ...(baseRef ? ['--baseline-from-ref', baseRef] : []),
          '--mode',
          'mild',
          '--reporters',
          'json',
          '--output',
          out,
          '--ignore',
          DEFAULTS.ignore.join(','),
          '--ignore-pattern',
          IMPORT_IGNORE_PATTERNS.join(','),
          '--silent',
        ],
        { cwd: repoRoot, stdio: ['ignore', 'ignore', 'pipe'] },
      );
    } catch (e: unknown) {
      // jscpd exits non-zero only with --threshold (we set none), so a throw here is a real
      // failure: a missing or wrong-version binary, or a base ref it could not check out.
      const stderr = e instanceof Error && 'stderr' in e ? String(e.stderr).trim() : '';
      const why = stderr.split('\n')[0] || (e instanceof Error ? e.message : String(e));
      throw new Error(`jscpd could not run: ${why}`);
    }

    const reportPath = join(out, 'jscpd-report.json');
    if (!existsSync(reportPath)) return [];
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as JscpdReport;

    return (report.duplicates ?? [])
      .filter((d) => CODE_EXT.test(d.firstFile.name) && CODE_EXT.test(d.secondFile.name))
      .filter((d) => includeSameFile || d.firstFile.name !== d.secondFile.name)
      .filter((d) => !baseRef || d.isNew)
      .map((d) => ({
        fragmentHash: cloneKey(relPath(d.firstFile.name), relPath(d.secondFile.name), d.fragment),
        kind: d.kind,
        similarity: d.similarity,
        lines: d.lines,
        tokens: d.tokens,
        fileA: relPath(d.firstFile.name),
        startA: d.firstFile.startLoc ?? d.firstFile.start,
        endA: d.firstFile.endLoc ?? d.firstFile.end,
        fileB: relPath(d.secondFile.name),
        startB: d.secondFile.startLoc ?? d.secondFile.start,
        endB: d.secondFile.endLoc ?? d.secondFile.end,
        fragment: d.fragment ?? '',
      }))
      .sort((a, b) => b.lines - a.lines);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const BACKSLASH_RE = /\\/g;
const WHITESPACE_RE = /\s+/g;
/**
 * Repo-root-relative, forward-slash allowlist key. Repo-root-relative is the ONLY normalisation:
 * it is what git reports, so `--changed` scoping and the allowlist agree with the paths a human
 * sees. An earlier `/^.*\/src\//` → `src/` rewrite collapsed every scan root containing `/src/`
 * onto a phantom top-level `src/`, which (a) fused two real files onto one allowlist key, so
 * approving one silently approved the other, and (b) made `--changed` compare a path that does
 * not exist against git's real one, dropping every non-first-root clone out of the scoped gate.
 */
export function relPath(f: string): string {
  // Normalize BOTH sides to '/' before stripping: on Windows the reported path and repoRoot can
  // disagree on separator, and a one-sided normalisation simply never matches, leaving every key
  // absolute. Strip against the CONSUMER cwd (repoRoot = cfg.cwd), not the package dir — and only
  // as a PREFIX, so a repo path that happens to recur mid-string is left alone.
  const path = f.replace(BACKSLASH_RE, '/');
  // jscpd -a reports realpaths (macOS /tmp → /private/tmp), so strip either spelling of the root.
  for (const r of [repoRoot, repoRootReal]) {
    const root = r.replace(BACKSLASH_RE, '/');
    if (path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  }
  return path;
}

/**
 * Import/re-export declarations are excluded from clone detection AT THE TOKENIZER, via jscpd's
 * `--ignore-pattern` (each entry becomes an ignore token rule in the format grammar; matched
 * text never enters any fragment). Two modules using the same shared libs are FORCED into
 * identical, linter-sorted import preambles — the module system working, not copy-paste debt —
 * and a big enough preamble clears the min-tokens floor on its own, false-blocking sibling
 * files. Removing imports up front gives the clean semantic "clones are measured over
 * non-import code": nothing can ride a preamble over the token floor, and nothing real can hide
 * behind one. (A post-hoc fragment classifier was tried first; six reviewer-verified holes —
 * ratio leaks, dynamic import(...), quote-terminated statements, import attributes — showed
 * that design to be unfixable. See the gate-contract tests.)
 *
 * Each pattern is bounded so it can never span arbitrary code: single-line forms forbid `\n`,
 * the multi-line named form crosses lines only inside `{...}` and requires the `} from '...'`
 * closer. Dynamic `import(...)` is runtime code and deliberately matches none of them. jscpd's
 * CLI comma-splits this option, so patterns must stay comma-free. Unmatched exotic shapes
 * (import attributes, default+named multi-line) fall through to normal tokenization — the safe
 * direction: worst case a clone REPORTS and the allowlist is the remedy, never the reverse.
 */
export const IMPORT_IGNORE_PATTERNS = [
  // Named / namespace-in-braces, incl. multi-line specifier lists: import [type] { ... } from 'x';
  String.raw`import\s*(type\s+)?\{[^}]*\}\s*from\s*['"][^'"]+['"];?`,
  // Default / namespace, single-line only: import foo from 'x'; import * as ns from 'x';
  String.raw`import\s+(type\s+)?[\w$*][^\n]*?from\s*['"][^'"]+['"];?`,
  // Side-effect: import 'x';
  String.raw`import\s*['"][^'"]+['"];?`,
  // Re-export barrels: export { a } from 'x'; / export * from 'x';
  String.raw`export\s*(\{[^}]*\}|\*)\s*from\s*['"][^'"]+['"];?`,
];

/** Stable key: hash the fragment with whitespace collapsed so reformatting
 * doesn't change the key, but real code changes do. */
export function hashFragment(fragment: string): string {
  const normalised = fragment.replace(WHITESPACE_RE, ' ').trim();
  return createHash('sha256').update(normalised).digest('hex').slice(0, 16);
}

/** Allowlist key: the file pair plus the fragment, so approving one copy never approves a third. */
function cloneKey(fileA: string, fileB: string, fragment = ''): string {
  return hashFragment(`${[fileA, fileB].sort().join(' ')} ${fragment}`);
}

/** Whether repo-relative `file` sits under one of the scan `paths` (`.` covers everything). */
function underPaths(file: string, paths: string[]): boolean {
  return paths.some((p) => {
    const root = relative(repoRoot, resolve(repoRoot, p)).replace(BACKSLASH_RE, '/');
    return root === '' || file.startsWith(`${root}/`);
  });
}

/** HEAD when it exists; null on an unborn branch or outside git (every clone is then new). */
function bornHead(): string | null {
  try {
    execFileSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    return 'HEAD';
  } catch {
    return null;
  }
}

/** Fragment hashes of clones already approved AND still live (non-expired) in the
 * allowlist — the gate surfaces only clones not in this set. The CloneAllowlistEntry shape,
 * the corruption-refusing loader (fail-open exit 2 on a corrupt-but-present file, so an
 * approved clone never re-surfaces as novel and false-blocks), and the atomic writer all
 * live in ./allowlist-io.mts, shared with the matcher + the guard-dup-allowlist CLI. */
function liveAllowlistedHashes(): Set<string> {
  if (allowlistPath == null) return new Set<string>();
  const { clones } = loadAllowlist(allowlistPath, 'clone-detector');
  return new Set(clones.filter((c) => !isExpired(c)).map((c) => c.fragmentHash));
}

type CloneLocSide = 'startA' | 'endA' | 'startB' | 'endB';
const loc = (c: Clone, side: CloneLocSide): number => {
  const v = c[side];
  return typeof v === 'number' ? v : v.line;
};

// ── CLI ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const mode = argv[0] ?? 'scan';
const flag = flagReader(argv);

// Run-as-main guard, in the form every other gate module uses: realpath BOTH sides. A raw
// `argv[1] === fileURLToPath(import.meta.url)` compares the BIN SHIM path (node_modules/.bin or a
// global install's bin dir, both symlinks) against the real module path, so it is false whenever
// the gate is invoked by its published name — `guard-clone scan --gate` printed nothing and exited
// 0, a silently dead gate. Only `node <real path>` (how guard-deterministic spawns it) worked.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const minTokens = Number(flag('--min-tokens', DEFAULTS.minTokens));
  const pathsArg = flag('--paths', null);
  const paths = pathsArg ? pathsArg.split(/\s+/) : DEFAULTS.paths;
  const includeSameFile = argv.includes('--include-same-file');
  const gate = argv.includes('--gate');
  const changed = argv.includes('--changed');

  // --changed: this commit's clones — touching a staged file and absent from HEAD. Staged set
  // from the hook's staged list / git.
  const staged = changed ? loadChangedSet(repoRoot) : null;
  if (staged && ![...staged].some((f) => CODE_EXT.test(f) && underPaths(f, paths))) {
    console.log('clone gate: no staged code under the clone roots ✓');
    exitGate(0, ['clone gate: no staged code under the clone roots']);
  }

  let clones: Clone[];
  try {
    clones = detectClones({ minTokens, paths, includeSameFile, baseRef: staged && bornHead() });
  } catch (e: unknown) {
    // jscpd missing / errored = "could not run". The gate fails OPEN (exit 2) so
    // an infra failure never bricks a commit; non-gate callers surface the error.
    failLine(e instanceof Error ? e.message : String(e));
    process.exit(gate ? 2 : 1);
  }

  if (staged) clones = clones.filter((c) => staged.has(c.fileA) || staged.has(c.fileB));

  if (gate) {
    // Block on NEW clones (fragmentHash not covered by a live allowlist entry).
    const allowed = liveAllowlistedHashes();
    const novel = clones.filter((c) => !allowed.has(c.fragmentHash));
    const rows = novel.map(
      (c) =>
        `  ${String(c.lines).padStart(3)}L  ${c.fragmentHash}  ${c.fileA}:${loc(c, 'startA')} <> ${c.fileB}:${loc(c, 'startB')}${c.kind === 'similar' ? `  (similar ${c.similarity})` : ''}`,
    );
    for (const row of rows) console.log(row);
    if (novel.length > 0) {
      console.log(`\nclone gate: ${novel.length} new clone(s) — block.`);
      // Ready-to-paste approval, pre-filled with lines + ranges (fill in <why>), so an
      // approved entry keeps its metadata instead of the empty fields you get by hand.
      // Capped to APPROVE_CAP (mirrors matcher.mjs) — every clone is listed in the rows
      // above; the full command set stays out of the token stream and re-prints on re-run.
      const APPROVE_CAP = 6;
      console.log('To approve an intentional clone (fill in the reason):');
      for (const c of novel.slice(0, APPROVE_CAP)) {
        console.log(
          `  ${CO_SCRIPT} add-clone "${c.fragmentHash}" "${c.fileA}" "${c.fileB}" --lines ${c.lines} --range-a ${loc(c, 'startA')}-${loc(c, 'endA')} --range-b ${loc(c, 'startB')}-${loc(c, 'endB')} --description "<why>"`,
        );
      }
      if (novel.length > APPROVE_CAP) {
        console.log(`  (+${novel.length - APPROVE_CAP} more — re-run after addressing these)`);
      }
    } else {
      console.log('clone gate: no new clones ✓');
    }
    exitGate(novel.length > 0 ? 1 : 0, [`clone gate: ${novel.length} new clone(s)`, ...rows]);
  }

  if (mode === 'json') {
    process.stdout.write(JSON.stringify(clones, null, 2));
  } else {
    const sameFile = clones.filter((c) => c.fileA === c.fileB).length;
    console.log(
      `clone-detector: ${clones.length} clones (min-tokens ${minTokens}) — ${sameFile} same-file (sub-chunk), ${clones.length - sameFile} cross-file`,
    );
    console.log('');
    for (const c of clones.slice(0, 15)) {
      const where =
        c.fileA === c.fileB
          ? `${c.fileA} (${loc(c, 'startA')}↔${loc(c, 'startB')})`
          : `${c.fileA}:${loc(c, 'startA')} <> ${c.fileB}:${loc(c, 'startB')}`;
      console.log(`  ${String(c.lines).padStart(3)}L  ${c.fragmentHash}  ${where}`);
    }
    if (clones.length > 15) console.log(`  … +${clones.length - 15} more`);
  }
}
