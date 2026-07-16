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

interface ReviewBaselineMetadata {
  version: 1;
  baseWorktree: string;
  finalWorktree: string;
}

export interface ChangedPath {
  status: string;
  basePath?: string;
  finalPath: string;
}

interface EslintMessage {
  ruleId?: string | null;
  severity?: number;
  fatal?: boolean;
  message?: string;
  line?: number;
  column?: number;
  nodeType?: string | null;
}

interface EslintResult {
  filePath?: string;
  messages?: EslintMessage[];
  source?: string;
}

export interface NormalizedEslintFinding {
  path: string;
  line: number;
  column: number;
  ruleId: string;
  message: string;
  fingerprint: string;
}

const METADATA_FILE = 'metadata.json';
const SOURCE_EXT_RE = /\.(?:[cm]?[jt]sx?)$/i;
const NEWLINE_RE = /\r?\n/;
const NUL = '\0';
const FALLOW_CONFIG_FILES = [
  '.fallowrc.json',
  '.fallowrc.jsonc',
  'fallow.toml',
  '.fallow.toml',
] as const;

function fail(message: string): never {
  throw new Error(`devkit review baseline: ${message}`);
}

function run(
  command: string,
  args: string[],
  cwd: string,
  options: { capture?: boolean; validStatuses?: number[] } = {},
) {
  const capture = options.capture ?? false;
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error) fail(`could not run ${command}: ${result.error.message}`);
  const status = result.status ?? 1;
  const valid = options.validStatuses ?? [0];
  if (!valid.includes(status)) {
    const detail = capture ? (result.stderr ?? '').trim() : '';
    fail(`${command} exited ${status}${detail ? `: ${detail}` : ''}`);
  }
  return { status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Parse `git diff --name-status -z`. Rename/copy entries carry two path tokens. */
export function parseNameStatusZ(raw: string): ChangedPath[] {
  const fields = raw.split(NUL);
  if (fields.at(-1) === '') fields.pop();
  const changes: ChangedPath[] = [];
  for (let i = 0; i < fields.length; ) {
    const status = fields[i++];
    if (!status) fail('malformed empty status in staged name-status output');
    const kind = status[0];
    if (kind === 'R' || kind === 'C') {
      const oldPath = fields[i++];
      const newPath = fields[i++];
      if (oldPath === undefined || newPath === undefined) fail('truncated rename/copy entry');
      changes.push({
        status,
        // A copy is new work: an issue in its source must not grandfather the duplicated copy.
        ...(kind === 'R' ? { basePath: oldPath } : {}),
        finalPath: newPath,
      });
      continue;
    }
    const path = fields[i++];
    if (path === undefined) fail('truncated staged name-status entry');
    changes.push({ status, ...(kind === 'M' ? { basePath: path } : {}), finalPath: path });
  }
  return changes;
}

function readMetadata(runtimeDir: string): ReviewBaselineMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(runtimeDir, METADATA_FILE), 'utf8'));
  } catch (error) {
    fail(`cannot read ${join(runtimeDir, METADATA_FILE)}: ${String(error)}`);
  }
  const value = parsed as Partial<ReviewBaselineMetadata>;
  if (
    value.version !== 1 ||
    typeof value.baseWorktree !== 'string' ||
    typeof value.finalWorktree !== 'string' ||
    !isAbsolute(value.baseWorktree) ||
    !isAbsolute(value.finalWorktree)
  ) {
    fail('invalid review baseline metadata');
  }
  return value as ReviewBaselineMetadata;
}

function scopedWorktrees(metadata: ReviewBaselineMetadata, cwd = process.cwd()) {
  const scope = relative(metadata.finalWorktree, resolve(cwd));
  if (scope.startsWith('..') || isAbsolute(scope)) fail('hook cwd is outside the final worktree');
  const baseCwd = join(metadata.baseWorktree, scope);
  const finalCwd = join(metadata.finalWorktree, scope);
  if (!existsSync(baseCwd) || !existsSync(finalCwd)) fail(`review scope does not exist: ${scope}`);
  return { baseCwd, finalCwd, scope };
}

function gitOutput(cwd: string, args: string[]): string {
  return run('git', args, cwd, { capture: true }).stdout;
}

