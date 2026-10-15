/** Lens findings -> ReviewBench judging input. Location = first staged `file:line` mention (its judge
 * matches per file); findings without one are withheld and counted, never matched. */
import { extractLocations, extractRanges, resolveToStaged } from '../../scale/labels.mts';
import type { CheckpointRow } from '../../scale/lens-run.mts';

export interface ReviewBenchPr {
  repo: string;
  pr_number: number;
  base: string;
  head: string;
}

export interface ReviewBenchFinding {
  producer: string;
  file: string;
  start_line: number;
  end_line: number;
  message: string;
}

export interface ReviewBenchFile {
  pr: ReviewBenchPr;
  agent: string;
  findings: ReviewBenchFinding[];
  usage: { time_in_ms: number };
}

export interface ReviewBenchExport {
  /** null when no lens task reached a terminal verdict. */
  file: ReviewBenchFile | null;
  /** Issues withheld from the judge: no staged file named, or a file but no line. */
  withheldNoFile: number;
  withheldFileNoLine: number;
  /** What the strict `file:N` grammar (no `~`) would have withheld as file-no-line. */
  withheldFileNoLineStrict: number;
  /** Issues naming two or more staged files: cross-file claims a same-file matcher cannot credit. */
  crossFile: number;
  terminalTasks: number;
  tasks: number;
}

export function exportReviewBench(o: {
  pr: ReviewBenchPr;
  agent: string;
  staged: readonly string[];
  rows: readonly CheckpointRow[];
}): ReviewBenchExport {
  const terminal = o.rows.filter((x) => x.status === 'pass' || x.status === 'fail');
  const findings: ReviewBenchFinding[] = [];
  let withheldNoFile = 0;
  let withheldFileNoLine = 0;
  let withheldFileNoLineStrict = 0;
  let crossFile = 0;
  for (const row of terminal)
    for (const issue of [...row.issues, ...(row.advisories ?? [])]) {
      const locs = extractRanges(issue.text).map((l) => ({
        file: resolveToStaged(l.file, o.staged),
        line: l.line,
        endLine: l.endLine,
      }));
      const strict = extractLocations(issue.text).map((l) => ({
        file: resolveToStaged(l.file, o.staged),
        line: l.line,
      }));
      if (strict.some((l) => l.file) && !strict.some((l) => l.file && l.line !== null))
        withheldFileNoLineStrict += 1;
      if (new Set(locs.map((l) => l.file).filter(Boolean)).size >= 2) crossFile += 1;
      const loc = locs.find((l) => l.file !== undefined && l.line !== null);
      if (!loc?.file || loc.line === null) {
        if (locs.some((l) => l.file !== undefined)) withheldFileNoLine += 1;
        else withheldNoFile += 1;
        continue;
      }
      findings.push({
        producer: o.agent,
        file: loc.file,
        start_line: loc.line,
        end_line: loc.endLine ?? loc.line,
        message: `[${issue.lens}] ${issue.text}`,
      });
    }
  return {
    file:
      terminal.length === 0
        ? null
        : {
            pr: o.pr,
            agent: o.agent,
            findings,
            usage: { time_in_ms: terminal.reduce((a, x) => a + x.ms, 0) },
          },
    withheldNoFile,
    withheldFileNoLine,
    withheldFileNoLineStrict,
    crossFile,
    terminalTasks: terminal.length,
    tasks: o.rows.length,
  };
}
