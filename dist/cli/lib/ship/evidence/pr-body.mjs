// The PR-body boundary: one bounded gh read and write each. GitHub has no compare-and-set on a body,
// so an edit re-reads after writing and, given a head, refuses once the PR head has moved past it.
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { carryEvidenceBlock } from './block.mjs';
const GH_TIMEOUT_MS = 60_000;
/** Uploads of a few MB each can take a while on a slow link; this bounds one `--attach` call. */
const ATTACH_TIMEOUT_MS = 300_000;
const ATTEMPTS = 3;
const pullSchema = z.object({
    title: z.string().optional(),
    body: z.string(),
    headRefOid: z.string(),
    baseRefOid: z.string(),
});
export function readPull(repo, pr) {
    const json = execFileSync('gh', ['pr', 'view', pr, '--repo', repo, '--json', 'title,body,headRefOid,baseRefOid'], { encoding: 'utf8', timeout: GH_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
    return pullSchema.parse(JSON.parse(json));
}
export function writeBody(repo, pr, body) {
    execFileSync('gh', ['pr', 'edit', pr, '--repo', repo, '--body-file', '-'], {
        input: body,
        timeout: GH_TIMEOUT_MS,
        stdio: ['pipe', 'ignore', 'pipe'],
    });
}
/** One body write from `<dir>/body.md` that uploads `files` (names inside `dir`). gh 2.102 resolves
 * a `![…](./<file>)` ref from its working directory, so it runs in `dir` and rewrites each in place. */
export function writeBodyAttaching(repo, pr, dir, files) {
    const attach = files.flatMap((file) => ['--attach', file]);
    try {
        execFileSync('gh', ['pr', 'edit', pr, '--repo', repo, '--body-file', 'body.md', ...attach], {
            cwd: dir,
            timeout: ATTACH_TIMEOUT_MS,
            stdio: ['ignore', 'ignore', 'pipe'],
        });
    }
    catch {
        // A partial failure still writes the body; the caller settles from what GitHub holds.
    }
}
/** Rewrite the body from a fresh read each attempt; `edit` returns null once the head has moved. */
function rewriteBody(repo, pr, edit) {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        const pull = readPull(repo, pr);
        const next = edit(pull);
        if (next === null)
            return 'head-moved';
        if (next === pull.body)
            return 'unchanged';
        writeBody(repo, pr, next);
        if (readPull(repo, pr).body.trimEnd() === next.trimEnd())
            return 'written';
    }
    return 'contended';
}
/** Apply `edit` to the PR body while its head is still `head` (null: any head); retried, bounded. */
export function publishBody(repo, pr, head, edit) {
    return rewriteBody(repo, pr, (pull) => head === null || pull.headRefOid === head ? edit(pull.body) : null);
}
/** Replace the caller-authored text and keep the PR's evidence block; a failed read writes nothing. */
export function replaceCallerText(repo, pr, caller) {
    return rewriteBody(repo, pr, (pull) => carryEvidenceBlock(caller, pull.body));
}
