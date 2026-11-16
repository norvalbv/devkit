/** A labels.json bench entry (engine-shipped fixture — external data). */
export interface Label {
  a: string;
  b: string;
  label: string;
  note: string;
}

/** Order-insensitive key for a symbol pair. */
export function symKey(a: string, b: string) {
  return a < b ? `${a} ${b}` : `${b} ${a}`;
}

// Reason: the branches ARE the confusion-matrix algorithm: the TP/FP/FN/TN four-way classification plus precision/recall/F1 derivation over labels.json; CRAP-flagged because this is dev-only bench tooling exercised end-to-end against fixtures, not unit-tested
// fallow-ignore-next-line complexity
export function scoreLabels(labels: Label[], flagged: Set<string>, knobs: string): string[] {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  const misses = [];
  const falseAlarms = [];
  for (const l of labels) {
    const predicted = flagged.has(symKey(l.a, l.b));
    const actual = l.label === 'dup';
    if (predicted && actual) tp++;
    else if (predicted && !actual) {
      fp++;
      falseAlarms.push(`${l.a} <> ${l.b}  (${l.note})`);
    } else if (!predicted && actual) {
      fn++;
      misses.push(`${l.a} <> ${l.b}  (${l.note})`);
    } else tn++;
  }
  const prec = tp + fp ? tp / (tp + fp) : 1;
  const rec = tp + fn ? tp / (tp + fn) : 1;
  const f1 = prec + rec ? (2 * prec * rec) / (prec + rec) : 0;

  const out = [
    `Knobs: ${knobs}`,
    `Labeled pairs: ${labels.length}  (dup ${labels.filter((l) => l.label === 'dup').length} | noise ${labels.filter((l) => l.label === 'noise').length})`,
    `Confusion: TP ${tp}  FP ${fp}  FN ${fn}  TN ${tn}`,
    `Precision ${(prec * 100).toFixed(1)}%  Recall ${(rec * 100).toFixed(1)}%  F1 ${(f1 * 100).toFixed(1)}%`,
  ];
  if (misses.length) out.push(`\nMissed dups (FN):\n  ${misses.join('\n  ')}`);
  if (falseAlarms.length) out.push(`\nFalse alarms (FP):\n  ${falseAlarms.join('\n  ')}`);
  return out;
}
