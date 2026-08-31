import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { resolveGuardConfig } from '../config.mts';
import { sourceMatchers } from '../config.mts';
import { LEGACY_LINES_BASELINE, LINES_BASELINE, readRatchetBaseline } from './baseline-paths.mts';
import {
  commitParentsAt,
  type CommitParents,
  lineBaselineParents,
  mergeBaseRef,
  treeTextAtRef,
} from './git-index.mts';
import {
  convertCeiling,
  countGovernedFileLines,
  CURRENT_LINE_COUNT_VERSION,
  decodeLineBaseline,
  type DecodedLineBaseline,
  effectiveLineCeiling,
  lineBaselineOrExit,
  type LineCountVersion,
} from './size-line-count.mts';
export { lineBaselineParents } from './git-index.mts';
import { governedSourceFile } from './size-policy.mts';

export {
  countGovernedFileLines,
  countGovernedLines,
  countLines,
  CURRENT_LINE_COUNT_VERSION,
  decodeLineBaseline,
  effectiveLineCeiling,
  lineBaselineOrExit,
  measureLines,
  normalizeLineBaseline,
} from './size-line-count.mts';
export type {
  DecodedLineBaseline,
  LineCountVersion,
  LineMeasure,
  LinesBaseline,
} from './size-line-count.mts';

interface SnapshotLineBaseline extends DecodedLineBaseline {
  present: boolean;
}

