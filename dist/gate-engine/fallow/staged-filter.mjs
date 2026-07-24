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
 *   exit 2 → could not compute; the REASON is written to stderr. Callers fail CLOSED on
 *            this (a gate that cannot attribute must not weaken itself, so it blocks on
 *            the unscoped worktree verdict). sc-1192: an anonymous exit 2 blocked an
 *            otherwise-clean scoped ship with nothing to act on and no way to tell which
 *            step failed, so every exit-2 path now names itself.
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
import { execSync } from 'node:child_process';
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
const RE_BOM = /^﻿/;
// Spawn failures the OS reports under transient pressure, NOT a bad command: the gate chain runs
// this filter while a fleet of reviewer/judge processes is live, and a fork that loses that race
// would otherwise turn a clean scoped commit into an unscoped block. One retry costs 250ms and
// only ever fires on these; a real git failure (bad repo, missing binary) still surfaces at once.
const TRANSIENT_SPAWN_ERRNOS = new Set(['EAGAIN', 'ENOMEM', 'EMFILE', 'ENFILE', 'EINTR']);
const SPAWN_RETRY_DELAY_MS = 250;
const REASON_MAX_CHARS = 400;
function readStdin() {
    try {
        return readFileSync(0, 'utf8');
    }
    catch (err) {
        throw new Error(`could not read stdin — ${describeError(err)}`);
    }
}
/** One-line, bounded description of a thrown error — the payload of every exit-2 reason. */
export function describeError(err) {
    const e = (err ?? {});
    // Short structured fields FIRST: the message and the child's stderr are unbounded (git's usage
    // dump runs to thousands of chars), so appending errno/exit after them loses exactly the two
    // fields that classify the failure the moment truncation bites.
    const parts = [];
    if (typeof e.code === 'string')
        parts.push(`errno=${e.code}`);
    if (typeof e.status === 'number')
        parts.push(`exit=${e.status}`);
    if (e.message)
        parts.push(e.message);
    const stderr = e.stderr ? String(e.stderr).trim() : '';
    if (stderr)
        parts.push(`stderr: ${stderr}`);
    const reason = parts.join(' | ').replace(/\s+/g, ' ').trim() || String(err);
    return reason.length > REASON_MAX_CHARS ? `${reason.slice(0, REASON_MAX_CHARS)}…` : reason;
}
/** Name the failure on stderr, then exit 2. The caller fails closed — but now it can say why. */
function fail(reason) {
    process.stderr.write(`fallow-staged-filter: ${reason}\n`);
    process.exit(2);
}
/** Spans of every balanced top-level `{...}` object in the text, in order. String- and
 *  escape-aware, so a brace inside a finding's message never closes a span early. Pure —
 *  exported for tests. */
export function jsonObjectSpans(text) {
    const spans = [];
    let open = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (escaped)
            escaped = false;
        else if (inString && ch === '\\')
            escaped = true;
        else if (ch === '"')
            inString = !inString;
        else if (inString)
            continue;
        else if (ch === '{') {
            if (depth === 0)
                open = i;
            depth++;
        }
        else if (ch === '}' && depth > 0 && --depth === 0) {
            spans.push(text.slice(open, i + 1));
        }
    }
    return spans;
}
/**
 * Parse the `fallow audit --format json` payload, tolerating the wrapping the gate's own `jq`
 * already tolerates: a BOM, and any preamble/trailing bytes around the JSON object (a warning
 * line on the audit's stdout, a shell that appended something). The gate only reaches this
 * filter because `jq` read a verdict out of the SAME bytes, so a stricter parser here would
 * reject payloads the caller already considers valid. Pure — exported for tests.
 */
export function parseAuditPayload(text) {
    const cleaned = text.replace(RE_BOM, '').trim();
    if (!cleaned)
        throw new Error('empty payload (nothing on stdin)');
    try {
        return JSON.parse(cleaned);
    }
    catch (err) {
        // Identify the audit by the SAME property the caller matched on: the gate only runs this
        // filter because its `jq` read `.verdict` out of these bytes. Taking the first balanced span
        // instead would hand back a preamble that is itself valid JSON (structured/ndjson logging) —
        // parsing clean, carrying no findings, and passing a commit that must block. An ambiguous
        // text (no candidate, or several) rethrows the ORIGINAL parse error, which names the
        // offending position in the real payload.
        const candidates = jsonObjectSpans(cleaned).filter(isVerdictObject);
        if (candidates.length !== 1)
            throw err;
        return JSON.parse(candidates[0]);
    }
}
/** True when a span parses as an object carrying a `verdict` — fallow's audit envelope. */
function isVerdictObject(span) {
    try {
        const value = JSON.parse(span);
        return typeof value === 'object' && value !== null && 'verdict' in value;
    }
    catch {
        return false;
    }
}
/**
 * Parse `git diff --cached -U0` output into Map<file, Array<[start,end]>> of
 * changed line ranges on the new (index) side. Pure — exported for tests.
 */
