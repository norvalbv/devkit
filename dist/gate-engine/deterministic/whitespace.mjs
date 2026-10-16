#!/usr/bin/env node
// Whitespace gate: `git diff --cached --check` over the lines this commit adds. Exit 0 clean, 1 found.
// Git's rules apply, so core.whitespace and the .gitattributes `whitespace` attribute exempt paths.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { commitIndexEnv } from '../ratchets/commit-index.mjs';
import { exitGate } from './reason.mjs';
// git's finding line: `<raw path>:<line>: <message>`; some are followed by a `+<content>` line.
const FINDING_RE = /^(.+):\d+: [^:]+$/;
// -M: a moved file's old whitespace is not re-judged. --relative: a monorepo package judges itself.
const DIFF_ARGS = ['diff', '--cached', '--no-color', '--no-ext-diff', '-M', '--relative'];
// Optional period: the message is matched, not one git version's punctuation of it.
const CONFLICT_MARKER_RE = /: leftover conflict marker\.?$/;
export function remedyFor(findings) {
    const out = [];
    if (findings.some((f) => !CONFLICT_MARKER_RE.test(f))) {
        out.push('Fix: remove the whitespace, or exempt an intentional path in .gitattributes (`<glob> -whitespace`; `whitespace=-blank-at-eol` keeps markdown hard breaks; `whitespace=cr-at-eol` for CRLF).');
    }
    if (findings.some((f) => CONFLICT_MARKER_RE.test(f))) {
        out.push('Fix: resolve the conflict marker, or set `conflict-marker-size` for that path in .gitattributes (`-whitespace` does not exempt markers).');
    }
    return out;
}
/** LC_ALL=C pins git's English messages, which the remedy matches on. */
function git(root, args) {
    return spawnSync('git', [...DIFF_ARGS, ...args], {
        cwd: root,
        encoding: 'utf8',
        env: { ...commitIndexEnv(root), LC_ALL: 'C' },
    });
}
/** A finding names a staged path, so a `+<content>` line is never taken for one by its shape. */
function findingsOf(stdout, staged) {
    return (stdout ?? '').split('\n').filter((l) => staged.has(FINDING_RE.exec(l)?.[1] ?? ''));
}
/** Judge the commit's index; git exits 2 on findings. Overflowed output still carries findings. */
export function checkWhitespace(root) {
    const r = git(root, ['--check']);
    if (r.status === 0)
        return { code: 0, lines: [] };
    const staged = new Set((git(root, ['--name-only', '-z']).stdout ?? '').split('\0').filter(Boolean));
    let findings = findingsOf(r.stdout, staged);
    if (findings.length === 0 && r.status !== 2) {
        const why = r.error?.message ?? (r.stderr || `git exited ${r.status}`).trim();
        return { code: 2, lines: [`⚠ whitespace: could not run git diff --check — ${why}`] };
    }
    // A merge blames only lines its resolution added. No merge in progress: git exits 128, no filter.
    const theirs = git(root, ['--check', 'MERGE_HEAD', '--']);
    if (findings.length > 0 && (theirs.status === 0 || theirs.status === 2)) {
        const alsoTheirs = new Set(findingsOf(theirs.stdout, staged));
        findings = findings.filter((f) => alsoTheirs.has(f));
        if (findings.length === 0)
            return { code: 0, lines: [] };
    }
    const header = '✗ whitespace: git diff --check found whitespace errors in staged lines';
    return { code: 1, lines: [header, ...findings, ...remedyFor(findings)] };
}
const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invoked === realpathSync(new URL(import.meta.url))) {
    if (process.argv[2] !== 'gate') {
        console.error('usage: whitespace gate');
        process.exit(2);
    }
    const { code, lines } = checkWhitespace(process.cwd());
    for (const line of lines)
        console.error(line);
    exitGate(code, lines);
}