interface LegacyAuthorityCache {
  baselines: Map<Snapshot, SnapshotLineBaseline>;
  ceilings: Map<string, number | null>;
  parents: Map<Snapshot, CommitParents>;
  sources: Map<string, string | null>;
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

function newLegacyAuthorityCache(): LegacyAuthorityCache {
  return {
    baselines: new Map(),
    ceilings: new Map(),
    parents: new Map(),
    sources: new Map(),
  };
}

function rawBaselineAt(
  root: string,
  snapshot: Snapshot,
  cache?: LegacyAuthorityCache,
): SnapshotLineBaseline {
  const cached = cache?.baselines.get(snapshot);
  if (cached) return cached;
  const contents =
    snapshotText(root, snapshot, LINES_BASELINE) ??
    snapshotText(root, snapshot, LEGACY_LINES_BASELINE);
  const baseline = { ...decodeLineBaseline(contents, snapshot), present: contents !== null };
  cache?.baselines.set(snapshot, baseline);
  return baseline;
}

function cachedCommitParentsAt(
  root: string,
  snapshot: Snapshot,
  cache?: LegacyAuthorityCache,
): CommitParents {
  const cached = cache?.parents.get(snapshot);
  if (cached) return cached;
  const parents = commitParentsAt(root, snapshot);
  cache?.parents.set(snapshot, parents);
  return parents;
}

function sourceAt(
  root: string,
  snapshot: Snapshot,
  file: string,
  cache: LegacyAuthorityCache,
): string | null {
  const key = `${snapshot}\0${file}`;
  if (cache.sources.has(key)) return cache.sources.get(key) ?? null;
  const contents = snapshotText(root, snapshot, file);
  cache.sources.set(key, contents);
  return contents;
}

function authoritativeLegacyCeiling(
  root: string,
  snapshot: Snapshot,
  file: string,
  stored: number,
  version: LineCountVersion,
  cache: LegacyAuthorityCache,
): number | null {
  const key = `${snapshot}\0${file}\0${stored}\0${version}`;
  if (cache.ceilings.has(key)) return cache.ceilings.get(key) ?? null;
  const contents = sourceAt(root, snapshot, file, cache);
  // A ceiling cannot remain authoritative across a commit where its source file disappeared.
  if (contents === null) {
    cache.ceilings.set(key, null);
    return null;
  }
  const directCeiling = convertCeiling(stored, contents, file, version);
  const ancestry = cachedCommitParentsAt(root, snapshot, cache);
  if (ancestry.hidden) {
    cache.ceilings.set(key, null);
    return null;
  }
  const legacyParents = ancestry.parents.filter((parent) => {
    const raw = rawBaselineAt(root, parent, cache);
    return (
      !raw.error && raw.present && raw.lineCountVersion === version && raw.files[file] !== undefined
    );
  });
  if (legacyParents.length === 0) {
    cache.ceilings.set(key, directCeiling);
    return directCeiling;
  }
  const inherited = legacyParents.map((parent) => {
    const parentStored = rawBaselineAt(root, parent, cache).files[file] ?? 0;
    const parentCeiling = authoritativeLegacyCeiling(
      root,
      parent,
      file,
      parentStored,
      version,
      cache,
    );
    if (parentCeiling === null) return null;
    if (stored === parentStored) return parentCeiling;
    const deltaBound = Math.max(0, parentCeiling + Math.min(0, stored - parentStored));
    return Math.min(directCeiling, deltaBound);
  });
  const ceiling = inherited.some((value) => value === null)
    ? null
    : Math.min(...inherited.filter((value): value is number => value !== null));
  cache.ceilings.set(key, ceiling);
  return ceiling;
}

export function normalizeLineBaselineAtRef(
  root: string,
  snapshot: Snapshot,
  baseline: DecodedLineBaseline,
  cache = newLegacyAuthorityCache(),
): DecodedLineBaseline {
  if (baseline.lineCountVersion === CURRENT_LINE_COUNT_VERSION) return baseline;
  const files: Record<string, number> = {};
  for (const [file, stored] of Object.entries(baseline.files)) {
    const ceiling = authoritativeLegacyCeiling(
      root,
      snapshot,
      file,
      stored,
      baseline.lineCountVersion,
      cache,
    );
    if (ceiling !== null) files[file] = ceiling;
  }
  return { ...baseline, files, lineCountVersion: CURRENT_LINE_COUNT_VERSION };
}

function baselineAt(
  root: string,
  snapshot: Snapshot,
  cache = newLegacyAuthorityCache(),
): SnapshotLineBaseline {
  const raw = rawBaselineAt(root, snapshot, cache);
  return {
    ...normalizeLineBaselineAtRef(root, snapshot, raw, cache),
    present: raw.present,
  };
}

/** Normalize a candidate legacy entry against its producer, taking the strictest inherited
 * governed-line ceiling when multiple merge parents could have supplied it. */
export function normalizeCandidateLineBaseline(
  root: string,
  baseline: DecodedLineBaseline,
  parents: Snapshot[],
  candidateContents: (file: string) => string | null,
  cache = newLegacyAuthorityCache(),
): DecodedLineBaseline {
  const parentBaselines = parents.map((parent) => ({
    parent,
    raw: rawBaselineAt(root, parent, cache),
  }));
  const files: Record<string, number> = {};
  for (const [file, stored] of Object.entries(baseline.files)) {
    if (baseline.lineCountVersion === CURRENT_LINE_COUNT_VERSION) {
      const legacyParents = parentBaselines.filter(
        ({ raw }) =>
          !raw.error &&
          raw.present &&
          raw.lineCountVersion !== CURRENT_LINE_COUNT_VERSION &&
          raw.files[file] !== undefined,
      );
      if (legacyParents.length === 0) {
        files[file] = stored;
        continue;
      }
      const inherited = legacyParents.map(({ parent, raw }) =>
        authoritativeLegacyCeiling(
          root,
          parent,
          file,
          raw.files[file] ?? 0,
          raw.lineCountVersion,
          cache,
        ),
      );
      if (inherited.some((ceiling) => ceiling === null)) continue;
      files[file] = Math.min(
        stored,
        ...inherited.filter((ceiling): ceiling is number => ceiling !== null),
      );
      continue;
    }
    const contents = candidateContents(file);
    if (contents === null) continue;
    const directCeiling = convertCeiling(stored, contents, file, baseline.lineCountVersion);
    const legacyParents = parentBaselines.filter(
      ({ raw }) =>
        !raw.error &&
        raw.present &&
        raw.lineCountVersion === baseline.lineCountVersion &&
        raw.lineCountVersion !== CURRENT_LINE_COUNT_VERSION &&
        raw.files[file] !== undefined,
    );
    if (legacyParents.length === 0) continue;
    const inherited = legacyParents.map(({ parent, raw }) => {
      const parentStored = raw.files[file] ?? 0;
      const parentCeiling = authoritativeLegacyCeiling(
        root,
        parent,
        file,
        parentStored,
        raw.lineCountVersion,
        cache,
      );
      if (parentCeiling === null) return null;
      if (stored === parentStored) return parentCeiling;
      const deltaBound = Math.max(0, parentCeiling + Math.min(0, stored - parentStored));
      return Math.min(directCeiling, deltaBound);
    });
    if (inherited.some((ceiling) => ceiling === null)) continue;
    const differentVersionParents = parentBaselines.filter(
      ({ raw }) =>
        !raw.error &&
        raw.present &&
        raw.lineCountVersion !== baseline.lineCountVersion &&
        raw.files[file] !== undefined,
    );
    const differentVersionCeilings = differentVersionParents.map(
      ({ parent, raw }) => normalizeLineBaselineAtRef(root, parent, raw, cache).files[file],
    );
    if (differentVersionCeilings.some((ceiling) => ceiling === undefined)) continue;
    files[file] = Math.min(
      ...inherited.filter((ceiling): ceiling is number => ceiling !== null),
      ...differentVersionCeilings.filter((ceiling): ceiling is number => ceiling !== undefined),
    );
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
  const baseline = readRatchetBaseline(root, LINES_BASELINE, LEGACY_LINES_BASELINE);
  const decoded = lineBaselineOrExit(
    baseline?.contents ?? null,
    baseline?.relativePath ?? LINES_BASELINE,
  );
  return normalizeCandidateLineBaseline(root, decoded, parents, (file) => workingText(root, file));
}

function sourceLines(root: string, snapshot: Snapshot, file: string): number | null {
  const contents = snapshotText(root, snapshot, file);
  return contents === null ? null : countGovernedFileLines(contents, file);
}

export function lineCountsAtRef(
  root: string,
  snapshot: Snapshot,
  files: Iterable<string>,
  cfg: GuardConfig,
): LineCount[] {
  const counts: LineCount[] = [];
  for (const file of files) {
    if (!governedSourceFile(file, cfg)) continue;
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
  const authorityCache = newLegacyAuthorityCache();
  const priorResults = parents.map((parent) => baselineAt(root, parent, authorityCache));
  if (priorResults.some((baseline) => baseline.error)) return [];
  const prior = priorResults;
  const current = normalizeCandidateLineBaseline(
    root,
    rawBaselineAt(root, candidate, authorityCache),
    parents,
    (file) => snapshotText(root, candidate, file),
    authorityCache,
  );
  if (current.error) throw new LineAuthorityError(current.error);
  const match = sourceMatchers(cfg.sourceExtensions);
  const cap = (file: string) => (match.isTest(file) ? cfg.maxTestLines : cfg.maxLines);
  const files = new Set(prior.flatMap((baseline) => Object.keys(baseline.files)));
  const changes: LineCeilingChange[] = [];

  for (const file of files) {
    if (!governedSourceFile(file, cfg)) continue;
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
  return { files, lineCountVersion: CURRENT_LINE_COUNT_VERSION, tightened };
}
