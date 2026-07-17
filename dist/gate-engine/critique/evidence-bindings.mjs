import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { readRecord, sha256Text } from "./evidence-store.mjs";
import { atomicWrite } from "./immutable-file.mjs";
const SCP_REMOTE = /^(?:[^@/:]+@)?([^:]+):(.+)$/;
const LEADING_SLASHES = /^\/+/;
const TRAILING_SLASHES = /\/+$/;
const GIT_SUFFIX = /\.git$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
function git(cwd, args) {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
}
export function canonicalRemote(remote) {
    const raw = remote.trim();
    if (!raw)
        return null;
    let host;
    let pathname;
    const scp = raw.match(SCP_REMOTE);
    if (scp?.[1] && scp[2] && !raw.includes('://')) {
        host = scp[1];
        pathname = scp[2];
    }
    else {
        try {
            const url = new URL(raw);
            host = url.hostname;
            pathname = url.pathname;
        }
        catch {
            return null;
        }
    }
    const cleanPath = pathname
        .replace(LEADING_SLASHES, '')
        .replace(GIT_SUFFIX, '')
        .replace(TRAILING_SLASHES, '');
    if (!host || !cleanPath)
        return null;
    return `${host.toLowerCase()}/${cleanPath.toLowerCase()}`;
}
/** Credential-free remote identity, with a hashed real-path fallback for repos without remotes. */
export function repositoryContext(cwd) {
    const root = git(cwd, ['rev-parse', '--show-toplevel']);
    const gitDirRaw = git(root, ['rev-parse', '--git-dir']);
    const gitDir = isAbsolute(gitDirRaw) ? gitDirRaw : resolve(root, gitDirRaw);
    let locator = null;
    try {
        locator = canonicalRemote(git(root, ['remote', 'get-url', 'origin']));
    }
    catch {
        // Local-only repositories use a non-reversible path hash.
    }
    const localLocator = `local:${sha256Text(realpathSync(root))}`;
    const repositoryLocator = locator ? `remote:${locator}` : localLocator;
    let branch = null;
    try {
        branch = git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    }
    catch {
        // Detached worktrees are represented explicitly and are never receipt-eligible.
    }
    return {
        root,
        gitDir,
        repositoryFingerprint: sha256Text(repositoryLocator),
        repositoryLocator,
        branch,
        head: git(root, ['rev-parse', 'HEAD']),
    };
}
function bindingRoot(context) {
    return join(context.gitDir, 'devkit', 'plan-critique-bindings', 'v1');
}
export function persistBinding(context, record) {
    if (!record.contract.eligible || !context.branch)
        return null;
    const binding = {
        schemaVersion: 1,
        kind: 'plan_critique_binding',
        workId: record.workId,
        critiqueId: record.critiqueId,
        repositoryFingerprint: context.repositoryFingerprint,
        branch: context.branch,
        head: context.head,
        createdAt: record.capturedAt,
    };
    const path = join(bindingRoot(context), record.workId, `${record.critiqueId}.json`);
    atomicWrite(path, `${JSON.stringify(binding, null, 2)}\n`);
    return path;
}
function bindingFiles(path) {
    if (!existsSync(path))
        return [];
    const out = [];
    for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isDirectory())
            out.push(...bindingFiles(child));
        else if (entry.isFile() && entry.name.endsWith('.json'))
            out.push(child);
    }
    return out;
}
function isAncestor(root, ancestor, head) {
    try {
        execFileSync('git', ['merge-base', '--is-ancestor', ancestor, head], {
            cwd: root,
            stdio: 'ignore',
        });
        return true;
    }
    catch {
        return false;
    }
}
export function resolveEligibleBinding(cwd, workId) {
    let context;
    try {
        context = repositoryContext(cwd);
    }
    catch {
        return { status: 'skipped', reason: 'not_a_repository', record: null, candidates: 0 };
    }
    if (!context.branch)
        return { status: 'skipped', reason: 'detached_worktree', record: null, candidates: 0 };
    const root = workId ? join(bindingRoot(context), workId) : bindingRoot(context);
    const matches = [];
    const skippedReasons = new Set();
    for (const path of bindingFiles(root)) {
        let binding;
        try {
            binding = JSON.parse(readFileSync(path, 'utf8'));
        }
        catch {
            skippedReasons.add('malformed_binding');
            continue;
        }
        if (binding.schemaVersion !== 1 ||
            binding.kind !== 'plan_critique_binding' ||
            typeof binding.workId !== 'string' ||
            typeof binding.critiqueId !== 'string' ||
            typeof binding.repositoryFingerprint !== 'string' ||
            typeof binding.branch !== 'string' ||
            typeof binding.head !== 'string' ||
            !SHA256.test(binding.workId) ||
            !UUID.test(binding.critiqueId) ||
            !SHA256.test(binding.repositoryFingerprint) ||
            !GIT_OID.test(binding.head)) {
            skippedReasons.add('malformed_binding');
            continue;
        }
        if (binding.repositoryFingerprint !== context.repositoryFingerprint) {
            skippedReasons.add('repository_mismatch');
            continue;
        }
        if (binding.branch !== context.branch) {
            skippedReasons.add('branch_mismatch');
            continue;
        }
        if (!isAncestor(context.root, binding.head, context.head)) {
            skippedReasons.add('ancestry_mismatch');
            continue;
        }
        const record = readRecord(binding.critiqueId);
        if (!record ||
            record.critiqueId !== binding.critiqueId ||
            record.workId !== binding.workId ||
            record.repositoryFingerprint !== binding.repositoryFingerprint ||
            record.branch !== binding.branch ||
            record.head !== binding.head ||
            !record.contract ||
            typeof record.contract.eligible !== 'boolean') {
            skippedReasons.add('malformed_record');
            continue;
        }
        if (!record.contract.eligible) {
            skippedReasons.add('ineligible_record');
            continue;
        }
        if (record.sanitizedProjection?.kind !== 'plan_critique_projection' ||
            record.sanitizedProjection.critiqueId !== record.critiqueId ||
            !Array.isArray(record.sanitizedProjection.findings) ||
            !Array.isArray(record.sanitizedProjection.edgeCases)) {
            skippedReasons.add('malformed_record');
            continue;
        }
        matches.push(record);
    }
    if (matches.length === 0) {
        const reason = [
            'malformed_record',
            'malformed_binding',
            'ancestry_mismatch',
            'branch_mismatch',
            'repository_mismatch',
            'ineligible_record',
        ].find((candidate) => skippedReasons.has(candidate));
        return {
            status: 'skipped',
            reason: reason ?? 'no_matching_binding',
            record: null,
            candidates: 0,
        };
    }
    if (matches.length !== 1)
        return {
            status: 'skipped',
            reason: 'ambiguous_matching_bindings',
            record: null,
            candidates: matches.length,
        };
    const record = matches[0];
    if (!record)
        return { status: 'skipped', reason: 'no_matching_binding', record: null, candidates: 0 };
    return { status: 'matched', reason: 'matched', record, candidates: 1 };
}
/** Purge immutable bindings for the current worktree; other worktrees remain isolated. */
export function purgePlanCritiqueBindings(cwd, options = {}) {
    let context;
    try {
        context = repositoryContext(cwd);
    }
    catch {
        return { files: 0, bytes: 0 };
    }
    const root = bindingRoot(context);
    if (!existsSync(root))
        return { files: 0, bytes: 0 };
    const cutoff = options.olderThanMs ? Date.now() - options.olderThanMs : Number.POSITIVE_INFINITY;
    let files = 0;
    let bytes = 0;
    for (const path of bindingFiles(root)) {
        let timestamp = statSync(path).mtimeMs;
        try {
            const binding = JSON.parse(readFileSync(path, 'utf8'));
            const created = Date.parse(binding.createdAt);
            if (Number.isFinite(created))
                timestamp = created;
        }
        catch {
            // A malformed binding may still be explicitly purged based on its filesystem timestamp.
        }
        if (timestamp > cutoff)
            continue;
        files++;
        bytes += statSync(path).size;
        if (!options.dryRun)
            rmSync(path, { force: true });
    }
    if (!options.dryRun && !options.olderThanMs)
        rmSync(root, { recursive: true, force: true });
    return { files, bytes };
}
