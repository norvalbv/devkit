import { extname } from 'node:path';
import { scanCommentTokens, supportsCommentScan } from '../comment-firewall/detect.mts';

export type LineCountVersion = 1 | 2 | 3;

export interface LinesBaseline {
  files: Record<string, number>;
  lineCountVersion: LineCountVersion;
}

export interface DecodedLineBaseline extends LinesBaseline {
  error: string | null;
}

export interface LineMeasure {
  legacyLines: number;
  lines: number;
}

export const CURRENT_LINE_COUNT_VERSION = 3;

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

interface PhysicalLine {
  start: number;
  end: number;
}

function physicalLines(source: string): PhysicalLine[] {
  if (source.length === 0) return [];
  const lines: PhysicalLine[] = [];
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (code !== 10 && code !== 13 && code !== 0x2028 && code !== 0x2029) continue;
    lines.push({ start, end: index });
    if (code === 13 && source.charCodeAt(index + 1) === 10) index += 1;
    start = index + 1;
  }
  if (start < source.length) lines.push({ start, end: source.length });
  return lines;
}

/** Count physical lines, excluding only lines whose entire residue is lexer-recognized comments. */
export function countGovernedLines(source: string, extension: string): number {
  const lines = physicalLines(source);
  if (!supportsCommentScan(extension)) return lines.length;
  const comments = scanCommentTokens(source, extension);
  let count = 0;
  let firstPossibleComment = 0;
  for (const line of lines) {
    while (
      firstPossibleComment < comments.length &&
      (comments[firstPossibleComment]?.endOffset ?? 0) <= line.start
    ) {
      firstPossibleComment += 1;
    }
    let cursor = line.start;
    let hasComment = false;
    let residue = '';
    for (let index = firstPossibleComment; index < comments.length; index += 1) {
      const comment = comments[index];
      if (!comment) break;
      if (comment.startOffset >= line.end && line.start !== line.end) break;
      if (line.start === line.end && comment.startOffset >= line.start) break;
      const overlaps =
        (comment.startOffset < line.end && comment.endOffset > line.start) ||
        (line.start === line.end &&
          comment.startOffset < line.start &&
          comment.endOffset > line.start);
      if (!overlaps) continue;
      const commentStart = Math.max(line.start, comment.startOffset);
      const commentEnd = Math.min(line.end, comment.endOffset);
      residue += source.slice(cursor, commentStart);
      cursor = Math.max(cursor, commentEnd);
      hasComment = true;
    }
    residue += source.slice(cursor, line.end);
    if (!hasComment || residue.trim().length > 0) count += 1;
  }
  return count;
}

export function countGovernedFileLines(source: string, file: string): number {
  return countGovernedLines(source, extname(file).slice(1).toLowerCase());
}

export function effectiveLineCeiling(baseline: LinesBaseline, file: string, cap: number): number {
  return Math.max(cap, baseline.files[file] ?? 0);
}

function countVersionedLines(contents: string, file: string, version: LineCountVersion): number {
  if (version === 1) return measureLines(contents).legacyLines;
  if (version === 2) return measureLines(contents).lines;
  return countGovernedFileLines(contents, file);
}

export function convertCeiling(
  stored: number,
  contents: string,
  file: string,
  version: LineCountVersion,
): number {
  const oldLines = countVersionedLines(contents, file, version);
  const governedLines = countGovernedFileLines(contents, file);
  return Math.max(0, stored - (oldLines - governedLines));
}

/** Convert an older line metric once, using the immutable source bytes that produced it. */
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
    files[file] = convertCeiling(stored, contents, file, baseline.lineCountVersion);
  }
  return { ...baseline, files, lineCountVersion: CURRENT_LINE_COUNT_VERSION };
}

class LineBaselineError extends Error {}

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
    throw new LineBaselineError(`guard-size: invalid line baseline JSON in ${label}`);
  }
  const lineCountVersion = parsed?.lineCountVersion ?? 1;
  if (lineCountVersion !== 1 && lineCountVersion !== 2 && lineCountVersion !== 3) {
    throw new LineBaselineError(
      `guard-size: unsupported line count version ${lineCountVersion} in ${label}`,
    );
  }
  const files = parsed?.files ?? {};
  if (!files || Object(files) !== files || Array.isArray(files)) {
    throw new LineBaselineError(`guard-size: invalid line baseline files map in ${label}`);
  }
  const decoded: Record<string, number> = {};
  for (const [file, ceiling] of Object.entries(files)) {
    if (!Number.isFinite(ceiling) || ceiling < 0) {
      throw new LineBaselineError(`guard-size: invalid line ceiling for ${file} in ${label}`);
    }
    decoded[file] = ceiling;
  }
  return { files: decoded, lineCountVersion };
}

export function decodeLineBaseline(contents: string | null, label: string): DecodedLineBaseline {
  try {
    return { ...parseBaseline(contents, label), error: null };
  } catch (error) {
    if (!(error instanceof LineBaselineError)) throw error;
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
