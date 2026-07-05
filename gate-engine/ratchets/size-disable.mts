#!/usr/bin/env node
// Size-debt ratchet: the inline `eslint-disable max-lines` / `max-lines-per-function`
// directives are the ONLY way a file escapes the project's line/function caps. A NEW
// oversized file would need such a disable — so we freeze the current disable counts
// and refuse to let them GROW. Existing giants are grandfathered; the count can only
// shrink (split a file, delete its disable).
//
// This is the mechanism that makes another 5k-LOC monolith un-birthable: max-lines is
// already enforced at commit, so without a new disable a fresh oversized file fails
// lint — and this gate blocks the new disable.
//
//   bunx guard-size freeze   # re-count + write the consumer's baseline
//   bunx guard-size gate     # fail if counts grew (pre-commit)
//
// PARAMETERIZED (W-3): scanRoots come from resolveGuardConfig(cwd) — the CONSUMER's
// guard.config.json + GUARD_* env, never hardcoded. The baseline
// (eslint/baselines/size.json) is per-repo STATE: read/written under the CONSUMER cwd,
// never the package dir. Per the "never hard-code a count" rule, freeze re-walks the
// tree and writes whatever it finds — never a literal.

import { execFileSync } from 'node:child_process';
import {
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveGuardConfig, sourceMatchers } from '../config.mts';

// The impl-file predicate bundle sourceMatchers() returns (isSource/isTest/isBarrel).
type SourceMatchers = ReturnType<typeof sourceMatchers>;

// A source file over the raw-line cap: relative path + its line count.
interface OversizedFile {
  file: string;
  lines: number;
}

// The persisted disable-count baseline (eslint/baselines/size.json).
interface SizeBaseline {
  fileDisables: number;
  fnDisables: number;
}

// The persisted raw-line baseline (eslint/baselines/size-lines.json): grandfathered files → line count.
interface LinesBaseline {
  maxLines?: number;
  files: Record<string, number>;
}

// Per-repo STATE, resolved against the consumer cwd (never __dirname).
const BASELINE = 'eslint/baselines/size.json';
// Raw-line cap baseline (the `maxLines` gate): grandfathered over-cap source files, shrink-only.
const LINES_BASELINE = 'eslint/baselines/size-lines.json';
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', '__snapshots__', '_shared']);
// Only an actual directive comment counts — a line that merely MENTIONS the phrase
// (string literal, prose comment) must not inflate the ratchet and falsely block.
const DIRECTIVE_START = /^\s*(?:\/\/|\/\*)\s*eslint-disable/;
// Disable-directive counters, hoisted (devkit lint: useTopLevelRegex) — matched per source line.
const RE_MAX_LINES_PER_FN = /max-lines-per-function/g;
const RE_MAX_LINES = /max-lines\b/g;

// `match` = the cfg.sourceExtensions matchers (TS by default; a JS/MJS repo sets ["mjs","js"]).
function walk(root: string, dir: string, files: string[], match: SourceMatchers): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true });
  } catch {
    return files;
  }
  for (const e of entries) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(root, rel, files, match);
    } else if (match.isSource(e.name) && !match.isTest(e.name)) {
      files.push(rel);
    }
  }
  return files;
}

// Count disable directives, distinguishing the file-level `max-lines` rule from
// `max-lines-per-function` (the former is a substring of the latter). `scanRoots`
// is passed explicitly so callers share one path; defaults off cfg(root).
export function countDisables(root = process.cwd(), scanRoots?: string[]) {
  const cfg = resolveGuardConfig(root);
  const rootsToScan = scanRoots ?? cfg.scanRoots;
  const match = sourceMatchers(cfg.sourceExtensions);
  const files = rootsToScan.flatMap((r: string) => walk(root, r, [], match));
  let fileDisables = 0;
  let fnDisables = 0;
  for (const f of files) {
    const text = readFileSync(join(root, f), 'utf8');
    for (const line of text.split('\n')) {
      if (!DIRECTIVE_START.test(line)) continue;
      const fn = (line.match(RE_MAX_LINES_PER_FN) || []).length;
      const file = (line.replace(RE_MAX_LINES_PER_FN, '').match(RE_MAX_LINES) || []).length;
      fnDisables += fn;
      fileDisables += file;
    }
  }
  return { fileDisables, fnDisables, scannedFiles: files.length };
}

