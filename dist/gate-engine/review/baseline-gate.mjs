#!/usr/bin/env node
/**
 * Review-only regression baselines for tools whose normal commit invocation can be noisy when a
 * PR worktree is materialized away from the branch that produced its saved baselines. The review
 * driver gives this process two immutable worktrees: merge-base and the final staged PR snapshot.
 * Nothing produced here is copied back to either the target checkout or the repository baseline.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseDiffHunks, rewriteFallowBaseline, } from "./baseline-fallow-paths.mjs";
const METADATA_FILE = 'metadata.json';
const SOURCE_EXT_RE = /\.(?:[cm]?[jt]sx?)$/i;
const NEWLINE_RE = /\r?\n/;
const NUL = '\0';
const FALLOW_CONFIG_FILES = [
    '.fallowrc.json',
    '.fallowrc.jsonc',
    'fallow.toml',
    '.fallow.toml',
];
function fail(message) {
    throw new Error(`devkit review baseline: ${message}`);
}
function outputText(value) {
    return value ?? '';
}
function resultStatus(value) {
    return value ?? 1;
}
function assertValidStatus(command, status, validStatuses, captured, stderr) {
    if ((validStatuses ?? [0]).includes(status))
        return;
    const detail = captured ? outputText(stderr).trim() : '';
    fail(`${command} exited ${status}${detail ? `: ${detail}` : ''}`);
}
function run(command, args, cwd, options = {}) {
    const capture = options.capture ?? false;
    const result = spawnSync(command, args, {
        cwd,
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    if (result.error)
        fail(`could not run ${command}: ${result.error.message}`);
    const status = resultStatus(result.status);
    assertValidStatus(command, status, options.validStatuses, capture, result.stderr);
    return { status, stdout: outputText(result.stdout), stderr: outputText(result.stderr) };
}
/** Parse `git diff --name-status -z`. Rename/copy entries carry two path tokens. */
export function parseNameStatusZ(raw) {
    const fields = raw.split(NUL);
    if (fields.at(-1) === '')
        fields.pop();
    const changes = [];
    for (let i = 0; i < fields.length;) {
        const status = fields[i++];
        if (!status)
            fail('malformed empty status in staged name-status output');
        const kind = status[0];
        if (kind === 'R' || kind === 'C') {
            const oldPath = fields[i++];
            const newPath = fields[i++];
            if (oldPath === undefined || newPath === undefined)
                fail('truncated rename/copy entry');
            changes.push({
                status,
                // A copy is new work: an issue in its source must not grandfather the duplicated copy.
                ...(kind === 'R' ? { basePath: oldPath } : {}),
                finalPath: newPath,
            });
            continue;
        }
        const path = fields[i++];
        if (path === undefined)
            fail('truncated staged name-status entry');
        changes.push({ status, ...(kind === 'M' ? { basePath: path } : {}), finalPath: path });
    }
    return changes;
}
function readMetadata(runtimeDir) {
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(join(runtimeDir, METADATA_FILE), 'utf8'));
    }
    catch (error) {
        fail(`cannot read ${join(runtimeDir, METADATA_FILE)}: ${String(error)}`);
    }
    const value = parsed;
    if (value.version !== 1 ||
        typeof value.baseWorktree !== 'string' ||
        typeof value.finalWorktree !== 'string' ||
        !isAbsolute(value.baseWorktree) ||
        !isAbsolute(value.finalWorktree)) {
        fail('invalid review baseline metadata');
    }
    return value;
}
function scopedWorktrees(metadata, cwd = process.cwd()) {
    const scope = relative(metadata.finalWorktree, resolve(cwd));
    if (scope.startsWith('..') || isAbsolute(scope))
        fail('hook cwd is outside the final worktree');
    const baseCwd = join(metadata.baseWorktree, scope);
    const finalCwd = join(metadata.finalWorktree, scope);
    if (!existsSync(baseCwd) || !existsSync(finalCwd))
        fail(`review scope does not exist: ${scope}`);
    return { baseCwd, finalCwd, scope };
}
function gitOutput(cwd, args) {
    return run('git', args, cwd, { capture: true }).stdout;
}
function stagedChanges(finalCwd) {
    const raw = gitOutput(finalCwd, [
        'diff',
        '--cached',
        '--name-status',
        '-z',
        '--find-renames',
        '--relative',
        '--diff-filter=ACMR',
    ]);
    return parseNameStatusZ(raw);
}
function changedSourcePaths(finalCwd) {
    return stagedChanges(finalCwd).filter((change) => SOURCE_EXT_RE.test(change.finalPath));
}
function eslintBinary(finalCwd) {
    const overridden = process.env.DEVKIT_REVIEW_ESLINT_BIN;
    if (overridden)
        return overridden;
    const local = join(finalCwd, 'node_modules', '.bin', 'eslint');
    if (!existsSync(local)) {
        fail(`eslint.config.devkit.mjs is present but ${local} is missing; install dependencies`);
    }
    return local;
}
function parseEslintOutput(stdout, command) {
    try {
        const parsed = JSON.parse(stdout);
        if (!Array.isArray(parsed))
            fail(`${command} did not return an ESLint JSON array`);
        return parsed;
    }
    catch (error) {
        fail(`${command} returned invalid JSON: ${String(error)}`);
    }
}
function runEslint(binary, cwd, config, paths) {
    const results = [];
    for (let offset = 0; offset < paths.length; offset += 200) {
        const chunk = paths.slice(offset, offset + 200);
        if (chunk.length === 0)
            continue;
        const result = run(binary, ['-c', config, '-f', 'json', '--no-error-on-unmatched-pattern', '--', ...chunk], cwd, { capture: true, validStatuses: [0, 1] });
        results.push(...parseEslintOutput(result.stdout, binary));
    }
    return results;
}
function resultPath(filePath, cwd) {
    if (!filePath)
        return '<unknown>';
    const absolute = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
    const rel = relative(cwd, absolute);
    return rel.startsWith('..') || isAbsolute(rel) ? filePath : rel;
}
/** Normalize blocking ESLint messages into line-shift-stable finding identities. */
export function normalizeEslintFindings(results, cwd, pathMap = new Map()) {
    const findings = [];
    for (const result of results) {
        const rawPath = resultPath(result.filePath, cwd);
        const path = pathMap.get(rawPath) ?? rawPath;
        const lines = (result.source ?? '').split(NEWLINE_RE);
        for (const message of result.messages ?? []) {
            if (message.severity !== 2 && message.fatal !== true)
                continue;
            const line = message.line ?? 1;
            const column = message.column ?? 1;
            const ruleId = message.ruleId ?? (message.fatal ? 'fatal' : 'eslint');
            const text = message.message ?? 'ESLint error';
            const sourceLine = (lines[line - 1] ?? '').trim();
            const identity = [path, ruleId, text, message.nodeType ?? '', sourceLine].join(NUL);
            findings.push({
                path,
                line,
                column,
                ruleId,
                message: text,
                fingerprint: createHash('sha256').update(identity).digest('hex'),
            });
        }
    }
    return findings;
}
/** Multiset subtraction: retain only occurrences not already present in the merge-base findings. */
export function subtractFindings(base, current) {
    const remaining = new Map();
    for (const finding of base) {
        remaining.set(finding.fingerprint, (remaining.get(finding.fingerprint) ?? 0) + 1);
    }
    return current.filter((finding) => {
        const count = remaining.get(finding.fingerprint) ?? 0;
        if (count === 0)
            return true;
        remaining.set(finding.fingerprint, count - 1);
        return false;
    });
}
export function runEslintBaseline(runtimeDir) {
    const metadata = readMetadata(runtimeDir);
    const { baseCwd, finalCwd } = scopedWorktrees(metadata);
    const config = join(finalCwd, 'eslint.config.devkit.mjs');
    if (!existsSync(config))
        return 0;
    const changes = changedSourcePaths(finalCwd);
    if (changes.length === 0)
        return 0;
    const binary = eslintBinary(finalCwd);
    const baseChanges = changes.filter((change) => Boolean(change.basePath && existsSync(join(baseCwd, change.basePath))));
    const basePaths = baseChanges.map((change) => change.basePath);
    const finalPaths = changes.map((change) => change.finalPath);
    const renameMap = new Map(baseChanges.map((change) => [change.basePath, change.finalPath]));
    console.log('🧱 devkit eslint overlay (merge-base regression check)...');
    const base = normalizeEslintFindings(runEslint(binary, baseCwd, config, basePaths), baseCwd, renameMap);
    const current = normalizeEslintFindings(runEslint(binary, finalCwd, config, finalPaths), finalCwd);
    const introduced = subtractFindings(base, current);
    if (introduced.length === 0) {
        console.log(`✓ devkit eslint overlay: no new errors (${base.length} inherited)`);
        return 0;
    }
    console.error(`✗ devkit eslint overlay: ${introduced.length} new error(s) versus the merge-base baseline:`);
    for (const finding of introduced) {
        console.error(`  ${finding.path}:${finding.line}:${finding.column}  ${finding.message}  (${finding.ruleId})`);
    }
    return 1;
}
export function fallowAuditArgs(baselineDir, diffFile, config) {
    return [
        'audit',
        '--gate',
        'new-only',
        '--no-cache',
        ...(config ? ['--config', config] : []),
        '--diff-file',
        diffFile,
        '--dead-code-baseline',
        join(baselineDir, 'dead-code.json'),
        '--health-baseline',
        join(baselineDir, 'health.json'),
        '--dupes-baseline',
        join(baselineDir, 'dupes.json'),
    ];
}
function fallowPathMappings(finalCwd, changes) {
    const mappings = new Map();
    for (const change of changes) {
        if (!change.basePath)
            continue;
        const paths = change.basePath === change.finalPath
            ? [change.finalPath]
            : [change.basePath, change.finalPath];
        const diff = gitOutput(finalCwd, [
            '--literal-pathspecs',
            'diff',
            '--cached',
            '--unified=0',
            '--no-color',
            '--find-renames',
            '--relative',
            '--',
            ...paths,
        ]);
        mappings.set(change.basePath, {
            finalPath: change.finalPath,
            hunks: parseDiffHunks(diff),
        });
    }
    return mappings;
}
function normalizeFallowBaselineFile(path, mappings) {
    if (mappings.size === 0)
        return;
    let value;
    try {
        value = JSON.parse(readFileSync(path, 'utf8'));
    }
    catch (error) {
        fail(`could not parse generated Fallow baseline ${path}: ${String(error)}`);
    }
    writeFileSync(path, `${JSON.stringify(rewriteFallowBaseline(value, mappings), null, 2)}\n`);
}
function fallowConfig(finalCwd) {
    return FALLOW_CONFIG_FILES.map((file) => join(finalCwd, file)).find((file) => existsSync(file));
}
export function runFallowBaseline(runtimeDir) {
    const metadata = readMetadata(runtimeDir);
    const { baseCwd, finalCwd, scope } = scopedWorktrees(metadata);
    const binary = process.env.DEVKIT_REVIEW_FALLOW_BIN || 'fallow';
    const config = fallowConfig(finalCwd);
    const changes = stagedChanges(finalCwd);
    const mappings = fallowPathMappings(finalCwd, changes);
    const scopeId = createHash('sha256')
        .update(scope || '.')
        .digest('hex')
        .slice(0, 12);
    const fallowDir = join(runtimeDir, `fallow-${scopeId}`);
    mkdirSync(fallowDir, { recursive: true });
    console.log('🌱 fallow audit (merge-base regression check)...');
    for (const [analysis, file] of [
        ['dead-code', 'dead-code.json'],
        ['health', 'health.json'],
        ['dupes', 'dupes.json'],
    ]) {
        // The base can contain thousands of inherited findings. Save them silently; only the final
        // audit's newly introduced findings belong in the streamed review verdict.
        const target = join(fallowDir, file);
        run(binary, [analysis, '--no-cache', ...(config ? ['--config', config] : []), '--save-baseline', target], baseCwd, {
            capture: true,
            // Fallow writes a valid baseline and then exits 1 when inherited findings exist.
            validStatuses: [0, 1],
        });
        if (!existsSync(target))
            fail(`${analysis} did not create its merge-base baseline`);
        normalizeFallowBaselineFile(target, mappings);
    }
    const diffFile = join(fallowDir, 'staged.diff');
    writeFileSync(diffFile, gitOutput(finalCwd, [
        'diff',
        '--cached',
        '--binary',
        '--full-index',
        '--find-renames',
        '--relative',
    ]));
    const result = spawnSync(binary, fallowAuditArgs(fallowDir, diffFile, config), {
        cwd: finalCwd,
        stdio: 'inherit',
    });
    if (result.error)
        fail(`could not run ${binary}: ${result.error.message}`);
    return result.status ?? 1;
}
export function captureReviewBaseline(baseWorktree, finalWorktree, runtimeDir) {
    const base = realpathSync(baseWorktree);
    const final = realpathSync(finalWorktree);
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, METADATA_FILE), `${JSON.stringify({ version: 1, baseWorktree: base, finalWorktree: final }, null, 2)}\n`, { flag: 'wx' });
}
function main() {
    const command = process.argv[2];
    const runtimeDir = process.argv[3];
    if (command === 'capture') {
        const finalWorktree = process.argv[4];
        const destination = process.argv[5];
        if (!runtimeDir || !finalWorktree || !destination) {
            fail('usage: baseline-gate capture <base-worktree> <final-worktree> <runtime-dir>');
        }
        captureReviewBaseline(runtimeDir, finalWorktree, destination);
        return;
    }
    if (!runtimeDir)
        fail('usage: baseline-gate <eslint|fallow> <runtime-dir>');
    const status = command === 'eslint'
        ? runEslintBaseline(runtimeDir)
        : command === 'fallow'
            ? runFallowBaseline(runtimeDir)
            : fail(`unknown command: ${command ?? '<missing>'}`);
    process.exitCode = status;
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
    try {
        main();
    }
    catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
