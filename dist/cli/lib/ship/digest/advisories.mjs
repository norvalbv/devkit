/** Every reviewer ADVISORY a branch's ship attempts raised, listed once. A PASS samples its
 * advisories, so one run's output is a sample, not a sweep. Read-only and never fed to a reviewer. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { telemetrySink } from '../../../../gate-engine/judge/run-context.mjs';
import { OUTPUT_HEADER, readTranscript } from '../../../../gate-engine/judge/transcript-store.mjs';
import { ADVISORY_CHARS, issueLocations, parseAdvisories, } from '../../../../gate-engine/review/contracts/response.mjs';
import { scanBackward } from './tail.mjs';
import { attemptsOf, branchAttempts, HISTORY_CAP, parseTrendRow, readBranchHistory, renderTrend, summariseTrend, } from './trend.mjs';
/** How the gate joins one reviewer's advisories into a single sink row (base-context.mts). */
const JOIN = ' | ';
const ELLIPSIS = '…';
/** Below this many non-space characters a cited line (`});`) proves nothing about the code. */
const MIN_CITED_CHARS = 8;
const IDENTITY_SCRIPT = fileURLToPath(new URL('../repo-identity.sh', import.meta.url));
/** `review:correctness-reviewer [state-transitions #c8]` (a cached lens part) → the reviewer name. */
function reviewerOf(gate) {
    return gate.replace(/^review:/, '').replace(/ \[[^\]]*\]$/, '');
}
/** A row's advisories, upgraded to their full text from the attempt's own PASS transcript only when
 * that transcript reproduces the row: an inherited ship id overwrites transcripts, a FAIL writes one. */