// Raw-line cap: source (non-test) files whose line count exceeds `maxLines`. Counts ALL lines (matches
// eslint's max-lines with skipBlankLines/skipComments false). Returns a sorted [{file, lines}] list;
// empty when the cap is off (`maxLines` 0). This is what lets size be ratchet-owned — no eslint rule.
export function countOversized(
  root = process.cwd(),
  scanRoots?: string[],
  maxLines?: number,
  match?: SourceMatchers,
): OversizedFile[] {
  const cfg = resolveGuardConfig(root);
  const cap = maxLines ?? cfg.maxLines;
  if (!cap) return [];
  const m = match ?? sourceMatchers(cfg.sourceExtensions);
  const files = (scanRoots ?? cfg.scanRoots).flatMap((r: string) => walk(root, r, [], m));
  const over: OversizedFile[] = [];
  for (const f of files) {
    const lines = readFileSync(join(root, f), 'utf8').split('\n').length;
    if (lines > cap) over.push({ file: f, lines });
  }
  return over.sort((a, b) => a.file.localeCompare(b.file));
}

// Best-effort `git add` for the auto-lowered baseline so the tightened count rides along in
// the commit. Never throws: a shrink must not block the gate, and non-git contexts (the
// temp-dir tests, a bare checkout) simply leave the file written for a later commit/freeze.
function stageBaseline(root: string, rel: string): void {
  try {
    execFileSync('git', ['add', '--', rel], { cwd: root, stdio: 'pipe' });
  } catch {
    // not a git repo / git absent — the file is still written; picked up on the next commit
  }
}

