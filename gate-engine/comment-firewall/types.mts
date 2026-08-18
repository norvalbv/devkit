export interface CommentFinding {
  id: string;
  path: string;
  extension: string;
  adapterVersion: string;
  kind: 'line' | 'block';
  startLine: number;
  endLine: number;
  comment: string;
  context: string;
  relevantDiff: string;
}

export interface DetectionResult {
  findings: CommentFinding[];
  unsupported: Array<{ extension: string; path: string }>;
}

/** Explicit evidence supplied by the author. It is pending until the judge returns PASS. */
export interface CommentRationale {
  rationale: string;
  ticket?: string;
  at: string;
}

export interface RationaleStore {
  version: 1;
  entries: Record<string, CommentRationale>;
}

export interface CommentJudgeResult {
  verdict: 'PASS' | 'FAIL';
  reason: string;
}
