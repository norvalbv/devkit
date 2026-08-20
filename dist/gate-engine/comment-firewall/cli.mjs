#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { detectChangedComments } from "./detect.mjs";
import { runCommentFirewall } from "./gate.mjs";
import { ensureLegacyRationalesMigrated, listRationales, pruneRationales, recordRationale, } from "./rationales.mjs";
const USAGE = `Usage:
  guard-comments gate
  guard-comments justify <finding-id> "<specific rationale>" [--ticket SC-123|URL]
  guard-comments list
  guard-comments prune`;
function flag(args, name) {
    const at = args.indexOf(name);
    return at === -1 ? undefined : args[at + 1];
}
export function runCommentCli(args, cwd = process.cwd()) {
    const [command, ...rest] = args;
    if (command === 'gate') {
        try {
            ensureLegacyRationalesMigrated(cwd);
            return runCommentFirewall(cwd);
        }
        catch (cause) {
            console.error(`guard-comments: migration — ${cause instanceof Error ? cause.message : cause}`);
            return 4;
        }
    }
    if (command === 'list') {
        const entries = listRationales(cwd);
        if (entries.length === 0)
            console.log('guard-comments: no recorded rationales.');
        for (const [id, entry] of entries) {
            console.log(`[${id}]${entry.ticket ? ` ${entry.ticket}` : ''} — ${entry.rationale}`);
        }
        return 0;
    }
    if (command === 'prune') {
        try {
            const current = new Set(detectChangedComments(cwd).findings.map((finding) => finding.id));
            const removed = pruneRationales(cwd, current);
            console.error(`guard-comments: released ${removed} obsolete rationale ownership${removed === 1 ? '' : 's'} for this worktree.`);
            return 0;
        }
        catch (cause) {
            console.error(`guard-comments: prune — ${cause instanceof Error ? cause.message : cause}`);
            return 2;
        }
    }
    if (command === 'justify') {
        const [id, ...tail] = rest;
        const ticketAt = tail.indexOf('--ticket');
        const rationaleParts = ticketAt === -1 ? tail : tail.slice(0, ticketAt);
        const rationale = rationaleParts.join(' ').trim();
        const ticket = flag(tail, '--ticket');
        if (!id || !rationale || (ticketAt !== -1 && !ticket)) {
            console.error(USAGE);
            return 2;
        }
        try {
            const currentIds = new Set(detectChangedComments(cwd).findings.map((finding) => finding.id));
            if (!currentIds.has(id)) {
                console.error(`guard-comments: [${id}] is not a current staged finding; re-run the gate and copy its ID.`);
                return 2;
            }
            const entry = recordRationale(cwd, id, rationale, ticket);
            console.error(`guard-comments: local rationale recorded for [${id}]${entry.ticket ? ` (${entry.ticket})` : ''}; re-run the gate for batched independent review.`);
            return 0;
        }
        catch (cause) {
            console.error(`guard-comments: justify — ${cause instanceof Error ? cause.message : cause}`);
            return 2;
        }
    }
    console.error(USAGE);
    return 2;
}
const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invoked === realpathSync(new URL(import.meta.url))) {
    process.exitCode = runCommentCli(process.argv.slice(2));
}
