// Out-of-band failure reasons from spawned gates to guard-deterministic (sc-1231). Best-effort only;
// why a file and not a stderr pipe: docs/decisions/gate-telemetry-self-describing.md (2026-09-30).
import { appendFileSync, closeSync, mkdtempSync, openSync, readSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
export const GATE_REASON_ENV = 'DEVKIT_GATE_REASON_FILE';
/** Reason lines repeated under the verdict; the rest stay in the full log. */
export const REASON_LINES = 20;
/** Bytes read back per gate: a runaway writer must not exhaust the runner. */
const REASON_BYTES = 64 * 1024;
/** The gate_result detail cap every self-describing stage uses (sc-2526, judge/advisory/emit.mts). */
export const DETAIL_CAP = 500;
const NEWLINE_RE = /\r?\n/;
const WHITESPACE_RUN_RE = /\s+/g;
// Control bytes a 64KB cut can strand mid-sequence, where stripVTControlCharacters no longer matches.
const isControl = (ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code !== 9 && (code < 32 || (code >= 127 && code < 160));
};
/**
 * Run `fn` with a private per-run directory of reason files — one per gate index, so no gate can read
 * another's — removed afterwards whether the gates passed, failed or threw.
 */
export function withReasonFiles(fn) {
    let dir = '';
    try {
        dir = mkdtempSync(join(tmpdir(), 'devkit-gate-reason-'));
    }
    catch {
        // No usable temp dir: every gate still runs, with an empty ('' = none) reason channel.
    }
    try {
        return fn((index) => (dir ? join(dir, `${index}.txt`) : ''));
    }
    finally {
        try {
            if (dir)
                rmSync(dir, { recursive: true, force: true });
        }
        catch {
            // A leftover temp dir never outranks the verdict.
        }
    }
}
/** The environment a gate runs under: the caller's, with THIS gate's reason file named. */
export function gateEnv(reasonFile) {
    return { ...process.env, [GATE_REASON_ENV]: reasonFile };
}
/** Record why this gate is about to fail; a no-op when the variable is unset or the write fails.
 * Appends, so a gate that explains itself twice keeps both — the file is fresh per gate run. */
export function writeGateReason(lines) {
    const file = process.env[GATE_REASON_ENV];
    if (!file || lines.length === 0)
        return;
    try {
        appendFileSync(file, `${lines.join('\n')}\n`);
    }
    catch {
        // Narration never outranks the verdict.
    }
}
/** Print one FAIL line to stderr AND record it as this gate's reason. */
export function failLine(line) {
    console.error(line);
    writeGateReason([line]);
}
/** Exit with `code`, recording `lines` first on any non-zero exit (strict makes 2 block too). */
export function exitGate(code, lines) {
    if (code !== 0)
        writeGateReason(lines);
    process.exit(code);
}
/** The reason a gate recorded: ANSI stripped, blank lines dropped. Empty when it recorded none. */
export function readGateReason(file) {
    let text;
    try {
        const fd = openSync(file, 'r');
        try {
            const buf = Buffer.alloc(REASON_BYTES);
            text = buf.toString('utf8', 0, readSync(fd, buf, 0, REASON_BYTES, 0));
        }
        finally {
            closeSync(fd);
        }
    }
    catch {
        return [];
    }
    return stripVTControlCharacters(text)
        .split(NEWLINE_RE)
        .map((line) => [...line]
        .filter((ch) => !isControl(ch))
        .join('')
        .trimEnd())
        .filter((line) => line.trim() !== '');
}
/** The first REASON_LINES lines, and how many were left out. */
export function reasonExcerpt(lines) {
    return {
        shown: lines.slice(0, REASON_LINES),
        omitted: Math.max(0, lines.length - REASON_LINES),
    };
}
/** `<label>: <reason>` on one line — the bare label when nothing was recorded. Capped by code point:
 * never splits a surrogate, and ≤2000 UTF-8 bytes keeps the sink's 4KB append atomic. */
export function reasonDetail(label, reason) {
    const joined = reason.length
        ? `${label}: ${reason.map((line) => line.trim()).join(' · ')}`.replace(WHITESPACE_RUN_RE, ' ')
        : label; // an --extra label is caller-controlled, so the cap below applies to it too
    const points = Array.from(joined);
    return points.length > DETAIL_CAP ? `${points.slice(0, DETAIL_CAP - 1).join('')}…` : joined;
}
/** One block per failing gate under the aggregated verdict, so a reader tailing the log sees WHY.
 * A gate that recorded nothing (an `--extra` or structure command) says so plainly. */
export function reasonReport(fails) {
    const out = [];
    for (const { id, label, reason } of fails) {
        out.push(`  ── ${label} ──`);
        if (reason.length === 0) {
            out.push('     (no reason summary from this gate — its own output is in the full log above)');
            if (id === 'size') {
                out.push('     To reproduce: stage the change first — guard-size reads the index, not the disk.');
            }
            continue;
        }
        const { shown, omitted } = reasonExcerpt(reason);
        for (const line of shown)
            out.push(`     ${line.trim()}`);
        if (omitted > 0)
            out.push(`     (${omitted} more line(s) in the full log above)`);
    }
    return out;
}
