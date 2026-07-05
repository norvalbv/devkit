#!/usr/bin/env node
/**
 * Staged-diff re-scoper for a fallow commit gate.
 *
 * Stock `fallow audit` blocks on ANY finding that is "introduced" (not in the
 * saved baseline) ANYWHERE in the worktree. In a repo with parallel in-progress
 * work — or a stale baseline — that lets unrelated code block an otherwise clean
 * commit, which pressures contributors into `--no-verify`. This filter re-scopes
 * the gate to the work the commit actually introduces.
 *
 * Contract:
 *   - Complexity: line-level. Flagged only when the function's line range overlaps
 *     a staged hunk — a stale-baseline finding at an untouched line of a touched
 *     file is NOT attributed to this commit.
 *   - Duplication: flagged only when a clone instance sits in a staged hunk, so a
 *     staged fragment duplicating unstaged/committed code still blocks, but two
 *     clones both outside the staged diff do not.
 *   - Dead code: file/relationship-level (unused files, circular deps, boundary
 *     violations, duplicate exports, unused deps), so scoped by staged-FILE
 *     membership, not hunk overlap. A finding that references no attributable file
 *     is FAIL-CLOSED (block) — a genuinely-bad staged finding is never silently
 *     passed.
 *
 * I/O: reads the `fallow audit --format json` payload on stdin.
 *   exit 0 → no introduced finding overlaps the staged diff (gate may pass)
 *   exit 1 → ≥1 does (gate should block); the blockers are printed to stdout
 *   exit 2 → could not compute (caller decides; the gate treats this as fail-open)
 *
 * W-3 (devkit invariant): the staged diff is read with `git diff --cached` run in
 * the CONSUMER cwd (process.cwd()), so every path the filter compares is the
 * consumer repo's, never the package dir. There are NO baked-in repo paths or a
 * pinned fallow version in this LOGIC — the version floor is the gate's concern
 * (a config/doc value), this module only re-scopes whatever audit JSON it is fed.
 *
 * Pure helpers are exported for unit tests; `main()` only runs when executed as a
 * CLI (guarded below), so importing this module performs no git / stdin / exit.
 */
import { type ExecSyncOptionsWithStringEncoding, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Hoisted to module scope (biome lint/performance/useTopLevelRegex). None are
// global (/g), so they carry no lastIndex state across calls.
const RE_DIFF_NEWFILE = /^\+\+\+ b\/(.*?)\r?$/; // \r? tolerates CRLF diffs
const RE_HUNK = /@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
const RE_CR = /\r$/;
const RE_LINECOL = /:\d+(:\d+)?$/;
const RE_PATHLIKE = /(^|\/)[\w.-]+\.[a-z0-9]+$/i;
const RE_HASLETTER = /[a-z]/i;

// A changed line range on the new (index) side of a diff: [startLine, endLine] inclusive.
type LineRange = [number, number];
type HunkRanges = Map<string, LineRange[]>;

interface StagedDiff {
  ranges: HunkRanges;
  stagedFiles: Set<string>;
}

// Shapes of the `fallow audit --format json` payload this filter re-scopes (external data — every
// field is optional/defensive because the exact schema is fallow's concern, not this module's).
interface ComplexityFinding {
  introduced?: boolean;
  path?: string;
  name?: string;
  line?: number;
  line_count?: number;
  exceeded?: unknown;
}

interface CloneInstance {
  file?: string;
  start_line?: number;
  end_line?: number;
}

interface CloneGroup {
  introduced?: boolean;
  suggested_name?: string;
  line_count?: number;
  instances?: CloneInstance[];
}

interface AuditPayload {
  complexity?: { findings?: ComplexityFinding[] };
  duplication?: { clone_groups?: CloneGroup[] };
  dead_code?: Record<string, unknown>;
}

type Blocker =
  | { kind: 'complexity'; path?: string; name?: string; line?: number; exceeded?: unknown }
  | { kind: 'duplication'; name?: string; line_count?: number; files: string[] }
  | { kind: 'dead_code'; detail: string }
  | { kind: 'dead_code'; files: string[] };

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Parse `git diff --cached -U0` output into Map<file, Array<[start,end]>> of
 * changed line ranges on the new (index) side. Pure — exported for tests.
 */
export function parseHunkRanges(diffText: string): HunkRanges {
  const map: HunkRanges = new Map();
  let file: string | null = null;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ ')) {
      const m = line.match(RE_DIFF_NEWFILE);
      file = m ? m[1] : null;
    } else if (line.startsWith('@@') && file) {
      // @@ -oldStart,oldCount +newStart,newCount @@
      const m = line.match(RE_HUNK);
      if (!m) continue;
      const start = Number.parseInt(m[1], 10);
      // m[2] is the optional +count group; absent (undefined at runtime) → 1 line. The regex only
      // ever captures `\d+` here, so a truthiness test is equivalent to the `=== undefined` check.
      const count = m[2] ? Number.parseInt(m[2], 10) : 1;
      if (count <= 0) continue; // pure deletion — no new lines to attribute
      const existing = map.get(file);
      if (existing) existing.push([start, start + count - 1]);
      else map.set(file, [[start, start + count - 1]]);
    }
  }
  return map;
}

/** Parse `git diff --cached --name-only` output into a Set of repo-relative
 *  paths (incl. pure renames, which carry no hunk). Pure — exported for tests. */
