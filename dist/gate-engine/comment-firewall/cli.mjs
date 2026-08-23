#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { detectChangedComments } from "./detect.mjs";
import { runCommentFirewall } from "./gate.mjs";
import { ensureLegacyRationalesMigrated, listRationales, pruneRationales, recordRationale, } from "./rationales.mjs";
const USAGE = `Usage:
  guard-comments gate
  guard-comments justify <finding-id> "<specific rationale>" [--ticket SC-123|URL] [--from-ship-log <absolute-path>]
  guard-comments list
  guard-comments prune`;
export const SHIP_LOG_MAX_BYTES = 16 * 1024 * 1024;
const SHIP_LOG_NAME = /^last-ship-gates-.+\.log$/;
function parseJustifyArgs(args) {
    const [id, ...tail] = args;
    if (!id)
        return null;
    const rationale = [];
    let ticket;
    let shipLog;
    for (let index = 0; index < tail.length; index += 1) {
        const token = tail[index];
        if (token === '--ticket' || token === '--from-ship-log') {
            const value = tail[index + 1];
            if (!value || value.startsWith('--'))
                return null;
            if (token === '--ticket') {
                if (ticket !== undefined)
                    return null;
                ticket = value;
            }
            else {
                if (shipLog !== undefined)
                    return null;
                shipLog = value;
            }
            index += 1;
            continue;
        }
        if (token?.startsWith('-'))
            return null;
        if (token)
            rationale.push(token);
    }
    const text = rationale.join(' ').trim();
    return text ? { id, rationale: text, ticket, shipLog } : null;
}
function gitTopLevel(cwd) {
    return execFileSync('git', ['rev-parse', '--path-format=absolute', '--show-toplevel'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
}
function shipLogContainsFinding(cwd, file, id) {
    if (!path.isAbsolute(file))
        throw new Error('ship gate log path must be absolute');
    const root = gitTopLevel(cwd);
    const devkitDir = path.join(root, '.devkit');
    if (!SHIP_LOG_NAME.test(path.basename(file))) {
        throw new Error('ship gate log must be a last-ship-gates-*.log file');
    }
    const canonicalRoot = realpathSync(root);
    const canonicalDevkit = realpathSync(devkitDir);
    if (canonicalDevkit !== path.join(canonicalRoot, '.devkit')) {
        throw new Error('ship gate log directory must not redirect outside this repository');
    }
    if (realpathSync(path.dirname(file)) !== canonicalDevkit) {
        throw new Error("ship gate log must be directly under this repository's .devkit directory");
    }
    let descriptor;
    try {
        descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = fstatSync(descriptor);
        if (!stat.isFile())
            throw new Error('ship gate log is not a regular file');
        if (stat.size > SHIP_LOG_MAX_BYTES)
            throw new Error('ship gate log exceeds the size limit');
        const buffer = Buffer.allocUnsafe(SHIP_LOG_MAX_BYTES + 1);
        let length = 0;
        while (length < buffer.length) {
            const count = readSync(descriptor, buffer, length, buffer.length - length, null);
            if (count === 0)
                break;
            length += count;
        }
        if (length > SHIP_LOG_MAX_BYTES)
            throw new Error('ship gate log exceeds the size limit');
        const prefix = `  • [${id}] `;
        return buffer
            .subarray(0, length)
            .toString('utf8')
            .split(/\r?\n/)
            .some((line) => line.startsWith(prefix));
    }
    finally {
        if (descriptor !== undefined)
            closeSync(descriptor);
    }
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
        const parsed = parseJustifyArgs(rest);
        if (!parsed) {
            console.error(USAGE);
            return 2;
        }
        try {
            const { id, rationale, ticket, shipLog } = parsed;
            const currentIds = new Set(detectChangedComments(cwd).findings.map((finding) => finding.id));
            const reportedByShip = shipLog ? shipLogContainsFinding(cwd, shipLog, id) : false;
            if (!currentIds.has(id) && !reportedByShip) {
                if (shipLog) {
                    console.error(`guard-comments: [${id}] is not an unresolved finding in the supplied ship gate log.`);
                    return 2;
                }
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
