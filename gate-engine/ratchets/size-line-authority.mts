import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { resolveGuardConfig } from '../config.mts';
import { sourceMatchers } from '../config.mts';
import { LINES_BASELINE, readRatchetBaseline } from './baseline-paths.mts';
import { mergeBaseRef, treeTextAtRef } from './git-index.mts';
import { SIZE_SKIP_DIRS } from './size-policy.mts';

export type LineCountVersion = 1 | 2;

export interface LinesBaseline {
  files: Record<string, number>;
  lineCountVersion: LineCountVersion;
}

export interface DecodedLineBaseline extends LinesBaseline {
  error: string | null;
}

interface SnapshotLineBaseline extends DecodedLineBaseline {
  present: boolean;
}

export interface LineViolationResult {
  error: string | null;
  lines: string[];
}

export interface LineTightening {
  files: Record<string, number>;
  lineCountVersion: LineCountVersion;
  tightened: boolean;
}

export interface LineCeilingChange {
  current: number;
  file: string;
  lines: number;
  previous: number;
}

type GuardConfig = ReturnType<typeof resolveGuardConfig>;
type Snapshot = string;

class LineAuthorityError extends Error {}

export interface LineCount {
  file: string;
  lines: number;
}

export interface LineMeasure {
  legacyLines: number;
  lines: number;
}

export const CURRENT_LINE_COUNT_VERSION = 2;

const LINE_SEPARATOR_RE = /\r\n|\r|\n/;
const TRAILING_SEPARATOR_RE = /[\r\n]$/;

/** Count source lines without treating a trailing line separator as an extra empty line. */
export function measureLines(contents: string): LineMeasure {
  if (contents === '') return { legacyLines: 1, lines: 0 };
  const separators = contents.split(LINE_SEPARATOR_RE).length - 1;
  return {
    legacyLines: contents.split('\n').length,
    lines: TRAILING_SEPARATOR_RE.test(contents) ? separators : separators + 1,
  };
}

export function countLines(contents: string): number {
  return measureLines(contents).lines;
}

/** Convert an unversioned split-count baseline once, using the immutable source bytes that
 * produced it. Callers choose the matching worktree/index/ref boundary. */
export function normalizeLineBaseline(
  baseline: DecodedLineBaseline,
  contentsForFile: (file: string) => string | null,
): DecodedLineBaseline {
  if (baseline.lineCountVersion === CURRENT_LINE_COUNT_VERSION) return baseline;
  const files: Record<string, number> = {};
  for (const [file, stored] of Object.entries(baseline.files)) {
    const contents = contentsForFile(file);
    // A missing producer blob means stale grandfathering, not permission for a reintroduced file.
    if (contents === null) continue;
    const measured = measureLines(contents);
    files[file] = stored - (measured.legacyLines - measured.lines);
  }
  return { ...baseline, files, lineCountVersion: CURRENT_LINE_COUNT_VERSION };
}

function parseBaseline(contents: string | null, label: string): LinesBaseline {
  if (contents === null) return { files: {}, lineCountVersion: CURRENT_LINE_COUNT_VERSION };
  let parsed: {
    files?: Record<string, number>;
    lineCountVersion?: number;
  } | null;
  try {
    // SAFETY: the parsed files representation is decoded into a fresh numeric map below.
    parsed = JSON.parse(contents) as {
      files?: Record<string, number>;
      lineCountVersion?: number;
    } | null;
  } catch {
    throw new LineAuthorityError(`guard-size: invalid line baseline JSON in ${label}`);
  }
  const lineCountVersion = parsed?.lineCountVersion ?? 1;
  if (lineCountVersion !== 1 && lineCountVersion !== CURRENT_LINE_COUNT_VERSION) {
    throw new LineAuthorityError(
      `guard-size: unsupported line count version ${lineCountVersion} in ${label}`,
    );
  }
  const files = parsed?.files ?? {};
  if (!files || Object(files) !== files || Array.isArray(files)) {
    throw new LineAuthorityError(`guard-size: invalid line baseline files map in ${label}`);
  }
  const decoded: Record<string, number> = {};
  for (const [file, ceiling] of Object.entries(files)) {
    if (!Number.isFinite(ceiling) || ceiling < 0) {
      throw new LineAuthorityError(`guard-size: invalid line ceiling for ${file} in ${label}`);
    }
    decoded[file] = ceiling;
  }
  return { files: decoded, lineCountVersion };
}

export function decodeLineBaseline(contents: string | null, label: string): DecodedLineBaseline {
  try {
    return { ...parseBaseline(contents, label), error: null };
  } catch (error) {
    if (!(error instanceof LineAuthorityError)) throw error;
    return {
      error: error.message,
      files: {},
      lineCountVersion: CURRENT_LINE_COUNT_VERSION,
    };
  }
}