function stagedChanges(finalCwd: string): ChangedPath[] {
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

function changedSourcePaths(finalCwd: string): ChangedPath[] {
  return stagedChanges(finalCwd).filter((change) => SOURCE_EXT_RE.test(change.finalPath));
}

function eslintBinary(finalCwd: string): string {
  const overridden = process.env.DEVKIT_REVIEW_ESLINT_BIN;
  if (overridden) return overridden;
  const local = join(finalCwd, 'node_modules', '.bin', 'eslint');
  if (!existsSync(local)) {
    fail(`eslint.config.devkit.mjs is present but ${local} is missing; install dependencies`);
  }
  return local;
}

function parseEslintOutput(stdout: string, command: string): EslintResult[] {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed)) fail(`${command} did not return an ESLint JSON array`);
    return parsed as EslintResult[];
  } catch (error) {
    fail(`${command} returned invalid JSON: ${String(error)}`);
  }
}

function runEslint(binary: string, cwd: string, config: string, paths: string[]): EslintResult[] {
  const results: EslintResult[] = [];
  for (let offset = 0; offset < paths.length; offset += 200) {
    const chunk = paths.slice(offset, offset + 200);
    if (chunk.length === 0) continue;
    const result = run(
      binary,
      ['-c', config, '-f', 'json', '--no-error-on-unmatched-pattern', '--', ...chunk],
      cwd,
      { capture: true, validStatuses: [0, 1] },
    );
    results.push(...parseEslintOutput(result.stdout, binary));
  }
  return results;
}

function resultPath(filePath: string | undefined, cwd: string): string {
  if (!filePath) return '<unknown>';
  const absolute = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
  const rel = relative(cwd, absolute);
  return rel.startsWith('..') || isAbsolute(rel) ? filePath : rel;
}

