import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { critiqueEligibility, parsePlanCritiqueResponse } from "./contract.mjs";
import { evidenceRoot, isPlanCritiqueBlobPath, isPlanCritiqueId, isSha256, sha256Text, withEvidenceLock, } from "./evidence-files.mjs";
import { buildProjection, readRecord } from "./evidence-store.mjs";
import { atomicWrite } from "./immutable-file.mjs";
const SCP_REMOTE = /^(?:[^@/:]+@)?([^:]+):(.+)$/;
const LEADING_SLASHES = /^\/+/;
const TRAILING_SLASHES = /\/+$/;
const GIT_SUFFIX = /\.git$/;
const GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const EXACT_RESPONSE_BLOB = /^blobs\/([0-9a-f]{64})\.json$/;
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
    const commonDirRaw = git(root, ['rev-parse', '--git-common-dir']);
    const commonDir = realpathSync(isAbsolute(commonDirRaw) ? commonDirRaw : resolve(root, commonDirRaw));
    const localLocator = `local:${sha256Text(commonDir)}`;
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
    return withEvidenceLock(() => {
        if (!record.contract.eligible || !context.branch)
            return null;
        if (!isSha256(record.workId) || !isPlanCritiqueId(record.critiqueId))
            throw new Error('invalid plan critique binding identity');
        if (record.repositoryFingerprint !== context.repositoryFingerprint ||
            record.branch !== context.branch ||
            record.head !== context.head)
            throw new Error('plan critique record does not match the binding context');
        const stored = readRecord(record.critiqueId);
        if (!stored ||
            stored.workId !== record.workId ||
            stored.responseHash !== record.responseHash ||
            !stored.contract.eligible)
            throw new Error('plan critique record must be persisted before its binding');
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
    });
}
function bindingFiles(path) {
    let entries;
    try {
        entries = readdirSync(path, { withFileTypes: true });
    }
    catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes(error.code ?? ''))
            return [];
        throw error;
    }
    const out = [];
    for (const entry of entries) {
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
function validDate(value, nullable = false) {
    return ((nullable && value === null) ||
        (typeof value === 'string' && Number.isFinite(Date.parse(value))));
}
function validStoredRecord(record) {
    const lineage = record.lineage;
    const contractState = record.contract;
    if (record.schemaVersion !== 1 ||
        record.kind !== 'plan_critique_record' ||
        !isPlanCritiqueId(record.critiqueId) ||
        !isSha256(record.workId) ||
        !lineage ||
        !Number.isInteger(lineage.pass) ||
        lineage.pass < 1 ||
        (lineage.parentCritiqueId !== null && !isPlanCritiqueId(lineage.parentCritiqueId)) ||
        !['claude', 'codex', 'cursor'].includes(record.provider) ||
        (record.model !== null && typeof record.model !== 'string') ||
        (record.model === null
            ? record.modelHash !== null
            : record.modelHash !== sha256Text(record.model)) ||
        (record.promptHash !== null && !isSha256(record.promptHash)) ||
        !isSha256(record.responseHash) ||
        typeof record.exactResponseBlob !== 'string' ||
        (record.transcriptBlob !== null && !isPlanCritiqueBlobPath(record.transcriptBlob)) ||
        (record.transcriptBlob === null
            ? record.transcriptExpiresAt !== null
            : !validDate(record.transcriptExpiresAt)) ||
        !isSha256(record.repositoryFingerprint) ||
        typeof record.repositoryLocator !== 'string' ||
        (record.branch !== null && typeof record.branch !== 'string') ||
        !GIT_OID.test(record.head) ||
        !validDate(record.capturedAt) ||
        !validDate(record.completedAt, true) ||
        !contractState ||
        !Array.isArray(contractState.errors) ||
        !contractState.errors.every((error) => typeof error === 'string') ||
        typeof contractState.eligible !== 'boolean' ||
        typeof contractState.eligibilityReason !== 'string' ||
        !Number.isInteger(contractState.criticalCount) ||
        contractState.criticalCount < 0)
        return false;
    const blobMatch = record.exactResponseBlob.match(EXACT_RESPONSE_BLOB);
    if (!blobMatch?.[1] || blobMatch[1] !== record.responseHash)
        return false;
    const root = resolve(evidenceRoot());
    const blobPath = resolve(root, record.exactResponseBlob);
    if (!blobPath.startsWith(`${root}${sep}`))
        return false;
    let raw;
    try {
        raw = readFileSync(blobPath, 'utf8');
    }
    catch {
        return false;
    }
    if (sha256Text(raw) !== record.responseHash)
        return false;
    const parsed = parsePlanCritiqueResponse(raw);
    const eligibility = critiqueEligibility(parsed);
    const retryLimitExceeded = lineage.pass > 2;
    const expectedEligible = eligibility.eligible && !retryLimitExceeded;
    const expectedReason = retryLimitExceeded ? 'retry_limit_exceeded' : eligibility.reason;
    if (contractState.state !== parsed.state ||
        JSON.stringify(contractState.errors) !== JSON.stringify(parsed.errors) ||
        contractState.eligible !== expectedEligible ||
        contractState.eligibilityReason !== expectedReason ||
        contractState.criticalCount !== eligibility.criticalCount ||
        JSON.stringify(record.exactResponse) !== JSON.stringify(parsed.exactResponse))
        return false;
    const projection = parsed.value ? buildProjection(record.critiqueId, parsed.value) : null;
    return JSON.stringify(record.sanitizedProjection) === JSON.stringify(projection);
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
            !isSha256(binding.workId) ||
            !isPlanCritiqueId(binding.critiqueId) ||
            !isSha256(binding.repositoryFingerprint) ||
            !GIT_OID.test(binding.head) ||
            !validDate(binding.createdAt) ||
            (workId !== undefined && binding.workId !== workId)) {
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
            !validStoredRecord(record)) {
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
    return withEvidenceLock(() => {
        const root = bindingRoot(context);
        if (!existsSync(root))
            return { files: 0, bytes: 0 };
        const cutoff = options.olderThanMs === undefined
            ? Number.POSITIVE_INFINITY
            : Date.now() - options.olderThanMs;
        let files = 0;
        let bytes = 0;
        for (const path of bindingFiles(root)) {
            let stat;
            try {
                stat = statSync(path);
            }
            catch (error) {
                if (error.code === 'ENOENT')
                    continue;
                throw error;
            }
            let timestamp = stat.mtimeMs;
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
            if (!options.dryRun)
                try {
                    unlinkSync(path);
                }
                catch (error) {
                    if (error.code === 'ENOENT')
                        continue;
                    throw error;
                }
            files++;
            bytes += stat.size;
        }
        if (!options.dryRun && options.olderThanMs === undefined)
            rmSync(root, { recursive: true, force: true });
        return { files, bytes };
    });
}