export function lineBaselineOrExit(
  contents: string | null,
  label: string,
  prefix = '',
): DecodedLineBaseline {
  const decoded = decodeLineBaseline(contents, label);
  if (!decoded.error) return decoded;
  console.error(prefix ? `${prefix}: ${decoded.error}` : decoded.error);
  process.exit(2);
}

function snapshotText(root: string, snapshot: Snapshot, relativePath: string): string | null {
  return treeTextAtRef(root, snapshot, relativePath);
}

function workingText(root: string, relativePath: string): string | null {
  try {
    return readFileSync(join(root, relativePath), 'utf8');
  } catch {
    return null;
  }
}

function rawBaselineAt(root: string, snapshot: Snapshot): SnapshotLineBaseline {
  const contents = snapshotText(root, snapshot, LINES_BASELINE);
  return { ...decodeLineBaseline(contents, snapshot), present: contents !== null };
}

function baselineAt(root: string, snapshot: Snapshot): SnapshotLineBaseline {
  const raw = rawBaselineAt(root, snapshot);
  return {
    ...normalizeLineBaseline(raw, (file) => snapshotText(root, snapshot, file)),
    present: raw.present,
  };
}

/** Normalize a candidate v1 entry only when it matches a parent entry, taking the strictest
 * logical ceiling when multiple merge parents could have supplied it. */
export function normalizeCandidateLineBaseline(
  root: string,
  baseline: DecodedLineBaseline,
  parents: Snapshot[],
  candidateContents: (file: string) => string | null,
): DecodedLineBaseline {
  if (baseline.lineCountVersion === CURRENT_LINE_COUNT_VERSION) return baseline;
  const parentBaselines = parents.map((parent) => ({ parent, raw: rawBaselineAt(root, parent) }));
  const files: Record<string, number> = {};
  for (const [file, stored] of Object.entries(baseline.files)) {
    const matchingParents = parentBaselines.filter(
      ({ raw }) =>
        !raw.error && raw.present && raw.lineCountVersion === 1 && raw.files[file] === stored,
    );
    const inheritedCeilings = matchingParents.flatMap(({ parent }) => {
      const contents = snapshotText(root, parent, file);
      if (contents === null) return [];
      const measured = measureLines(contents);
      return [stored - (measured.legacyLines - measured.lines)];
    });
    if (matchingParents.length > 0) {
      if (inheritedCeilings.length > 0) files[file] = Math.min(...inheritedCeilings);
      continue;
    }
    const contents = candidateContents(file);
    if (contents === null) continue;
    const measured = measureLines(contents);
    files[file] = stored - (measured.legacyLines - measured.lines);
  }
  return { ...baseline, files, lineCountVersion: CURRENT_LINE_COUNT_VERSION };
}

export function lineBaselineForGate(
  root: string,
  candidate: Snapshot | null,
  parents: Snapshot[] = lineBaselineParents(root),
): DecodedLineBaseline {
  if (candidate) {
    const raw = rawBaselineAt(root, candidate);
    const decoded = normalizeCandidateLineBaseline(root, raw, parents, (file) =>
      snapshotText(root, candidate, file),
    );
    if (decoded.error) {
      console.error(decoded.error);
      process.exit(2);
    }
    if (raw.present) return decoded;
  }
  const baseline = readRatchetBaseline(root, LINES_BASELINE);
  const decoded = lineBaselineOrExit(
    baseline?.contents ?? null,
    baseline?.relativePath ?? LINES_BASELINE,
  );
  return normalizeCandidateLineBaseline(root, decoded, parents, (file) => workingText(root, file));
}