/** Normalize blocking ESLint messages into line-shift-stable finding identities. */
export function normalizeEslintFindings(
  results: EslintResult[],
  cwd: string,
  pathMap: ReadonlyMap<string, string> = new Map(),
): NormalizedEslintFinding[] {
  const findings: NormalizedEslintFinding[] = [];
  for (const result of results) {
    const rawPath = resultPath(result.filePath, cwd);
    const path = pathMap.get(rawPath) ?? rawPath;
    const lines = (result.source ?? '').split(NEWLINE_RE);
    for (const message of result.messages ?? []) {
      if (message.severity !== 2 && message.fatal !== true) continue;
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
export function subtractFindings(
  base: NormalizedEslintFinding[],
  current: NormalizedEslintFinding[],
): NormalizedEslintFinding[] {
  const remaining = new Map<string, number>();
  for (const finding of base) {
    remaining.set(finding.fingerprint, (remaining.get(finding.fingerprint) ?? 0) + 1);
  }
  return current.filter((finding) => {
    const count = remaining.get(finding.fingerprint) ?? 0;
    if (count === 0) return true;
    remaining.set(finding.fingerprint, count - 1);
    return false;
  });
}

export function runEslintBaseline(runtimeDir: string): number {
  const metadata = readMetadata(runtimeDir);
  const { baseCwd, finalCwd } = scopedWorktrees(metadata);
  const config = join(finalCwd, 'eslint.config.devkit.mjs');
  if (!existsSync(config)) return 0;
  const changes = changedSourcePaths(finalCwd);
  if (changes.length === 0) return 0;

  const binary = eslintBinary(finalCwd);
  const baseChanges = changes.filter((change): change is ChangedPath & { basePath: string } =>
    Boolean(change.basePath && existsSync(join(baseCwd, change.basePath))),
  );
  const basePaths = baseChanges.map((change) => change.basePath);
  const finalPaths = changes.map((change) => change.finalPath);
  const renameMap = new Map(baseChanges.map((change) => [change.basePath, change.finalPath]));

  console.log('🧱 devkit eslint overlay (merge-base regression check)...');
  const base = normalizeEslintFindings(
    runEslint(binary, baseCwd, config, basePaths),
    baseCwd,
    renameMap,
  );
  const current = normalizeEslintFindings(
    runEslint(binary, finalCwd, config, finalPaths),
    finalCwd,
  );
  const introduced = subtractFindings(base, current);
  if (introduced.length === 0) {
    console.log(`✓ devkit eslint overlay: no new errors (${base.length} inherited)`);
    return 0;
  }
  console.error(
    `✗ devkit eslint overlay: ${introduced.length} new error(s) versus the merge-base baseline:`,
  );
  for (const finding of introduced) {
    console.error(
      `  ${finding.path}:${finding.line}:${finding.column}  ${finding.message}  (${finding.ruleId})`,
    );
  }
  return 1;
}

export function fallowAuditArgs(baselineDir: string, diffFile: string, config?: string): string[] {
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

type RenameEntry = readonly [string, string];

function rewriteFallowPathToken(value: string, renames: readonly RenameEntry[]): string {
  // Clone groups contain multiple `path:start-end` records separated by `|`. Split first so every
  // component is remapped; the same exact-prefix rule also covers dead-code `path:symbol` records.
  if (value.includes('|')) {
    return value
      .split('|')
      .map((part) => rewriteFallowPathToken(part, renames))
      .join('|');
  }
  for (const [before, after] of renames) {
    if (value === before) return after;
    if (value.startsWith(`${before}:`)) return `${after}${value.slice(before.length)}`;
  }
  return value;
}

function rewriteFallowValue(value: unknown, renames: readonly RenameEntry[]): unknown {
  if (typeof value === 'string') return rewriteFallowPathToken(value, renames);
  if (Array.isArray(value)) return value.map((item) => rewriteFallowValue(item, renames));
  if (!value || typeof value !== 'object') return value;
  const rewritten: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const nextKey = rewriteFallowPathToken(key, renames);
    if (Object.hasOwn(rewritten, nextKey)) {
      fail(`rename-normalized Fallow baseline has a path collision at ${nextKey}`);
    }
    rewritten[nextKey] = rewriteFallowValue(child, renames);
  }
  return rewritten;
}

/** Rewrite native Fallow baseline path identities for Git renames (copies intentionally excluded). */
export function rewriteFallowBaseline(
  value: unknown,
  renames: ReadonlyMap<string, string>,
): unknown {
  const ordered = [...renames].sort(([a], [b]) => b.length - a.length);
  return rewriteFallowValue(value, ordered);
}

function normalizeFallowBaselineFile(path: string, renames: ReadonlyMap<string, string>): void {
  if (renames.size === 0) return;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`could not parse generated Fallow baseline ${path}: ${String(error)}`);
  }
  writeFileSync(path, `${JSON.stringify(rewriteFallowBaseline(value, renames), null, 2)}\n`);
}

function fallowConfig(finalCwd: string): string | undefined {
  return FALLOW_CONFIG_FILES.map((file) => join(finalCwd, file)).find((file) => existsSync(file));
}

export function runFallowBaseline(runtimeDir: string): number {
  const metadata = readMetadata(runtimeDir);
  const { baseCwd, finalCwd, scope } = scopedWorktrees(metadata);
  const binary = process.env.DEVKIT_REVIEW_FALLOW_BIN || 'fallow';
  const config = fallowConfig(finalCwd);
  const renames = new Map(
    stagedChanges(finalCwd)
      .filter(
        (change): change is ChangedPath & { basePath: string } =>
          change.status.startsWith('R') && Boolean(change.basePath),
      )
      .map((change) => [change.basePath, change.finalPath]),
  );
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
    run(
      binary,
      [analysis, '--no-cache', ...(config ? ['--config', config] : []), '--save-baseline', target],
      baseCwd,
      {
        capture: true,
        // Fallow writes a valid baseline and then exits 1 when inherited findings exist.
        validStatuses: [0, 1],
      },
    );
    if (!existsSync(target)) fail(`${analysis} did not create its merge-base baseline`);
    normalizeFallowBaselineFile(target, renames);
  }
  const diffFile = join(fallowDir, 'staged.diff');
  writeFileSync(
    diffFile,
    gitOutput(finalCwd, [
      'diff',
      '--cached',
      '--binary',
      '--full-index',
      '--find-renames',
      '--relative',
    ]),
  );
  const result = spawnSync(binary, fallowAuditArgs(fallowDir, diffFile, config), {
    cwd: finalCwd,
    stdio: 'inherit',
  });
  if (result.error) fail(`could not run ${binary}: ${result.error.message}`);
  return result.status ?? 1;
}

export function captureReviewBaseline(
  baseWorktree: string,
  finalWorktree: string,
  runtimeDir: string,
): void {
  const base = realpathSync(baseWorktree);
  const final = realpathSync(finalWorktree);
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(
    join(runtimeDir, METADATA_FILE),
    `${JSON.stringify({ version: 1, baseWorktree: base, finalWorktree: final }, null, 2)}\n`,
    { flag: 'wx' },
  );
}

function main(): void {
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
  if (!runtimeDir) fail('usage: baseline-gate <eslint|fallow> <runtime-dir>');
  const status =
    command === 'eslint'
      ? runEslintBaseline(runtimeDir)
      : command === 'fallow'
        ? runFallowBaseline(runtimeDir)
        : fail(`unknown command: ${command ?? '<missing>'}`);
  process.exitCode = status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