export function parseStagedFiles(nameOnlyText: string): Set<string> {
  return new Set(
    nameOnlyText
      .split('\n')
      .map((s) => s.replace(RE_CR, '').trim())
      .filter(Boolean),
  );
}

/** Returns an overlap predicate over the parsed hunk ranges. */
export function makeOverlap(
  ranges: HunkRanges,
): (file: string, start?: number, end?: number) => boolean {
  return (file, start, end) => {
    const r = ranges.get(file);
    if (!r) return false;
    const s = start ?? 1;
    const e = end ?? s;
    return r.some(([a, b]) => s <= b && a <= e);
  };
}

/** Recursively collect every path-like string a finding references — covers the
 *  many dead_code shapes (path / file / from_path / to_path / cycle[] / files[] /
 *  locations[] "file:line"). Strips a trailing :line[:col] so "src/x.ts:5" matches
 *  "src/x.ts". Matches a filename.ext with or without a leading dir, so a root
 *  "package.json" attributes instead of falling fail-closed; a bare dependency
 *  name (no extension) is not a path. Pure — exported for tests. */
export function collectPaths(node: unknown, out: Set<string> = new Set()): string[] {
  if (typeof node === 'string') {
    const p = node.replace(RE_LINECOL, '');
    const base = p.split('/').pop() ?? '';
    // filename.ext, with or without a leading dir, whose basename has a letter —
    // so "package.json"/"src/x.ts" attribute but a bare version like "1.2.3" does not.
    if (RE_PATHLIKE.test(p) && RE_HASLETTER.test(base)) out.add(p);
  } else if (Array.isArray(node)) {
    for (const v of node) collectPaths(v, out);
  } else if (node && typeof node === 'object') {
    for (const v of Object.values(node)) collectPaths(v, out);
  }
  return [...out];
}

/**
 * Pure core: given the parsed audit, staged hunk ranges, and staged file set,
 * return the list of introduced findings attributable to the staged diff.
 * Exported for tests; no I/O.
 */
// Reason: the branches ARE the per-category attribution algorithm: complexity findings (line-range overlap), duplication clone groups (any-instance overlap), and dead_code (fail-closed on unattributable refs, else staged-file filter) each carry distinct introduced/overlap/staged rules; splitting the three loops scatters one attribution pass.
// fallow-ignore-next-line complexity
export function findBlockers(
  audit: AuditPayload,
  ranges: HunkRanges,
  stagedFiles: Set<string>,
): Blocker[] {
  const overlaps = makeOverlap(ranges);
  const blockers: Blocker[] = [];

  for (const f of audit?.complexity?.findings ?? []) {
    if (f.introduced !== true) continue;
    const start = f.line ?? 1;
    const end = start + (f.line_count ?? 1) - 1;
    if (f.path && overlaps(f.path, start, end)) {
      blockers.push({
        kind: 'complexity',
        path: f.path,
        name: f.name,
        line: f.line,
        exceeded: f.exceeded,
      });
    }
  }

  for (const g of audit?.duplication?.clone_groups ?? []) {
    if (g.introduced !== true) continue;
    const instances = g.instances ?? [];
    if (instances.some((i) => overlaps(i.file, i.start_line, i.end_line))) {
      blockers.push({
        kind: 'duplication',
        name: g.suggested_name,
        line_count: g.line_count,
        files: instances.map((i) => `${i.file}:${i.start_line}-${i.end_line}`),
      });
    }
  }

  for (const v of Object.values(audit?.dead_code ?? {})) {
    if (!Array.isArray(v)) continue;
    for (const it of v) {
      if (!it || typeof it !== 'object' || it.introduced !== true) continue;
      const refs = collectPaths(it);
      if (refs.length === 0) {
        blockers.push({
          kind: 'dead_code',
          detail: 'unattributable introduced finding (fail-closed)',
        });
        continue;
      }
      const staged = refs.filter((r) => stagedFiles.has(r));
      if (staged.length) blockers.push({ kind: 'dead_code', files: staged });
    }
  }

  return blockers;
}

/**
 * Read the staged diff for the CONSUMER repo (cwd) and return parsed ranges + files.
 * Pulled out of main() so the git invocation is a single, testable seam. Throws on a
 * git failure (main treats that as exit 2 / fail-open). Exported for completeness.
 */
export function readStagedDiff(cwd = process.cwd()) {
  const opts: ExecSyncOptionsWithStringEncoding = {
    encoding: 'utf8',
    cwd,
    maxBuffer: 256 * 1024 * 1024,
  };
  return {
    ranges: parseHunkRanges(execSync('git diff --cached -U0 --diff-filter=ACMR', opts)),
    stagedFiles: parseStagedFiles(
      execSync('git diff --cached --name-only --diff-filter=ACMR', opts),
    ),
  };
}

function main() {
  let audit;
  try {
    audit = JSON.parse(readStdin());
  } catch {
    process.exit(2); // unreadable payload → let the caller fail-open
  }

  let diff;
  try {
    diff = readStagedDiff();
  } catch {
    process.exit(2);
  }

  const blockers = findBlockers(audit, diff.ranges, diff.stagedFiles);
  if (blockers.length) {
    process.stdout.write(`${JSON.stringify(blockers, null, 2)}\n`);
    process.exit(1);
  }
  process.exit(0);
}

// Run as a CLI only — importing this module (e.g. from the test) must not touch
// git, stdin, or process.exit.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