function rowAdvisories(attempt, row, readText) {
    const detail = row.detail ?? '';
    const reviewer = reviewerOf(row.gate ?? '');
    const verdict = attempt.rows
        .filter((r) => r.type === 'review_result' && r.reviewer === reviewer)
        .pop();
    const raw = readText && verdict?.status === 'pass' && verdict.transcript_ref;
    const transcript = raw ? readText(raw) : null;
    const at = transcript?.indexOf(`\n${OUTPUT_HEADER}\n`) ?? -1;
    if (transcript && at >= 0) {
        const full = parseAdvisories(transcript.slice(at + OUTPUT_HEADER.length + 2), Infinity);
        const joined = full.map((t) => t.slice(0, ADVISORY_CHARS)).join(JOIN);
        const rowCut = detail.endsWith(ELLIPSIS);
        if (joined === detail || (rowCut && joined.startsWith(detail.slice(0, -1)))) {
            return full.map((text) => ({ text, cut: false, diff: transcript.slice(0, at) }));
        }
    }
    const pieces = [];
    for (const piece of detail.split(JOIN)) {
        // Every advisory cites a file:line, so a piece without one continues a ` | ` inside the text.
        const continues = issueLocations(piece).length === 0 && !piece.endsWith(ELLIPSIS);
        if (continues && pieces.length > 0)
            pieces[pieces.length - 1] += `${JOIN}${piece}`;
        else if (piece)
            pieces.push(piece);
    }
    return pieces.map((piece) => ({
        text: piece.endsWith(ELLIPSIS) ? piece.slice(0, -1) : piece,
        cut: piece.length >= ADVISORY_CHARS || piece.endsWith(ELLIPSIS),
        diff: undefined,
    }));
}
/** Pure: attempts (oldest first) → each distinct `review:*` advisory once, in first-seen order. */
export function unionAdvisories(attempts, readText) {
    const byKey = new Map();
    attempts.forEach((attempt, i) => {
        for (const row of attempt.rows) {
            if (row.type !== 'advisory_result' || !row.gate?.startsWith('review:'))
                continue;
            for (const found of rowAdvisories(attempt, row, readText)) {
                const key = found.text.slice(0, ADVISORY_CHARS);
                const seen = byKey.get(key) ?? {
                    key,
                    text: found.text,
                    cut: true,
                    attempts: [],
                    reviewers: [],
                };
                if (!seen.attempts.includes(i + 1))
                    seen.attempts.push(i + 1);
                const reviewer = reviewerOf(row.gate);
                if (!seen.reviewers.includes(reviewer))
                    seen.reviewers.push(reviewer);
                if (!found.cut)
                    Object.assign(seen, { text: found.text, cut: false });
                seen.diff ??= found.diff;
                byKey.set(key, seen);
            }
        }
    });
    return mergeCutPrefixes([...byKey.values()]);
}
/** A row cut at the sink's byte cap ends mid-advisory: fold that stub into the advisory it begins. */
function mergeCutPrefixes(all) {
    return all.filter((stub) => {
        const whole = all.find((a) => a !== stub && a.key.length > stub.key.length && a.key.startsWith(stub.key));
        if (!stub.cut || !whole)
            return true;
        for (const n of stub.attempts)
            if (!whole.attempts.includes(n))
                whole.attempts.push(n);
        for (const r of stub.reviewers)
            if (!whole.reviewers.includes(r))
                whole.reviewers.push(r);
        whole.attempts.sort((a, b) => a - b);
        return false;
    });
}
/** The diff path and new-side text of `file:line`, or undefined when no hunk covers it. */
export function citedLine(diff, file, line) {
    let target = '';
    let inFile = false;
    let n = 0;
    let previous = '';
    for (const raw of diff.split('\n')) {
        if (raw.startsWith('+++ ') && previous.startsWith('--- ')) {
            target = raw.slice(4).replace(/^b\//, '');
            inFile = target === file || target.endsWith(`/${file}`);
            n = 0;
        }
        else if (raw.startsWith('@@')) {
            n = Number(/\+(\d+)/.exec(raw)?.[1] ?? 0);
        }
        else if (inFile && n > 0 && (raw.startsWith('+') || raw.startsWith(' '))) {
            if (n === line)
                return { file: target, text: raw.slice(1) };
            n++;
        }
        previous = raw;
    }
    return undefined;
}
/** Whether the cited line's text is still in the file. Only a unique, non-trivial line counts. */
export function citedStatus(text, file) {
    const wanted = text?.trim() ?? '';
    if (wanted.replace(/\s/g, '').length < MIN_CITED_CHARS)
        return 'unknown';
    let content = '';
    try {
        content = readFileSync(file, 'utf8');
    }
    catch {
        // A deleted file no longer holds the line.
    }
    const matches = content.split('\n').filter((l) => l.trim() === wanted).length;
    if (matches === 0)
        return 'gone from this working tree';
    return matches === 1 ? 'still in this working tree' : 'unknown';
}
/** The `--advisories` report for attempts read oldest first. */
export function renderAdvisories(branch, attempts, all, root) {
    const span = `${attempts[0]?.result?.ts ?? '?'} → ${attempts.at(-1)?.result?.ts ?? '?'}`;
    const lines = [
        `${all.length} distinct reviewer advisories on ${branch} over ${attempts.length} ship attempts (${span}).`,
        'Older attempts, and transcripts past retention, may have aged out of this read.',
    ];
    all.forEach((a, i) => {
        const which = `attempt${a.attempts.length > 1 ? 's' : ''} ${a.attempts.join(',')} of ${attempts.length}`;
        const cut = a.cut ? ` (cut at ${ADVISORY_CHARS} chars; the full text aged out)` : '';
        lines.push('', `${i + 1}. [${which} · ${a.reviewers.join(', ')}] ${a.text}${cut}`);
        const cite = issueLocations(a.text)[0];
        const hit = cite && a.diff ? citedLine(a.diff, cite.file, cite.line) : undefined;
        // A basename citation is read where the reviewed diff put it, not at the repo root.
        const where = path.resolve(root, hit?.file ?? cite?.file ?? '');
        lines.push(`   cited line: ${cite ? citedStatus(hit?.text, where) : 'unknown'}`);
    });
    return lines.join('\n');
}
/** The digest's branch-level lines: the trend line, then a pointer when earlier attempts raised
 * advisories this ship did not show. Narration only: any failure prints nothing. */
export function branchNarration(sink, key) {
    try {
        const rows = readBranchHistory(sink, key);
        const lines = [renderTrend(summariseTrend(rows, key))];
        const keyed = branchAttempts(rows, key);
        if (keyed) {
            // One union, so a stub this run's cut row left folds into the advisory an earlier run raised.
            const now = keyed.mine.length;
            const n = unionAdvisories(keyed.mine).filter((a) => !a.attempts.includes(now)).length;
            if (n > 0) {
                const noun = n === 1 ? 'advisory was' : 'advisories were';
                lines.push(`   ↳ ${n} ${noun} raised on earlier attempts of this branch but not shown this run — devkit ship --advisories ${key.branch}`);
            }
        }
        return lines.filter(Boolean).join('\n');
    }
    catch {
        return '';
    }
}
/** `devkit ship --advisories <branch>`: the union for this checkout's repo, read from the machine sink. */
export function listBranchAdvisories(cwd, branch, sink = telemetrySink()) {
    if (!sink)
        return {
            text: 'Telemetry is off (DEVKIT_NO_TELEMETRY=1), so no ship history was recorded.',
            code: 0,
        };
    const git = { cwd, encoding: 'utf8' };
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], git).trim();
    // The ship's own repo key, from the same script it sources, so the two can never disagree.
    const script = '. "$1" && devkit_repo_identity "$2"';
    const repo = execFileSync('sh', ['-c', script, 'sh', IDENTITY_SCRIPT, root], git).trim();
    const key = { repo, branch };
    const rows = scanBackward(sink, parseTrendRow, (kept) => (attemptsOf(kept, key)?.length ?? 0) > HISTORY_CAP);
    const attempts = attemptsOf(rows, key)?.slice(-HISTORY_CAP);
    if (!attempts) {
        return {
            text: `History unreadable: overlapping ships on ${branch} interleave their rows.`,
            code: 1,
        };
    }
    if (attempts.length === 0) {
        return {
            text: `No ship attempts for ${repo} ${branch} in the newest 16 MB of ${sink}.`,
            code: 0,
        };
    }
    return {
        text: renderAdvisories(branch, attempts, unionAdvisories(attempts, readTranscript), root),
        code: 0,
    };
}
