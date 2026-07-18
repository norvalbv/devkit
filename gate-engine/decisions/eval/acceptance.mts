export const DECISIONS_ACCEPTANCE = {
  runs: {
    detect: 3,
    alignment: 1,
    depth: 3,
  },
  floors: {
    decisionRecall: 0.75,
    contradictionPrecision: 0.75,
    depthAccuracy: 0.75,
  },
} as const;

interface AlignmentSummary<T> {
  cascade?: boolean;
  firstPass?: { contradict?: T };
  final?: { contradict?: T };
}

export function selectAlignmentContradiction<T>(summary: AlignmentSummary<T>): T | undefined {
  return summary.cascade ? summary.final?.contradict : summary.firstPass?.contradict;
}
