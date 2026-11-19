/**
 * Which commits reach the sentry judge: the staged diff decides, so plain-English subjects are judged
 * too. A fix/feat/perf/refactor subject only WIDENS admission (a source change with no error token).
 */
import { filePathOf, splitDiffByFile } from '../judge/diff-focus.mjs';
import { captureSymbols } from './capture-lexer.mjs';
import { ERROR_HUNK_RE, TEST_PATH_RE } from './evidence.mjs';
const SENTRY_JUDGE_TYPE_RE = /^(fix|feat|perf|refactor)(\([^)]*\))?!?:/i;
const DOC_PATH_RE = /\.(?:md|mdx|mdc|markdown|rst|adoc|txt)$/i;
const SKIP_PROSE = {
    empty_message: 'empty commit message',
    merge_commit: 'merge commit — its inherited changes were judged on their own branch',
    untyped_no_diff: 'nothing staged and the subject has no fix/feat/perf/refactor type',
    no_staged_source: 'only test or docs files are staged',
    no_source_error_hunk: 'no staged source line adds or changes error handling, and the subject has no fix/feat/perf/refactor type',
};
/** The one stderr/stdout line a skipped run prints. */
export function skipLine(cause) {
    return `sentry-judge: SKIP (${SKIP_PROSE[cause]} — not judged)`;
}
/** First non-comment, non-blank line of a commit message — the subject. */
export function subjectOf(message) {
    return (String(message)
        .split('\n')
        .find((l) => l.trim() && !l.startsWith('#'))
        ?.trim() ?? '');
}
const isSourcePath = (path) => path !== null && !TEST_PATH_RE.test(path) && !DOC_PATH_RE.test(path);
/** Does a hunk line ADDED or REMOVED by this commit touch error handling or a capture? Context lines
 * and the `@@` header never count, so an untouched pre-existing catch admits nothing. */
function changesErrorHandling(segment) {
    const body = segment.slice(Math.max(0, segment.indexOf('\n@@')));
    return body
        .split('\n')
        .some((l) => (l.startsWith('+') || l.startsWith('-')) &&
        (ERROR_HUNK_RE.test(l) || captureSymbols(l.slice(1)).length > 0));
}
/** Why this commit skips the judge, or null to judge it. A `null` diff (git could not read it)
 * judges: fail toward judging (on the diff tier the run then degrades to warn-only). */
export function sentrySkipCause(message, diff, merging) {
    const subject = subjectOf(message);
    if (!subject)
        return 'empty_message';
    if (merging)
        return 'merge_commit';
    if (diff === null)
        return null;
    const typed = SENTRY_JUDGE_TYPE_RE.test(subject);
    if (!diff.trim())
        return typed ? null : 'untyped_no_diff';
    const source = splitDiffByFile(diff).filter((seg) => isSourcePath(filePathOf(seg)));
    if (!source.length)
        return 'no_staged_source';
    if (typed || source.some(changesErrorHandling))
        return null;
    return 'no_source_error_hunk';
}
