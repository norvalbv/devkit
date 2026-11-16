/** A line locator in a jscpd clone: either a bare line number or a `{ line }` object. */
type CloneLineLoc = number | { line: number };

/** A normalised clone pair (cross-file by default; same-file when requested). */
export interface Clone {
  fragmentHash: string;
  /** jscpd's kind: `exact` token clone, or `similar` (same-structure functions, `similarity` score). */
  kind: string;
  similarity?: number;
  lines: number;
  tokens: number;
  fileA: string;
  startA: CloneLineLoc;
  endA: CloneLineLoc;
  fileB: string;
  startB: CloneLineLoc;
  endB: CloneLineLoc;
  fragment: string;
}

// The pieces of jscpd's JSON report we read (external-data shape).
interface JscpdFileEntry {
  name: string;
  start: number;
  end: number;
  startLoc?: { line: number };
  endLoc?: { line: number };
}
interface JscpdDuplicate {
  fragment?: string;
  kind: string;
  similarity?: number;
  isNew?: boolean;
  lines: number;
  tokens: number;
  firstFile: JscpdFileEntry;
  secondFile: JscpdFileEntry;
}
export interface JscpdReport {
  duplicates?: JscpdDuplicate[];
}
