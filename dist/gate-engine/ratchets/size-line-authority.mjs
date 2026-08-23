import { execFileSync } from 'node:child_process';
import { sourceMatchers } from "../config.mjs";
import { LEGACY_LINES_BASELINE, LINES_BASELINE, readRatchetBaseline } from "./baseline-paths.mjs";
import { mergeBaseRef, treeTextAtRef } from "./git-index.mjs";
import { SIZE_SKIP_DIRS } from "./size-policy.mjs";
class LineAuthorityError extends Error {
}
function parseBaseline(contents, label) {
    if (contents === null)
        return { files: {} };
    let parsed;
    try {
        // SAFETY: the parsed files representation is decoded into a fresh numeric map below.
        parsed = JSON.parse(contents);
    }
    catch {
        throw new LineAuthorityError(`guard-size: invalid line baseline JSON in ${label}`);
    }
    const files = parsed?.files ?? {};
    if (!files || Object(files) !== files || Array.isArray(files)) {
        throw new LineAuthorityError(`guard-size: invalid line baseline files map in ${label}`);
    }
    const decoded = {};
    for (const [file, ceiling] of Object.entries(files)) {
        if (!Number.isFinite(ceiling) || ceiling < 0) {
            throw new LineAuthorityError(`guard-size: invalid line ceiling for ${file} in ${label}`);
        }
        decoded[file] = ceiling;
    }
    return { files: decoded };
}
export function decodeLineBaseline(contents, label) {
    try {
        return { ...parseBaseline(contents, label), error: null };
    }
    catch (error) {
        if (!(error instanceof LineAuthorityError))
            throw error;
        return { error: error.message, files: {} };
    }
}
export function lineBaselineFilesOrExit(contents, label, prefix = '') {
    const decoded = decodeLineBaseline(contents, label);
    if (!decoded.error)
        return decoded.files;
    console.error(prefix ? `${prefix}: ${decoded.error}` : decoded.error);
    process.exit(2);
}
function snapshotText(root, snapshot, relativePath) {
    return treeTextAtRef(root, snapshot, relativePath);
}
function baselineAt(root, snapshot) {
    const contents = snapshotText(root, snapshot, LINES_BASELINE) ??
        snapshotText(root, snapshot, LEGACY_LINES_BASELINE);
    return { ...decodeLineBaseline(contents, snapshot), present: contents !== null };
}
export function lineBaselineForGate(root, candidate) {
    if (candidate) {
        const decoded = baselineAt(root, candidate);
        if (decoded.error) {
            console.error(decoded.error);
            process.exit(2);
        }
        if (decoded.present)
            return decoded.files;
    }
    const baseline = readRatchetBaseline(root, LINES_BASELINE, LEGACY_LINES_BASELINE);
    return lineBaselineFilesOrExit(baseline?.contents ?? null, baseline?.relativePath ?? LINES_BASELINE);
}
function mergeParents(root) {
    try {
        execFileSync('git', ['rev-parse', '--verify', 'MERGE_HEAD^{commit}'], {
            cwd: root,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        return ['HEAD', 'MERGE_HEAD'];
    }
    catch {
        return ['HEAD'];
    }
}
function governed(file, cfg) {
    if (file.startsWith('/') ||
        file.split('/').some((part) => !part || part === '..' || SIZE_SKIP_DIRS.has(part))) {
        return false;
    }
    const match = sourceMatchers(cfg.sourceExtensions);
    return (match.isSource(file) &&
        cfg.scanRoots.some((root) => file === root || file.startsWith(`${root}/`)));
}
function sourceLines(root, snapshot, file) {
    const contents = snapshotText(root, snapshot, file);
    return contents === null ? null : contents.split('\n').length;
}
export function lineCountsAtRef(root, snapshot, files, cfg) {
    const counts = [];
    for (const file of files) {
        if (!governed(file, cfg))
            continue;
        const lines = sourceLines(root, snapshot, file);
        if (lines !== null)
            counts.push({ file, lines });
    }
    return counts;
}
export function lineCeilingChanges(root, cfg, { candidate, inCommit, prBase }) {
    if (!prBase && !inCommit)
        return [];
    const prParent = prBase ? mergeBaseRef(root, prBase) : null;
    if (prBase && !prParent) {
        throw new LineAuthorityError(`guard-size: pull-request merge base is unavailable: ${prBase}`);
    }
    const parents = prParent ? [prParent] : mergeParents(root);
    const current = baselineAt(root, candidate);
    if (current.error)
        throw new LineAuthorityError(current.error);
    const priorResults = parents.map((parent) => baselineAt(root, parent));
    if (priorResults.some((baseline) => baseline.error))
        return [];
    const prior = priorResults;
    const match = sourceMatchers(cfg.sourceExtensions);
    const cap = (file) => (match.isTest(file) ? cfg.maxTestLines : cfg.maxLines);
    const files = new Set(prior.flatMap((baseline) => Object.keys(baseline.files)));
    const changes = [];
    for (const file of files) {
        if (!governed(file, cfg))
            continue;
        const candidateCeiling = Math.max(cap(file), current.files[file] ?? 0);
        const parentCeilings = prior.map((baseline) => Math.max(cap(file), baseline.files[file] ?? 0));
        if (!parentCeilings.every((ceiling) => candidateCeiling < ceiling))
            continue;
        const lines = sourceLines(root, candidate, file);
        if (lines === null)
            continue;
        changes.push({
            current: candidateCeiling,
            file,
            lines,
            previous: Math.min(...parentCeilings),
        });
    }
    return changes.sort((left, right) => left.file.localeCompare(right.file));
}
/** Combine ordinary growth and authority-input violations into the gate's diagnostic lines. */
export function lineViolationReport(root, cfg, scoped, cap, grandfathered, scope) {
    let changes;
    try {
        if (scope.inCommit && !scope.candidate) {
            throw new LineAuthorityError('guard-size: Git index snapshot is unavailable');
        }
        changes = scope.candidate
            ? lineCeilingChanges(root, cfg, { ...scope, candidate: scope.candidate })
            : [];
    }
    catch (error) {
        if (!(error instanceof LineAuthorityError))
            throw error;
        return { error: error.message, lines: [] };
    }
    const authority = new Map(changes.map((change) => [change.file, change]));
    const violations = new Map(scoped
        .filter((entry) => (cap(entry.file) > 0 || grandfathered[entry.file] !== undefined) &&
        entry.lines > Math.max(cap(entry.file), grandfathered[entry.file] ?? 0))
        .map((entry) => [entry.file, entry]));
    for (const change of changes) {
        if (change.lines > change.current)
            violations.set(change.file, change);
    }
    if (!violations.size)
        return { error: null, lines: [] };
    const report = [`🚫 ${violations.size} file(s) exceed their line limit or lowered ceiling:`];
    for (const entry of violations.values()) {
        const lowered = authority.get(entry.file);
        if (lowered) {
            report.push(`   ${entry.file}: ceiling lowered ${lowered.previous} → ${lowered.current} via ${LINES_BASELINE}`);
        }
        report.push(`   ${entry.file}: ${entry.lines} lines (max ${lowered?.current ?? Math.max(cap(entry.file), grandfathered[entry.file] ?? 0)})`);
    }
    return { error: null, lines: report };
}
export function tightenLineBaseline(root, snapshot, staged, grandfathered, cap) {
    const files = { ...grandfathered };
    let tightened = false;
    for (const file of staged) {
        if (!(file in grandfathered))
            continue;
        const lines = sourceLines(root, snapshot, file);
        if (lines === null || lines <= cap(file)) {
            delete files[file];
            tightened = true;
        }
        else if (lines < grandfathered[file]) {
            files[file] = lines;
            tightened = true;
        }
    }
    return { files, tightened };
}
