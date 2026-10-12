// The PR-body boundary: one bounded gh read and write each. GitHub has no compare-and-set on a body,
// so the upsert re-reads after writing and refuses once the PR head is no longer the evidence head.
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { upsertEvidenceBlock } from './block.mjs';
const GH_TIMEOUT_MS = 60_000;
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
function writeBody(repo, pr, body) {
    execFileSync('gh', ['pr', 'edit', pr, '--repo', repo, '--body-file', '-'], {
        input: body,
        timeout: GH_TIMEOUT_MS,
        stdio: ['pipe', 'ignore', 'pipe'],
    });
}
/** Upsert `block` while the PR head is still `head`; a lost concurrent write is retried, bounded. */
export function publishEvidenceBlock(repo, pr, head, block) {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        const pull = readPull(repo, pr);
        if (pull.headRefOid !== head)
            return 'head-moved';
        const next = upsertEvidenceBlock(pull.body, block);
        if (next === pull.body)
            return 'unchanged';
        writeBody(repo, pr, next);
        if (readPull(repo, pr).body.trimEnd() === next.trimEnd())
            return 'written';
    }
    return 'contended';
}