// Reason: flat freeze/gate/usage CLI dispatch: branch count is one mutually-exclusive command state plus gate's sequential grew-file/grew-fn/shrank guards, each a trivial exit-or-print at near-zero nesting; splitting scatters the command handler
// fallow-ignore-next-line complexity
function runCli(cmd: string): void {
  const root = process.cwd();
  const cfg = resolveGuardConfig(root);
  const baselineFile = join(root, BASELINE);
  const linesBaselineFile = join(root, LINES_BASELINE);
  const current = countDisables(root);

  if (cmd === 'freeze') {
    const out = { fileDisables: current.fileDisables, fnDisables: current.fnDisables };
    mkdirSync(dirname(baselineFile), { recursive: true });
    writeFileSync(baselineFile, `${JSON.stringify(out, null, 2)}\n`);
    console.log(
      `✓ ${BASELINE}: frozen max-lines disables = ${out.fileDisables} file-level, ${out.fnDisables} per-function (from ${current.scannedFiles} source files)`,
    );
    if (cfg.maxLines) {
      const over = countOversized(root);
      // Shrink-only: never RAISE a recorded ceiling. min(prev, current) means re-freezing
      // after a `--no-verify` growth can't launder the larger count back into the baseline.
      const prev: Record<string, number> = existsSync(linesBaselineFile)
        ? (JSON.parse(readFileSync(linesBaselineFile, 'utf8')) as LinesBaseline).files
        : {};
      const files = Object.fromEntries(
        over.map((o) => [o.file, o.file in prev ? Math.min(prev[o.file], o.lines) : o.lines]),
      );
      writeFileSync(
        linesBaselineFile,
        `${JSON.stringify({ maxLines: cfg.maxLines, files }, null, 2)}\n`,
      );
      console.log(
        `✓ ${LINES_BASELINE}: ${over.length} file(s) over ${cfg.maxLines} lines grandfathered (shrink-only)`,
      );
    }
    process.exit(0);
  }

  // Reason: the two ratchets (folder-fanout / size-disable) are parallel-by-design independent guard bins (+ tests); each self-contained with the same freeze/gate CLI shell
  // fallow-ignore-next-line code-duplication
  if (cmd === 'gate') {
    if (!existsSync(baselineFile)) {
      console.error(`size-ratchet: ${BASELINE} missing — run \`guard-size freeze\` first.`);
      process.exit(2); // fail-open: don't block commits before the baseline exists
    }
    const frozen = JSON.parse(readFileSync(baselineFile, 'utf8')) as SizeBaseline;
    const grewFile = current.fileDisables > frozen.fileDisables;
    const grewFn = current.fnDisables > frozen.fnDisables;
    if (grewFile || grewFn) {
      console.error('🚫 New `eslint-disable max-lines` directive(s) — size debt may only SHRINK.');
      if (grewFile)
        console.error(
          `   file-level: ${current.fileDisables} now vs ${frozen.fileDisables} allowed`,
        );
      if (grewFn)
        console.error(`   per-function: ${current.fnDisables} now vs ${frozen.fnDisables} allowed`);
      console.error('   Split the file below the cap instead of disabling.');
      process.exit(1);
    }
    // Counts dropped → remind to re-freeze so the ratchet tightens.
    if (current.fileDisables < frozen.fileDisables || current.fnDisables < frozen.fnDisables) {
      console.log(
        `✓ size debt shrank (${current.fileDisables}/${current.fnDisables} vs frozen ${frozen.fileDisables}/${frozen.fnDisables}) — run \`guard-size freeze\` to lock it in.`,
      );
    }

    // Raw-line cap (the maxLines gate): a PER-FILE shrink-only ratchet. Each grandfathered
    // file's recorded count is its ceiling; a new file's ceiling is the cap. On shrink the
    // gate AUTO-LOWERS the record (and stages it) so the ceiling can only ever move down.
    if (cfg.maxLines) {
      const over = countOversized(root);
      const grandfathered: Record<string, number> = existsSync(linesBaselineFile)
        ? (JSON.parse(readFileSync(linesBaselineFile, 'utf8')) as LinesBaseline).files
        : {};
      // A file fails when it exceeds its own recorded ceiling (grandfathered) or the cap (new).
      const grew = over.filter((o) => o.lines > Math.max(cfg.maxLines, grandfathered[o.file] ?? 0));
      if (grew.length) {
        console.error(`🚫 ${grew.length} file(s) exceed their line limit — split them:`);
        for (const o of grew) {
          const allowed = Math.max(cfg.maxLines, grandfathered[o.file] ?? 0);
          console.error(`   ${o.file}: ${o.lines} lines (max ${allowed})`);
        }
        process.exit(1);
      }
      // Everything left is within its ceiling. Tighten the baseline DOWN to current reality:
      // lower each recorded count that shrank, drop files that healed under the cap.
      const next: Record<string, number> = {};
      let tightened = false;
      for (const [f, recorded] of Object.entries(grandfathered)) {
        const cur = over.find((o) => o.file === f)?.lines; // undefined = healed under the cap
        if (cur === undefined) {
          tightened = true;
          continue; // drop it entirely
        }
        next[f] = Math.min(recorded, cur);
        if (next[f] < recorded) tightened = true;
      }
      if (tightened) {
        writeFileSync(
          linesBaselineFile,
          `${JSON.stringify({ maxLines: cfg.maxLines, files: next }, null, 2)}\n`,
        );
        stageBaseline(root, LINES_BASELINE);
        console.log(`✓ line debt tightened — ${LINES_BASELINE} lowered & staged.`);
      }
    }
    process.exit(0);
  }

  console.error('usage: guard-size <freeze|gate>');
  process.exit(2);
}

// Run as a CLI only when invoked directly; importing this module (tests) has no side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  runCli(process.argv[2]);
}