export function lineBaselineParents(root: string): string[] {
  try {
    execFileSync('git', ['rev-parse', '--verify', 'MERGE_HEAD^{commit}'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return ['HEAD', 'MERGE_HEAD'];
  } catch {
    return ['HEAD'];
  }
}

function governed(file: string, cfg: GuardConfig): boolean {
  if (
    file.startsWith('/') ||
    file.split('/').some((part) => !part || part === '..' || SIZE_SKIP_DIRS.has(part))
  ) {
    return false;
  }
  const match = sourceMatchers(cfg.sourceExtensions);
  return (
    match.isSource(file) &&
    cfg.scanRoots.some((root: string) => file === root || file.startsWith(`${root}/`))
  );
}

function sourceLines(root: string, snapshot: Snapshot, file: string): number | null {
  const contents = snapshotText(root, snapshot, file);
  return contents === null ? null : countLines(contents);
}

export function effectiveLineCeiling(baseline: LinesBaseline, file: string, cap: number): number {
  return Math.max(cap, baseline.files[file] ?? 0);
}

export function lineCountsAtRef(
  root: string,
  snapshot: Snapshot,
  files: Iterable<string>,
  cfg: GuardConfig,
): LineCount[] {
  const counts: LineCount[] = [];
  for (const file of files) {
    if (!governed(file, cfg)) continue;
    const lines = sourceLines(root, snapshot, file);
    if (lines !== null) counts.push({ file, lines });
  }
  return counts;
}

export function lineCeilingChanges(
  root: string,
  cfg: GuardConfig,
  {
    candidate,
    inCommit,
    parents: suppliedParents,
    prBase,
  }: {
    candidate: Snapshot;
    inCommit: boolean;
    parents?: Snapshot[];
    prBase?: string;
  },
): LineCeilingChange[] {
  if (!prBase && !inCommit) return [];
  const prParent = prBase && suppliedParents === undefined ? mergeBaseRef(root, prBase) : null;
  if (prBase && suppliedParents === undefined && !prParent) {
    throw new LineAuthorityError(`guard-size: pull-request merge base is unavailable: ${prBase}`);
  }
  if (prBase && suppliedParents?.length === 0) {
    throw new LineAuthorityError(`guard-size: pull-request merge base is unavailable: ${prBase}`);
  }
  const parents = suppliedParents ?? (prParent ? [prParent] : lineBaselineParents(root));
  const priorResults = parents.map((parent) => baselineAt(root, parent));
  if (priorResults.some((baseline) => baseline.error)) return [];
  const prior = priorResults;
  const current = normalizeCandidateLineBaseline(
    root,
    rawBaselineAt(root, candidate),
    parents,
    (file) => snapshotText(root, candidate, file),
  );
  if (current.error) throw new LineAuthorityError(current.error);
  const match = sourceMatchers(cfg.sourceExtensions);
  const cap = (file: string) => (match.isTest(file) ? cfg.maxTestLines : cfg.maxLines);
  const files = new Set(prior.flatMap((baseline) => Object.keys(baseline.files)));
  const changes: LineCeilingChange[] = [];

  for (const file of files) {
    if (!governed(file, cfg)) continue;
    const candidateCeiling = effectiveLineCeiling(current, file, cap(file));
    const parentCeilings = prior.map((baseline) => effectiveLineCeiling(baseline, file, cap(file)));
    if (!parentCeilings.every((ceiling) => candidateCeiling < ceiling)) continue;
    const lines = sourceLines(root, candidate, file);
    if (lines === null) continue;
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
export function lineViolationReport(
  root: string,
  cfg: GuardConfig,
  scoped: LineCount[],
  cap: (file: string) => number,
  grandfathered: DecodedLineBaseline,
  scope: {
    candidate: Snapshot | null;
    inCommit: boolean;
    parents?: Snapshot[];
    prBase?: string;
  },
): LineViolationResult {
  let changes: LineCeilingChange[];
  try {
    if (scope.inCommit && !scope.candidate) {
      throw new LineAuthorityError('guard-size: Git index snapshot is unavailable');
    }
    changes = scope.candidate
      ? lineCeilingChanges(root, cfg, { ...scope, candidate: scope.candidate })
      : [];
  } catch (error) {
    if (!(error instanceof LineAuthorityError)) throw error;
    return { error: error.message, lines: [] };
  }
  const authority = new Map(changes.map((change) => [change.file, change]));
  const violations = new Map(
    scoped
      .filter(
        (entry) =>
          (cap(entry.file) > 0 || grandfathered.files[entry.file] !== undefined) &&
          entry.lines > effectiveLineCeiling(grandfathered, entry.file, cap(entry.file)),
      )
      .map((entry) => [entry.file, entry]),
  );
  for (const change of changes) {
    if (change.lines > change.current) violations.set(change.file, change);
  }
  if (!violations.size) return { error: null, lines: [] };

  const report = [`🚫 ${violations.size} file(s) exceed their line limit or lowered ceiling:`];
  for (const entry of violations.values()) {
    const lowered = authority.get(entry.file);
    if (lowered) {
      report.push(
        `   ${entry.file}: ceiling lowered ${lowered.previous} → ${lowered.current} via ${LINES_BASELINE}`,
      );
    }
    report.push(
      `   ${entry.file}: ${entry.lines} lines (max ${lowered?.current ?? effectiveLineCeiling(grandfathered, entry.file, cap(entry.file))})`,
    );
  }
  return { error: null, lines: report };
}

export function tightenLineBaseline(
  root: string,
  snapshot: Snapshot,
  staged: Iterable<string>,
  grandfathered: DecodedLineBaseline,
  cap: (file: string) => number,
): LineTightening {
  const files = { ...grandfathered.files };
  let tightened = false;
  for (const file of staged) {
    if (!(file in grandfathered.files)) continue;
    const lines = sourceLines(root, snapshot, file);
    if (lines === null || lines <= cap(file)) {
      delete files[file];
      tightened = true;
      continue;
    }
    if (lines < grandfathered.files[file]) {
      files[file] = lines;
      tightened = true;
    }
  }
  return { files, lineCountVersion: grandfathered.lineCountVersion, tightened };
}
