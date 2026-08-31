import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sourceMatchers } from '../config.mts';
import {
  LEGACY_LINES_BASELINE,
  readRatchetBaseline,
  removeRatchetBaseline,
  writeRatchetBaseline,
} from './baseline-paths.mts';
import { LINES_BASELINE } from './size-policy.mts';
import {
  CURRENT_LINE_COUNT_VERSION,
  lineBaselineParents,
  lineBaselineOrExit,
  normalizeCandidateLineBaseline,
} from './size-line-authority.mts';

export type LinesFreezeMode = 'shrink-only' | 'refresh';

interface LinesConfig {
  maxLines: number;
  maxTestLines: number;
  sourceExtensions: string[];
}

interface OversizedFile {
  file: string;
  lines: number;
}

export function freezeLinesBaseline(
  root: string,
  config: LinesConfig,
  oversized: OversizedFile[],
  mode: LinesFreezeMode,
): number {
  const baseline = readRatchetBaseline(root, LINES_BASELINE, LEGACY_LINES_BASELINE);
  const decodedPrevious = lineBaselineOrExit(
    baseline?.contents ?? null,
    baseline?.relativePath ?? LINES_BASELINE,
    'guard-size freeze unavailable',
  );
  const previous = normalizeCandidateLineBaseline(
    root,
    decodedPrevious,
    lineBaselineParents(root),
    (file) => {
      try {
        return readFileSync(join(root, file), 'utf8');
      } catch {
        return null;
      }
    },
  );
  const match = sourceMatchers(config.sourceExtensions);
  const cap = (file: string) => (match.isTest(file) ? config.maxTestLines : config.maxLines);
  const previousCeiling = (file: OversizedFile) => previous.files[file.file];
  const unverifiableLegacy = (file: OversizedFile) =>
    decodedPrevious.lineCountVersion === 1 &&
    decodedPrevious.files[file.file] !== undefined &&
    previousCeiling(file) === undefined;
  const raised =
    mode === 'refresh'
      ? oversized.filter(
          (file) => file.lines > Math.max(cap(file.file), previousCeiling(file) ?? 0),
        )
      : [];
  const files = Object.fromEntries(
    oversized.flatMap((file) => {
      if (mode === 'shrink-only' && unverifiableLegacy(file)) return [];
      return [
        [
          file.file,
          mode === 'refresh'
            ? file.lines
            : Math.min(previousCeiling(file) ?? file.lines, file.lines),
        ],
      ];
    }),
  );
  if (Object.keys(files).length > 0) {
    writeRatchetBaseline(
      root,
      LINES_BASELINE,
      LEGACY_LINES_BASELINE,
      `${JSON.stringify(
        {
          lineCountVersion: CURRENT_LINE_COUNT_VERSION,
          maxLines: config.maxLines,
          maxTestLines: config.maxTestLines,
          files,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    removeRatchetBaseline(root, LINES_BASELINE, LEGACY_LINES_BASELINE);
  }
  if (raised.length > 0) {
    console.log(`  ⚠ ${raised.length} file(s) grew since the last freeze:`);
    for (const file of raised) {
      console.log(
        `     ${file.file}: ${Math.max(cap(file.file), previousCeiling(file) ?? 0)} → ${file.lines}`,
      );
    }
  }
  return oversized.length;
}
