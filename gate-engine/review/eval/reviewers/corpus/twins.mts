// @ts-nocheck — BENCH-ONLY (excluded from tsc, see tsconfig.json exclude); loose types deliberate.

/** Near-twin detection over corpus fixtures (sc-2495): 5-shingle Jaccard on normalized base+staged text.
 * Dependency-free on purpose — a bench helper must not add a runtime dep to a consumer-installed package. */

const SHINGLE = 5;

function fixtureText(row) {
  // base and staged are separate namespaces: the same path appears in both with different content.
  const files = {};
  for (const [side, tree] of [
    ['base', row.repo?.base ?? {}],
    ['staged', row.repo?.staged ?? {}],
  ])
    for (const [k, v] of Object.entries(tree)) files[`${side}:${k}`] = v;
  return Object.keys(files)
    .sort()
    .map((k) => `${k}\n${files[k]}`)
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

export function shingles(text, k = SHINGLE) {
  const words = text.split(' ');
  const out = new Set();
  for (let i = 0; i + k <= words.length; i += 1) out.add(words.slice(i, i + k).join(' '));
  return out;
}

export function jaccard(a, b) {
  // Two fixtures too small to shingle share no evidence of similarity — 0, never 1.
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const s of a) if (b.has(s)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** Row pairs at ≥ `threshold` similarity; `related` marks an INTENDED minimal pair (shared caseId or a
 * variantOf link) so leakage is distinguishable from the corpus's own growth mechanism. */
export function nearTwins(rows, { threshold = 0.5 } = {}) {
  // `related` is the SAME transitive pair-group relation admission and holdout use — never a
  // direct-link check, which would read A~C as unrelated when A links to C only through B.
  const keyOf = pairGroups(rows);
  const sh = rows.map((r) => ({ row: r, s: shingles(fixtureText(r)) }));
  const out = [];
  for (let i = 0; i < sh.length; i += 1)
    for (let j = i + 1; j < sh.length; j += 1) {
      const sim = jaccard(sh[i].s, sh[j].s);
      if (sim < threshold) continue;
      const a = sh[i].row;
      const b = sh[j].row;
      const related = keyOf.get(a.id) === keyOf.get(b.id);
      out.push({
        a: a.id,
        b: b.id,
        similarity: Number(sim.toFixed(3)),
        related,
        oppositeLabel: a.expected !== b.expected,
        straddlesHoldout: !!a.holdout !== !!b.holdout,
      });
    }
  return out.sort((x, y) => y.similarity - x.similarity);
}

/** Pair groups over BOTH links (caseId and variantOf) via union-find; a row with neither is its own
 * group. Returns rowId → groupKey (the smallest id in the group). */
export function pairGroups(rows) {
  const parent = new Map(rows.map((r) => [r.id, r.id]));
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const union = (a, b) => {
    if (!parent.has(a) || !parent.has(b)) return;
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  };
  const byCase = new Map();
  for (const r of rows) {
    if (r.variantOf) union(r.id, r.variantOf);
    if (r.caseId) {
      if (byCase.has(r.caseId)) union(r.id, byCase.get(r.caseId));
      else byCase.set(r.caseId, r.id);
    }
  }
  return new Map(rows.map((r) => [r.id, find(r.id)]));
}

/** Rows bucketed by their pair group (see pairGroups): groupKey → rows. */
export function groupByPair(rows) {
  const keyOf = pairGroups(rows);
  const groups = new Map();
  for (const r of rows) {
    const key = keyOf.get(r.id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return groups;
}

/** The pairs an admission rule must refuse: near-twins that are NOT an intended minimal pair. */
export const unrelatedTwins = (twins) => twins.filter((t) => !t.related);