export function parseHunkRanges(diffText) {
    const map = new Map();
    let file = null;
    for (const line of diffText.split('\n')) {
        if (line.startsWith('+++ ')) {
            const m = line.match(RE_DIFF_NEWFILE);
            file = m ? m[1] : null;
        }
        else if (line.startsWith('@@') && file) {
            // @@ -oldStart,oldCount +newStart,newCount @@
            const m = line.match(RE_HUNK);
            if (!m)
                continue;
            const start = Number.parseInt(m[1], 10);
            // m[2] is the optional +count group; absent (undefined at runtime) → 1 line. The regex only
            // ever captures `\d+` here, so a truthiness test is equivalent to the `=== undefined` check.
            const count = m[2] ? Number.parseInt(m[2], 10) : 1;
            if (count <= 0)
                continue; // pure deletion — no new lines to attribute
            const existing = map.get(file);
            if (existing)
                existing.push([start, start + count - 1]);
            else
                map.set(file, [[start, start + count - 1]]);
        }
    }
    return map;
}
/** Parse `git diff --cached --name-only` output into a Set of repo-relative
 *  paths (incl. pure renames, which carry no hunk). Pure — exported for tests. */
export function parseStagedFiles(nameOnlyText) {
    return new Set(nameOnlyText
        .split('\n')
        .map((s) => s.replace(RE_CR, '').trim())
        .filter(Boolean));
}
/** Returns an overlap predicate over the parsed hunk ranges. */
export function makeOverlap(ranges) {
    return (file, start, end) => {
        const r = ranges.get(file);
        if (!r)
            return false;
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
export function collectPaths(node, out = new Set()) {
    if (typeof node === 'string') {
        const p = node.replace(RE_LINECOL, '');
        const base = p.split('/').pop() ?? '';
        // filename.ext, with or without a leading dir, whose basename has a letter —
        // so "package.json"/"src/x.ts" attribute but a bare version like "1.2.3" does not.
        if (RE_PATHLIKE.test(p) && RE_HASLETTER.test(base))
            out.add(p);
    }
    else if (Array.isArray(node)) {
        for (const v of node)
            collectPaths(v, out);
    }
    else if (node && typeof node === 'object') {
        for (const v of Object.values(node))
            collectPaths(v, out);
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
export function findBlockers(audit, ranges, stagedFiles) {
    const overlaps = makeOverlap(ranges);
    const blockers = [];
    for (const f of audit?.complexity?.findings ?? []) {
        if (f.introduced !== true)
            continue;
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
        if (g.introduced !== true)
            continue;
        const instances = g.instances ?? [];
        // A clone instance with no `file` can't overlap a staged hunk (overlaps would look up an
        // undefined key and return false); guard it so the file arg stays a definite string.
        if (instances.some((i) => i.file != null && overlaps(i.file, i.start_line, i.end_line))) {
            blockers.push({
                kind: 'duplication',
                name: g.suggested_name,
                line_count: g.line_count,
                files: instances.map((i) => `${i.file}:${i.start_line}-${i.end_line}`),
            });
        }
    }
    for (const v of Object.values(audit?.dead_code ?? {})) {
        if (!Array.isArray(v))
            continue;
        for (const it of v) {
            if (!it || typeof it !== 'object' || it.introduced !== true)
                continue;
            const refs = collectPaths(it);
            if (refs.length === 0) {
                blockers.push({
                    kind: 'dead_code',
                    detail: 'unattributable introduced finding (fail-closed)',
                });
                continue;
            }
            const staged = refs.filter((r) => stagedFiles.has(r));
            if (staged.length)
                blockers.push({ kind: 'dead_code', files: staged });
        }
    }
    return blockers;
}
/**
 * Read the staged diff for the CONSUMER repo (cwd) and return parsed ranges + files.
 * Pulled out of main() so the git invocation is a single, testable seam. Throws on a
 * git failure (main turns that into a NAMED exit 2). Exported for completeness.
 */
export function readStagedDiff(cwd = process.cwd()) {
    const opts = {
        encoding: 'utf8',
        cwd,
        maxBuffer: 256 * 1024 * 1024,
        // execSync forwards a child's stderr to OUR stderr by default and leaves err.stderr null. The
        // gate discards this process's stderr on the pass path, so git's own words would be lost
        // exactly when they explain a block. Pipe it so the failure reason can carry them instead.
        stdio: ['ignore', 'pipe', 'pipe'],
    };
    return {
        ranges: parseHunkRanges(gitRead('git diff --cached -U0 --diff-filter=ACMR', opts)),
        stagedFiles: parseStagedFiles(gitRead('git diff --cached --name-only --diff-filter=ACMR', opts)),
    };
}
/** True when a failed exec could not START the child (OS pressure), as opposed to a child that ran
 *  and failed — only the former is worth retrying. Pure — exported for tests. */
export function isTransientSpawnFailure(err) {
    const code = err?.code;
    return typeof code === 'string' && TRANSIENT_SPAWN_ERRNOS.has(code);
}
/** execSync with one retry on a transient spawn failure (see TRANSIENT_SPAWN_ERRNOS). */
function gitRead(command, opts) {
    try {
        return execSync(command, opts);
    }
    catch (err) {
        if (!isTransientSpawnFailure(err))
            throw err;
        // Synchronous sleep: this whole module is a sync CLI, and a timer would need an async main.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SPAWN_RETRY_DELAY_MS);
        return execSync(command, opts);
    }
}
function main() {
    let audit;
    try {
        // Parse boundary: the stdin payload is `fallow audit --format json` — read it as AuditPayload
        // (findBlockers treats every field defensively, so a shape mismatch degrades, never throws).
        audit = parseAuditPayload(readStdin());
    }
    catch (err) {
        fail(`unreadable fallow audit payload on stdin — ${describeError(err)}`);
    }
    let diff;
    try {
        diff = readStagedDiff();
    }
    catch (err) {
        fail(`could not read the staged diff in ${process.cwd()} — ${describeError(err)}`);
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
