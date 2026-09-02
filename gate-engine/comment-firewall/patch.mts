/** Unified-diff hunk parsing for the staged comment detector. */
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

export interface DeletedLine {
  oldLine: number;
  /** New-side line numbers of the nearest surviving old-side neighbours, above and below. */
  neighbours: number[];
}

export interface PatchHunk {
  newStart: number;
  newCount: number;
  addedLines: Set<number>;
  deleted: DeletedLine[];
  text: string;
}

interface HunkLine {
  kind: '+' | '-' | ' ';
  newLine: number;
  oldLine: number;
}

function survivingNeighbour(lines: HunkLine[], from: number, step: 1 | -1): number | null {
  for (let index = from + step; index >= 0 && index < lines.length; index += step) {
    const line = lines[index];
    if (!line || line.kind === '+') continue;
    return line.kind === ' ' ? line.newLine : null;
  }
  return null;
}

function deletedLines(lines: HunkLine[]): DeletedLine[] {
  const deleted: DeletedLine[] = [];
  lines.forEach((line, index) => {
    if (line.kind !== '-') return;
    const neighbours = [
      survivingNeighbour(lines, index, -1),
      survivingNeighbour(lines, index, 1),
    ].filter((value): value is number => value !== null);
    deleted.push({ oldLine: line.oldLine, neighbours });
  });
  return deleted;
}

export function parsePatchHunks(diff: string): PatchHunk[] {
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | null = null;
  let lines: HunkLine[] = [];
  let newLine = 0;
  let oldLine = 0;
  const flush = (): void => {
    if (current) current.deleted = deletedLines(lines);
    lines = [];
  };
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      flush();
      current = null;
      continue;
    }
    const header = raw.match(HUNK_HEADER);
    if (header) {
      flush();
      current = {
        newStart: Number(header[2]),
        newCount: header[3] === undefined ? 1 : Number(header[3]),
        addedLines: new Set(),
        deleted: [],
        text: raw,
      };
      oldLine = Number(header[1]);
      newLine = current.newStart;
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    current.text += `\n${raw}`;
    /* File headers precede hunks; within a hunk `+++value` is source beginning with `++`. */
    if (raw.startsWith('+')) {
      current.addedLines.add(newLine);
      lines.push({ kind: '+', newLine, oldLine });
      newLine += 1;
    } else if (raw.startsWith('-')) {
      lines.push({ kind: '-', newLine, oldLine });
      oldLine += 1;
    } else if (!raw.startsWith('\\')) {
      lines.push({ kind: ' ', newLine, oldLine });
      newLine += 1;
      oldLine += 1;
    }
  }
  flush();
  return hunks;
}

/** New-side lines that a deleted COMMENT line (per the old file's lexer view) was contiguous with. */
export function commentTouchLines(
  hunks: PatchHunk[],
  oldCommentLines: ReadonlySet<number>,
): Set<number> {
  const touched = new Set<number>();
  for (const hunk of hunks) {
    for (const line of hunk.deleted) {
      if (!oldCommentLines.has(line.oldLine)) continue;
      for (const neighbour of line.neighbours) touched.add(neighbour);
    }
  }
  return touched;
}
