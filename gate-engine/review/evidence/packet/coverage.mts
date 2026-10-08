// sc-2305: what each judge's capped packet actually showed, measured per TASK diff (a chunk's packet
// is its chunk diff); ruling: gate-opt-out-is-visible-and-detectable's 2026-09-28 note.
import { measureDiffCoverage } from '../../diff-evidence.mts';

/** Coverage fields for a verdict row. Empty when every file was shown whole — JSON drops nothing,
 * and an absent field keeps meaning "complete, or not measured" for every older reader. */
export interface CoverageFields {
  evidence_file_count?: number;
  evidence_omitted_files?: number;
  evidence_truncated_files?: number;
  evidence_omitted_paths?: string[];
  /** Files the judge saw only up to the per-file cap — they read as reviewed but were not whole. */
  evidence_truncated_paths?: string[];
  /** The lens group whose packet was the incomplete one, when the reviewer fanned out. */
  evidence_lens?: string;
}

/** The slice of a ReviewTask coverage needs — structural, so lens parts and cached parts both fit. */
export interface CoverageTask {
  diffText: string;
  group?: string;
  chunk?: { index: number };
}

type Measured = ReturnType<typeof measureDiffCoverage> & { lens?: string };

const gap = (m: Measured): number => m.omitted_files + m.truncated_files;

// gate-events relies on sub-4KB single appends staying atomic under concurrent judges, so the
// path list is bounded in count AND bytes; evidence_omitted_files keeps the exact count.
const PATHS_MAX = 10;
const PATHS_BYTES = 1_000;

function boundedPaths(paths: readonly string[], budget = PATHS_BYTES): string[] {
  const kept: string[] = [];
  let bytes = 0;
  for (const p of paths.slice(0, PATHS_MAX)) {
    bytes += Buffer.byteLength(p, 'utf8');
    if (bytes > budget) break;
    kept.push(p);
  }
  return kept;
}

const pathBytes = (paths: readonly string[]): number =>
  paths.reduce((n, p) => n + Buffer.byteLength(p, 'utf8'), 0);

/** One reviewer's WORST packet: chunk parts partition files so their counts sum; whole-diff parts
 * are measured once per distinct diff, and a lens is named only beside a chunk plan. */
export function coverageFields(tasks: readonly CoverageTask[]): CoverageFields {
  const candidates: Measured[] = [];
  // Every local lens group judges each chunk, so a chunk counts once, however many lenses read it.
  const chunks = [
    ...new Map(tasks.filter((t) => t.chunk).map((t) => [t.chunk?.index, t])).values(),
  ];
  if (chunks.length > 0) {
    const sum: Measured = {
      file_count: 0,
      omitted_files: 0,
      truncated_files: 0,
      omitted_paths: [],
      truncated_paths: [],
    };
    for (const t of chunks) {
      const m = measureDiffCoverage(t.diffText);
      sum.file_count += m.file_count;
      sum.omitted_files += m.omitted_files;
      sum.truncated_files += m.truncated_files;
      sum.omitted_paths.push(...m.omitted_paths);
      sum.truncated_paths.push(...m.truncated_paths);
    }
    candidates.push(sum);
  }
  const wholeDiffs = new Map<string, string | undefined>();
  for (const t of tasks)
    if (!t.chunk && !wholeDiffs.has(t.diffText)) wholeDiffs.set(t.diffText, t.group);
  for (const [diff, group] of wholeDiffs)
    // A lens name only disambiguates when chunk parts sit beside it; otherwise every whole-diff
    // part saw the same packet and naming one of them would single it out falsely.
    candidates.push({ ...measureDiffCoverage(diff), lens: chunks.length > 0 ? group : undefined });
  // On a tie a named lens wins, so an incomplete whole-diff lens is never hidden behind the chunks.
  const worst = candidates.reduce<Measured | undefined>(
    (w, c) => (!w || gap(c) > gap(w) || (gap(c) === gap(w) && c.lens && !w.lens) ? c : w),
    undefined,
  );
  if (!worst || gap(worst) === 0) return {};
  // Both lists share one byte budget; truncated paths claim it first.
  const truncatedPaths = boundedPaths(worst.truncated_paths);
  const fields: CoverageFields = {
    evidence_file_count: worst.file_count,
    evidence_omitted_files: worst.omitted_files,
    evidence_truncated_files: worst.truncated_files,
    evidence_omitted_paths: boundedPaths(
      worst.omitted_paths,
      PATHS_BYTES - pathBytes(truncatedPaths),
    ),
  };
  if (truncatedPaths.length > 0) fields.evidence_truncated_paths = truncatedPaths;
  if (worst.lens) fields.evidence_lens = worst.lens;
  return fields;
}

/** The completion-line suffix for a PASS over a partial packet; '' when coverage was complete. */
export function partialEvidenceNote(c: CoverageFields): string {
  if (!c.evidence_omitted_files && !c.evidence_truncated_files) return '';
  const lens = c.evidence_lens ? ` (${c.evidence_lens} lens)` : '';
  return ` — partial evidence${lens}: ${c.evidence_omitted_files ?? 0}/${c.evidence_file_count ?? '?'} file(s) omitted, ${c.evidence_truncated_files ?? 0} truncated from the packet${truncatedNames(c)}`;
}

const NAMES_SHOWN = 3;

// JSON quoting escapes C0 controls but leaves C1 (e.g. U+009B, a one-byte CSI) raw.
const quotedPath = (p: string): string =>
  JSON.stringify(p).replace(
    /[\u0080-\u009f]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );

// Quoted so a committer-controlled path cannot split or forge the one-line gate log.
function truncatedNames(c: CoverageFields): string {
  const paths = c.evidence_truncated_paths ?? [];
  if (paths.length === 0) return '';
  const more = (c.evidence_truncated_files ?? 0) > NAMES_SHOWN ? ', …' : '';
  return ` — truncated: ${paths.slice(0, NAMES_SHOWN).map(quotedPath).join(', ')}${more}`;
}
