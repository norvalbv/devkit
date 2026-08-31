import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveGuardConfig, sourceMatchers } from '../config.mts';
import { LEGACY_LINES_BASELINE, readRatchetBaseline } from './baseline-paths.mts';
import { stagedSet, treeTextAtRef } from './git-index.mts';
import {
  countGovernedFileLines,
  decodeLineBaseline,
  type DecodedLineBaseline,
  effectiveLineCeiling,
  normalizeCandidateLineBaseline,
  normalizeLineBaselineAtRef,
} from './size-line-authority.mts';
import { governedSourceFile, LINES_BASELINE } from './size-policy.mts';

interface LinesPreflightRow {
  file: string;
  lines: number;
  ceiling: number;
  headroom: number;
  localCeiling: number;
}

interface RefLinesBaseline {
  baseline: DecodedLineBaseline | null;
  snapshot: string;
}

function readLinesBaseline(contents: string | null, label: string): DecodedLineBaseline {
  const decoded = decodeLineBaseline(contents, label);
  if (decoded.error) throw new Error(decoded.error);
  return decoded;
}

function readLinesBaselineAtRef(root: string, ref: string): RefLinesBaseline {
  const snapshot = execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  const text =
    treeTextAtRef(root, snapshot, LINES_BASELINE) ??
    treeTextAtRef(root, snapshot, LEGACY_LINES_BASELINE);
  return {
    baseline:
      text === null
        ? null
        : normalizeLineBaselineAtRef(root, snapshot, readLinesBaseline(text, snapshot)),
    snapshot,
  };
}

function workingText(root: string, file: string): string | null {
  try {
    return readFileSync(join(root, file), 'utf8');
  } catch {
    return null;
  }
}

function sourcePaths(
  root: string,
  cfg: ReturnType<typeof resolveGuardConfig>,
  selected: string[],
): string[] {
  return selected.filter((file) => existsSync(join(root, file)) && governedSourceFile(file, cfg));
}

// Compare the caller's current bytes with the raw-line baseline from the exact ref a ship will use.
// A missing ref baseline is an overlay/untracked baseline, which ship links from the working copy.
export function preflightLines(root: string, ref: string, requested: string[] = []): number {
  let cfg: ReturnType<typeof resolveGuardConfig>;
  let local: DecodedLineBaseline;
  try {
    cfg = resolveGuardConfig(root);
    if (!cfg.maxLines && !cfg.maxTestLines) return 0;
    const localBaseline = readRatchetBaseline(root, LINES_BASELINE, LEGACY_LINES_BASELINE);
    local = readLinesBaseline(
      localBaseline?.contents ?? null,
      localBaseline?.relativePath ?? LINES_BASELINE,
    );
  } catch (error) {
    console.error(`guard-size preflight unavailable: ${String(error)}`);
    return 2;
  }
  let committed: DecodedLineBaseline | null;
  let baseSnapshot: string;
  try {
    const resolved = readLinesBaselineAtRef(root, ref);
    committed = resolved.baseline;
    baseSnapshot = resolved.snapshot;
  } catch (error) {
    console.error(`guard-size preflight unavailable at ${ref}: ${String(error)}`);
    return 2;
  }
  local = normalizeCandidateLineBaseline(root, local, [baseSnapshot], (file) =>
    workingText(root, file),
  );
  const match = sourceMatchers(cfg.sourceExtensions);
  const cap = (file: string) => (match.isTest(file) ? cfg.maxTestLines : cfg.maxLines);
  const selected = requested.length > 0 ? requested : [...(stagedSet(root) ?? [])];
  const baselineIncluded = selected.some(
    (file) => file === LINES_BASELINE || file === LEGACY_LINES_BASELINE,
  );
  const files = sourcePaths(root, cfg, selected).filter((file) => cap(file) > 0);
  if (files.length === 0) {
    if (requested.length === 0) {
      console.error('guard-size preflight: no staged source files (pass paths after `--`).');
      return 2;
    }
    console.log(`guard-size preflight: no source files in scope: ${requested.join(', ')}`);
    return 0;
  }

  const usesWorkingBaseline = baselineIncluded || !committed;
  const baseline: DecodedLineBaseline = usesWorkingBaseline ? local : (committed ?? local);
  const baselineLabel = usesWorkingBaseline ? 'working tree' : ref;
  let rows: LinesPreflightRow[];
  try {
    rows = files.map((file) => {
      const lines = countGovernedFileLines(readFileSync(join(root, file), 'utf8'), file);
      const ceiling = effectiveLineCeiling(baseline, file, cap(file));
      const localCeiling = effectiveLineCeiling(local, file, cap(file));
      return {
        file,
        lines,
        ceiling,
        headroom: ceiling - lines,
        localCeiling,
      };
    });
  } catch (error) {
    console.error(`guard-size preflight unavailable while reading source files: ${String(error)}`);
    return 2;
  }

  console.log(`guard-size preflight — effective ceilings from ${baselineLabel}`);
  for (const row of rows) {
    const drift =
      committed && row.localCeiling !== row.ceiling
        ? `; working-tree max ${row.localCeiling} differs by ${row.localCeiling - row.ceiling}`
        : '';
    console.log(
      `   ${row.file}: ${row.lines} lines; max ${row.ceiling}; headroom ${row.headroom}${drift}`,
    );
  }

  const grew = rows.filter((row) => row.headroom < 0);
  if (grew.length === 0) return 0;
  console.error(`🚫 ${grew.length} file(s) exceed the line limit from ${baselineLabel}:`);
  for (const row of grew) {
    const drift =
      committed && row.localCeiling !== row.ceiling
        ? `; working-tree baseline would allow ${row.localCeiling}`
        : '';
    console.error(`   ${row.file}: ${row.lines} lines (max ${row.ceiling}${drift})`);
  }
  return 1;
}

export function runPreflightCli(args: string[]): never {
  if (args[0] !== '--base' || !args[1] || (args.length > 2 && args[2] !== '--')) {
    console.error('usage: guard-size preflight --base <ref> [-- path...]');
    process.exit(2);
  }
  process.exit(preflightLines(process.cwd(), args[1], args.slice(3)));
}
